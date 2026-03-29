import os
import secrets
from datetime import datetime, timedelta
from collections import defaultdict
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.db_models import ActionType, Run, RunItem, ScanResult, User, UserSetting, UserToolSpec

router = APIRouter()

DISCORD_CLIENT_ID = os.getenv("DISCORD_CLIENT_ID", "").strip()
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET", "").strip()
DISCORD_REDIRECT_URI = os.getenv("DISCORD_REDIRECT_URI", "http://localhost:8000/api/auth/discord/callback").strip()
FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "http://localhost:5173").rstrip("/")
DISCORD_OAUTH_SCOPE = "identify"

STATE_TTL_MINUTES = 10
SESSION_TTL_HOURS = 12
_oauth_states: Dict[str, datetime] = {}
_sessions: Dict[str, Dict[str, Any]] = {}


class UpdateMySettingsBody(BaseModel):
    tool_spec_id: Optional[int] = None


class CreateMyToolSpecBody(BaseModel):
    name: str
    common_reward_bonus: Optional[float] = None
    uncommon_reward_bonus: Optional[float] = None
    rare_reward_bonus: Optional[float] = None
    minigame_reward_bonus: Optional[float] = None
    minigame_chance_bonus: Optional[float] = None
    chest_spawn_bonus: Optional[float] = None


def _session_user_id_or_401(request: Request) -> int:
    _purge_expired()
    session_id = request.cookies.get("session_id")
    if not session_id or session_id not in _sessions:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    user_id = int(_sessions[session_id].get("user_id") or 0)
    if user_id <= 0:
        raise HTTPException(status_code=401, detail="유효하지 않은 세션입니다.")
    return user_id


ITEM_LABELS_FOR_PIE = ("common_item", "uncommon_item", "rare_item")


def _ocr_text_to_int_or_none(ocr_text: Optional[str]) -> Optional[int]:
    if ocr_text is None:
        return None
    t = str(ocr_text).strip()
    if not t.isdigit():
        return None
    return int(t)


def _gauge_int(rp: Dict[str, Any]) -> Optional[int]:
    g = rp.get("gauge")
    if g is None:
        return None
    try:
        return int(g)
    except (TypeError, ValueError):
        return None


def _mini_scan_bucket_pred(rp: Dict[str, Any], want_uncommon: bool) -> bool:
    if rp.get("action_label") != "mini":
        return False
    sl = rp.get("scan_label")
    if want_uncommon:
        return sl == "uncommon"
    return sl == "common" or sl is None


def _build_scan_bucket_by_gauge(
    runs_payload: List[Dict[str, Any]],
    item_rows: List[tuple],
    scan_label: str,
    action_label: str,
) -> Dict[str, Any]:
    """스캔 결과(common/uncommon) + 행동 타입(normal/mini 등) + ``Run.gauge`` 180·360으로 분리."""
    return {
        "gauge_180": _build_dashboard_bucket(
            runs_payload,
            item_rows,
            lambda rp, sl=scan_label, al=action_label: (
                rp.get("scan_label") == sl
                and rp.get("action_label") == al
                and _gauge_int(rp) == 180
            ),
        ),
        "gauge_360": _build_dashboard_bucket(
            runs_payload,
            item_rows,
            lambda rp, sl=scan_label, al=action_label: (
                rp.get("scan_label") == sl
                and rp.get("action_label") == al
                and _gauge_int(rp) == 360
            ),
        ),
    }


def _build_dashboard_bucket(
    runs_payload: List[Dict[str, Any]],
    item_rows: List[tuple],
    predicate: Callable[[Dict[str, Any]], bool],
) -> Dict[str, Any]:
    """
    탭 조건에 맞는 run 집합(matching_ids)에 대해 라벨별 집계.
    합(qty_sum)은 ocr_text가 순수 숫자인 RunItem만 더하고,
    item_label_avg_qty는 (그 합) / (조건 만족 run 수) = 수집 1회(run)당 평균.
    """
    matching_ids = {str(rp["id"]) for rp in runs_payload if predicate(rp)}
    run_n = len(matching_ids)
    counts = {lab: 0 for lab in ITEM_LABELS_FOR_PIE}
    qty_sum = {lab: 0 for lab in ITEM_LABELS_FOR_PIE}
    valid_qty_count = {lab: 0 for lab in ITEM_LABELS_FOR_PIE}

    for rid, label, ocr_text in item_rows:
        rid_s = str(rid)
        if rid_s not in matching_ids:
            continue
        lab = str(label or "").strip()
        if lab not in ITEM_LABELS_FOR_PIE:
            continue
        counts[lab] += 1
        qv = _ocr_text_to_int_or_none(ocr_text)
        if qv is not None:
            qty_sum[lab] += qv
            valid_qty_count[lab] += 1

    avg_qty: Dict[str, float] = {}
    for lab in ITEM_LABELS_FOR_PIE:
        avg_qty[lab] = round((qty_sum[lab] / run_n), 2) if run_n else 0.0

    total_rows = sum(counts.values())
    return {
        "run_count": run_n,
        "item_label_counts": counts,
        "item_label_valid_qty_count": valid_qty_count,
        "item_label_avg_qty": avg_qty,
        "total_item_rows": total_rows,
    }


def _one_empty_bucket() -> Dict[str, Any]:
    z = {lab: 0 for lab in ITEM_LABELS_FOR_PIE}
    return {
        "run_count": 0,
        "item_label_counts": z.copy(),
        "item_label_valid_qty_count": z.copy(),
        "item_label_avg_qty": {lab: 0.0 for lab in ITEM_LABELS_FOR_PIE},
        "total_item_rows": 0,
    }


def _empty_scan_gauge_split() -> Dict[str, Any]:
    return {"gauge_180": _one_empty_bucket(), "gauge_360": _one_empty_bucket()}


def _empty_dashboard_buckets() -> Dict[str, Any]:
    return {
        "common": _empty_scan_gauge_split(),
        "uncommon": _empty_scan_gauge_split(),
        "mini_common": _one_empty_bucket(),
        "mini_uncommon": _one_empty_bucket(),
        "chest": _one_empty_bucket(),
    }


@router.get("/auth/dashboard-stats")
async def get_dashboard_stats(
    request: Request,
    tool_spec_id: Optional[int] = Query(None, description="생활 스펙 프리셋 ID. 생략 시 설정의 기본 프리셋"),
    db: AsyncSession = Depends(get_db),
):
    """
    **선택한 생활 스펙 프리셋**(``Run.tool_spec_id``)에 묶인 run만 집계한다.
    ``tool_spec_id``를 생략하면 ``user_settings.tool_spec_id``를 사용한다.
    ``common`` / ``uncommon``은 행동 **고고학(normal)** + 해당 스캔 결과만 포함하며,
    ``Run.gauge`` **180**·**360**(도약)으로 나뉜다.
    ``mini_common`` / ``mini_uncommon``은 **미니게임(mini)** + 스캔 결과별 단일 집계(도약 효과 없음, gauge 구분 없음).
    ``scan_result_id``가 없는 mini run(화면에 스캔 UI가 없어 미식별)은 ``mini_common``에 포함한다.
    보물상자는 ``action_label == chest`` run만 집계한다.
    ``item_label_avg_qty``는 라벨별 (숫자 OCR 합) / (해당 버킷 run 수)로, 수집 1회(run)당 평균이다.
    """
    user_id = _session_user_id_or_401(request)

    q_set = await db.execute(select(UserSetting).where(UserSetting.user_id == user_id))
    setting = q_set.scalar_one_or_none()
    default_spec_id = setting.tool_spec_id if setting else None
    effective_id = tool_spec_id if tool_spec_id is not None else default_spec_id

    tool_spec_name: Optional[str] = None
    if effective_id is not None:
        q_spec = await db.execute(
            select(UserToolSpec).where(
                UserToolSpec.id == effective_id,
                UserToolSpec.user_id == user_id,
            )
        )
        spec_row = q_spec.scalar_one_or_none()
        if spec_row is None:
            if tool_spec_id is not None:
                raise HTTPException(status_code=404, detail="생활 스펙 프리셋을 찾을 수 없습니다.")
            effective_id = None
        else:
            tool_spec_name = spec_row.name

    if effective_id is None:
        out = _empty_dashboard_buckets()
        out["tool_spec_id"] = None
        out["tool_spec_name"] = None
        return out

    q = await db.execute(
        select(Run, ScanResult.label, ActionType.label)
        .outerjoin(ScanResult, Run.scan_result_id == ScanResult.id)
        .join(ActionType, Run.action_type_id == ActionType.id)
        .where(Run.user_id == user_id, Run.tool_spec_id == effective_id)
        .order_by(Run.created_at.asc())
    )
    rows = q.all()
    runs_payload: List[Dict[str, Any]] = []
    for run, scan_label, action_label in rows:
        runs_payload.append(
            {
                "id": run.id,
                "created_at": run.created_at.isoformat() if run.created_at else None,
                "scan_label": (scan_label or "").strip() or None,
                "action_label": (action_label or "").strip() or None,
                "gauge": int(run.gauge) if run.gauge is not None else None,
            }
        )
    run_ids = [rp["id"] for rp in runs_payload]
    item_rows: List[tuple] = []
    if run_ids:
        items_q = await db.execute(
            select(RunItem.run_id, RunItem.label, RunItem.ocr_text).where(
                RunItem.run_id.in_(run_ids),
                RunItem.label.in_(ITEM_LABELS_FOR_PIE),
            )
        )
        item_rows = list(items_q.all())

    common = _build_scan_bucket_by_gauge(runs_payload, item_rows, "common", "normal")
    uncommon = _build_scan_bucket_by_gauge(runs_payload, item_rows, "uncommon", "normal")
    mini_common = _build_dashboard_bucket(
        runs_payload,
        item_rows,
        lambda rp: _mini_scan_bucket_pred(rp, False),
    )
    mini_uncommon = _build_dashboard_bucket(
        runs_payload,
        item_rows,
        lambda rp: _mini_scan_bucket_pred(rp, True),
    )
    chest = _build_dashboard_bucket(
        runs_payload,
        item_rows,
        lambda rp: rp.get("action_label") == "chest",
    )

    return {
        "tool_spec_id": effective_id,
        "tool_spec_name": tool_spec_name,
        "common": common,
        "uncommon": uncommon,
        "mini_common": mini_common,
        "mini_uncommon": mini_uncommon,
        "chest": chest,
    }


def _purge_expired() -> None:
    now = datetime.utcnow()
    expired_states = [k for k, v in _oauth_states.items() if v < now]
    for k in expired_states:
        _oauth_states.pop(k, None)
    expired_sessions = [k for k, v in _sessions.items() if v.get("expires_at") and v["expires_at"] < now]
    for k in expired_sessions:
        _sessions.pop(k, None)


def _build_discord_authorize_url(state: str) -> str:
    query = urlencode(
        {
            "client_id": DISCORD_CLIENT_ID,
            "redirect_uri": DISCORD_REDIRECT_URI,
            "response_type": "code",
            "scope": DISCORD_OAUTH_SCOPE,
            "state": state,
            "prompt": "consent",
        }
    )
    return f"https://discord.com/api/oauth2/authorize?{query}"


@router.get("/auth/discord/login")
async def discord_login():
    if not DISCORD_CLIENT_ID or not DISCORD_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail="Discord OAuth 환경변수(DISCORD_CLIENT_ID/SECRET)가 필요합니다.")
    _purge_expired()
    state = secrets.token_urlsafe(24)
    _oauth_states[state] = datetime.utcnow() + timedelta(minutes=STATE_TTL_MINUTES)
    return RedirectResponse(url=_build_discord_authorize_url(state), status_code=302)


@router.get("/auth/discord/callback")
async def discord_callback(
    code: Optional[str] = None,
    state: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    if not code or not state:
        return RedirectResponse(url=f"{FRONTEND_BASE_URL}/login?status=error&reason=missing_code_or_state", status_code=302)

    _purge_expired()
    if state not in _oauth_states:
        return RedirectResponse(url=f"{FRONTEND_BASE_URL}/login?status=error&reason=invalid_state", status_code=302)
    _oauth_states.pop(state, None)

    token_payload = {
        "client_id": DISCORD_CLIENT_ID,
        "client_secret": DISCORD_CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": DISCORD_REDIRECT_URI,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            token_res = await client.post("https://discord.com/api/oauth2/token", data=token_payload, headers=headers)
            token_res.raise_for_status()
            token_data = token_res.json()
            access_token = token_data.get("access_token")
            if not access_token:
                raise HTTPException(status_code=400, detail="Discord access token을 가져오지 못했습니다.")

            user_res = await client.get(
                "https://discord.com/api/users/@me", headers={"Authorization": f"Bearer {access_token}"}
            )
            user_res.raise_for_status()
            user = user_res.json()
    except HTTPException:
        raise
    except Exception:
        return RedirectResponse(url=f"{FRONTEND_BASE_URL}/login?status=error&reason=oauth_failed", status_code=302)

    discord_id = str(user.get("id") or "").strip()
    if not discord_id:
        return RedirectResponse(url=f"{FRONTEND_BASE_URL}/login?status=error&reason=invalid_discord_user", status_code=302)
    username = str(user.get("username") or "").strip() or "unknown"
    global_name = user.get("global_name")
    avatar = user.get("avatar")

    q = await db.execute(select(User).where(User.discord_id == discord_id))
    db_user = q.scalar_one_or_none()
    if db_user is None:
        db_user = User(
            discord_id=discord_id,
            username=username,
            global_name=global_name,
            avatar=avatar,
        )
        db.add(db_user)
        await db.flush()
        # 최소 스키마: tool_spec_id만 저장
        db.add(UserSetting(user_id=db_user.id, tool_spec_id=None))
    else:
        db_user.username = username
        db_user.global_name = global_name
        db_user.avatar = avatar
        db_user.updated_at = datetime.utcnow()
        q2 = await db.execute(select(UserSetting).where(UserSetting.user_id == db_user.id))
        if q2.scalar_one_or_none() is None:
            db.add(UserSetting(user_id=db_user.id, tool_spec_id=None))

    await db.flush()

    session_id = secrets.token_urlsafe(32)
    expires_at = datetime.utcnow() + timedelta(hours=SESSION_TTL_HOURS)
    _sessions[session_id] = {
        "user_id": int(db_user.id),
        "discord_id": discord_id,
        "username": db_user.username,
        "global_name": db_user.global_name,
        "avatar": db_user.avatar,
        "expires_at": expires_at,
    }

    resp = RedirectResponse(url=f"{FRONTEND_BASE_URL}/login?status=success", status_code=302)
    resp.set_cookie(
        key="session_id",
        value=session_id,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=int(timedelta(hours=SESSION_TTL_HOURS).total_seconds()),
        path="/",
    )
    return resp


@router.get("/auth/me")
async def auth_me(request: Request, db: AsyncSession = Depends(get_db)):
    _purge_expired()
    session_id = request.cookies.get("session_id")
    if not session_id or session_id not in _sessions:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    u = _sessions[session_id]
    user_id = int(u.get("user_id") or 0)
    avatar_hash = u.get("avatar")
    avatar_url = None
    if u.get("discord_id") and avatar_hash:
        avatar_url = f"https://cdn.discordapp.com/avatars/{u['discord_id']}/{avatar_hash}.png?size=128"

    q = await db.execute(select(UserSetting).where(UserSetting.user_id == user_id))
    setting = q.scalar_one_or_none()
    tool_spec_id = setting.tool_spec_id if setting else None

    return {
        "id": u.get("discord_id"),
        "user_id": user_id,
        "username": u.get("username"),
        "global_name": u.get("global_name"),
        "avatar_url": avatar_url,
        "tool_spec_id": tool_spec_id,
    }


@router.post("/auth/logout")
async def auth_logout(request: Request, response: Response):
    session_id = request.cookies.get("session_id")
    if session_id:
        _sessions.pop(session_id, None)
    response.delete_cookie(key="session_id", path="/")
    return {"ok": True}


@router.get("/auth/settings")
async def get_my_settings(request: Request, db: AsyncSession = Depends(get_db)):
    user_id = _session_user_id_or_401(request)

    q = await db.execute(select(UserSetting).where(UserSetting.user_id == user_id))
    setting = q.scalar_one_or_none()
    if setting is None:
        setting = UserSetting(user_id=user_id, tool_spec_id=None)
        db.add(setting)
        await db.flush()

    return {
        "user_id": user_id,
        "tool_spec_id": setting.tool_spec_id,
        "updated_at": setting.updated_at.isoformat() if setting.updated_at else None,
    }


@router.put("/auth/settings")
async def update_my_settings(
    body: UpdateMySettingsBody,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    user_id = _session_user_id_or_401(request)

    if body.tool_spec_id is not None:
        q_spec = await db.execute(
            select(UserToolSpec).where(
                UserToolSpec.id == body.tool_spec_id,
                UserToolSpec.user_id == user_id,
            )
        )
        spec = q_spec.scalar_one_or_none()
        if spec is None:
            raise HTTPException(status_code=404, detail="내 생활 스펙을 찾을 수 없습니다.")

    q = await db.execute(select(UserSetting).where(UserSetting.user_id == user_id))
    setting = q.scalar_one_or_none()
    if setting is None:
        setting = UserSetting(user_id=user_id, tool_spec_id=body.tool_spec_id)
        db.add(setting)
    else:
        setting.tool_spec_id = body.tool_spec_id
        setting.updated_at = datetime.utcnow()

    await db.flush()
    return {
        "ok": True,
        "user_id": user_id,
        "tool_spec_id": setting.tool_spec_id,
        "updated_at": setting.updated_at.isoformat() if setting.updated_at else None,
    }


@router.get("/auth/my-tool-specs")
async def list_my_tool_specs(request: Request, db: AsyncSession = Depends(get_db)):
    user_id = _session_user_id_or_401(request)
    result = await db.execute(
        select(UserToolSpec)
        .where(UserToolSpec.user_id == user_id)
        .order_by(UserToolSpec.id)
    )
    rows = result.scalars().all()
    return {
        "tool_specs": [
            {
                "id": s.id,
                "name": s.name,
                "common_reward_bonus": s.common_reward_bonus,
                "uncommon_reward_bonus": s.uncommon_reward_bonus,
                "rare_reward_bonus": s.rare_reward_bonus,
                "minigame_reward_bonus": s.minigame_reward_bonus,
                "minigame_chance_bonus": s.minigame_chance_bonus,
                "chest_spawn_bonus": s.chest_spawn_bonus,
                "updated_at": s.updated_at.isoformat() if s.updated_at else None,
            }
            for s in rows
        ]
    }


@router.post("/auth/my-tool-specs")
async def create_my_tool_spec(
    body: CreateMyToolSpecBody,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    user_id = _session_user_id_or_401(request)
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name은 필수입니다.")
    row = UserToolSpec(
        user_id=user_id,
        name=name,
        common_reward_bonus=body.common_reward_bonus,
        uncommon_reward_bonus=body.uncommon_reward_bonus,
        rare_reward_bonus=body.rare_reward_bonus,
        minigame_reward_bonus=body.minigame_reward_bonus,
        minigame_chance_bonus=body.minigame_chance_bonus,
        chest_spawn_bonus=body.chest_spawn_bonus,
    )
    db.add(row)
    await db.flush()
    return {"id": row.id}


@router.delete("/auth/my-tool-specs/{spec_id}")
async def delete_my_tool_spec(
    spec_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    user_id = _session_user_id_or_401(request)
    result = await db.execute(
        select(UserToolSpec).where(
            UserToolSpec.id == spec_id,
            UserToolSpec.user_id == user_id,
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="내 생활 스펙을 찾을 수 없습니다.")

    # 현재 선택된 설정이면 해제
    setting_result = await db.execute(select(UserSetting).where(UserSetting.user_id == user_id))
    setting = setting_result.scalar_one_or_none()
    if setting and setting.tool_spec_id == spec_id:
        setting.tool_spec_id = None
        setting.updated_at = datetime.utcnow()

    await db.delete(row)
    return {"ok": True}
