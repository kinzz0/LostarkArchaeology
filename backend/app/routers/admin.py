import os
from typing import Any, Dict, List, Optional, Set

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import resolve_public_asset_url
from app.database import get_db
from app.models.db_models import ActionType, Run, RunItem, ScanResult, User, UserToolSpec
from app.routers import auth as auth_router

router = APIRouter()


class AdminPatchRunItemBody(BaseModel):
    """검증용 수정: 보낸 필드만 갱신 (OCR 텍스트만)."""

    ocr_text: Optional[str] = None


def _admin_discord_ids() -> Set[str]:
    raw = os.getenv("ADMIN_DISCORD_IDS", "").strip()
    if not raw:
        return set()
    return {x.strip() for x in raw.split(",") if x.strip()}


async def _require_admin(request: Request, db: AsyncSession) -> Dict[str, Any]:
    auth_router._purge_expired()
    session_id = request.cookies.get("session_id")
    if not session_id or session_id not in auth_router._sessions:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    s = auth_router._sessions[session_id]
    discord_id = str(s.get("discord_id") or "").strip()
    user_id = int(s.get("user_id") or 0)
    if not discord_id or user_id <= 0:
        raise HTTPException(status_code=401, detail="유효하지 않은 세션입니다.")

    admin_ids = _admin_discord_ids()
    if not admin_ids or discord_id not in admin_ids:
        raise HTTPException(status_code=403, detail="관리자 권한이 없습니다.")

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=401, detail="사용자를 찾을 수 없습니다.")
    return {
        "user_id": user_id,
        "discord_id": discord_id,
        "username": user.username,
        "global_name": user.global_name,
    }


@router.get("/admin/me")
async def admin_me(request: Request, db: AsyncSession = Depends(get_db)):
    me = await _require_admin(request, db)
    return {"ok": True, "admin": me}


@router.get("/admin/overview")
async def admin_overview(request: Request, db: AsyncSession = Depends(get_db)):
    await _require_admin(request, db)

    users_count = (await db.execute(select(func.count()).select_from(User))).scalar() or 0
    runs_count = (await db.execute(select(func.count()).select_from(Run))).scalar() or 0
    run_items_count = (await db.execute(select(func.count()).select_from(RunItem))).scalar() or 0

    return {
        "counts": {
            "users": int(users_count),
            "runs": int(runs_count),
            "run_items": int(run_items_count),
        },
    }


@router.get("/admin/recent-runs")
async def admin_recent_runs(
    request: Request,
    page: int = Query(1, ge=1),
    limit: int = Query(10, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
):
    """최신 run 목록(요약 행). 페이지네이션."""
    await _require_admin(request, db)
    safe_page = max(1, int(page))
    safe_limit = max(1, min(int(limit), 50))
    offset = (safe_page - 1) * safe_limit

    total_runs = int((await db.execute(select(func.count()).select_from(Run))).scalar() or 0)
    recent_q = (
        select(Run.id, Run.created_at, Run.tracked_count, Run.user_id, User.username, User.global_name)
        .outerjoin(User, Run.user_id == User.id)
        .order_by(Run.created_at.desc())
        .offset(offset)
        .limit(safe_limit)
    )
    recent_rows = (await db.execute(recent_q)).all()
    runs_out = []
    for row in recent_rows:
        runs_out.append(
            {
                "run_id": row.id,
                "created_at": row.created_at.isoformat() if row.created_at else None,
                "tracked_count": row.tracked_count,
                "user_id": row.user_id,
                "username": row.username,
                "global_name": row.global_name,
            }
        )
    total_pages = 0 if total_runs == 0 else int((total_runs + safe_limit - 1) / safe_limit)
    return {
        "runs": runs_out,
        "pagination": {
            "page": safe_page,
            "limit": safe_limit,
            "total": total_runs,
            "total_pages": total_pages,
        },
    }


def _admin_run_verify_filters(
    action: Optional[str],
    scan: Optional[str],
    gauge: Optional[int],
) -> List[Any]:
    """행동·스캔·게이지 조건 (ActionType/ScanResult 조인 후 where에 붙임)."""
    clauses: List[Any] = []
    if action and str(action).strip():
        clauses.append(ActionType.label == str(action).strip())
    if scan is not None and str(scan).strip() != "":
        s = str(scan).strip().lower()
        if s == "none":
            clauses.append(Run.scan_result_id.is_(None))
        else:
            clauses.append(ScanResult.label == str(scan).strip())
    if gauge is not None:
        clauses.append(Run.gauge == int(gauge))
    return clauses


@router.get("/admin/run-items")
async def admin_run_items(
    request: Request,
    page: int = 1,
    limit: int = 10,
    action: Optional[str] = Query(None, description="행동 라벨: normal, chest, mini"),
    scan: Optional[str] = Query(None, description="스캔: common, uncommon, none(스캔 없음)"),
    gauge: Optional[int] = Query(None, description="게이지 소모량(정확히 일치)"),
    db: AsyncSession = Depends(get_db),
):
    await _require_admin(request, db)
    safe_page = max(1, int(page))
    safe_limit = max(1, min(int(limit), 50))
    offset = (safe_page - 1) * safe_limit

    clauses = _admin_run_verify_filters(action, scan, gauge)

    count_q = (
        select(func.count())
        .select_from(Run)
        .join(ActionType, Run.action_type_id == ActionType.id)
        .outerjoin(ScanResult, Run.scan_result_id == ScanResult.id)
    )
    for c in clauses:
        count_q = count_q.where(c)
    total_runs = int((await db.execute(count_q)).scalar() or 0)

    run_id_q = (
        select(Run.id)
        .join(ActionType, Run.action_type_id == ActionType.id)
        .outerjoin(ScanResult, Run.scan_result_id == ScanResult.id)
    )
    for c in clauses:
        run_id_q = run_id_q.where(c)
    run_id_q = run_id_q.order_by(Run.created_at.desc()).offset(offset).limit(safe_limit)
    run_ids = [r[0] for r in (await db.execute(run_id_q)).all()]
    if not run_ids:
        return {
            "runs": [],
            "pagination": {
                "page": safe_page,
                "limit": safe_limit,
                "total": total_runs,
                "total_pages": 0 if total_runs == 0 else int((total_runs + safe_limit - 1) / safe_limit),
            },
        }

    q = (
        select(
            RunItem.id,
            RunItem.run_id,
            RunItem.item_index,
            RunItem.label,
            RunItem.ocr_text,
            RunItem.ocr_confidence,
            RunItem.image_filename,
            RunItem.image_storage_url,
            Run.created_at,
            Run.user_id,
            Run.tool_spec_id,
            Run.gauge,
            User.username,
            User.global_name,
            ActionType.label.label("action_type_label"),
            ScanResult.label.label("scan_result_label"),
            UserToolSpec.name.label("tool_spec_name"),
        )
        .join(Run, Run.id == RunItem.run_id)
        .join(ActionType, Run.action_type_id == ActionType.id)
        .outerjoin(ScanResult, Run.scan_result_id == ScanResult.id)
        .outerjoin(User, User.id == Run.user_id)
        .outerjoin(UserToolSpec, Run.tool_spec_id == UserToolSpec.id)
        .where(Run.id.in_(run_ids))
        .order_by(Run.created_at.desc(), RunItem.id.desc())
    )
    def _str_or_none(v: Any) -> Optional[str]:
        if v is None:
            return None
        s = str(v).strip()
        return s if s else None

    rows = (await db.execute(q)).all()
    grouped: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        image_url = None
        if getattr(r, "image_storage_url", None):
            image_url = str(r.image_storage_url).strip() or None
        elif r.image_filename:
            image_url = f"/static/track_ocr/crops/{r.image_filename}"
        key = str(r.run_id)
        mp = getattr(r, "_mapping", None)
        if mp is not None:
            action_lbl = _str_or_none(mp.get("action_type_label"))
            scan_lbl = _str_or_none(mp.get("scan_result_label"))
            tool_spec_nm = _str_or_none(mp.get("tool_spec_name"))
            ts_id = mp.get("tool_spec_id")
        else:
            action_lbl = _str_or_none(getattr(r, "action_type_label", None))
            scan_lbl = _str_or_none(getattr(r, "scan_result_label", None))
            tool_spec_nm = _str_or_none(getattr(r, "tool_spec_name", None))
            ts_id = getattr(r, "tool_spec_id", None)
        if key not in grouped:
            g_raw = getattr(r, "gauge", None)
            try:
                gauge_val = int(g_raw) if g_raw is not None else None
            except (TypeError, ValueError):
                gauge_val = None
            try:
                tool_spec_id_val = int(ts_id) if ts_id is not None else None
            except (TypeError, ValueError):
                tool_spec_id_val = None
            grouped[key] = {
                "run_id": r.run_id,
                "run_created_at": r.created_at.isoformat() if r.created_at else None,
                "user_id": r.user_id,
                "username": r.username,
                "global_name": r.global_name,
                "tool_spec_id": tool_spec_id_val,
                "tool_spec_name": tool_spec_nm,
                "action_type": action_lbl,
                "scan_result": scan_lbl,
                "gauge": gauge_val,
                "item_count": 0,
                "items": [],
            }
        grouped[key]["item_count"] += 1
        grouped[key]["items"].append(
            {
                "id": r.id,
                "item_index": r.item_index,
                "label": r.label,
                "ocr_text": r.ocr_text,
                "ocr_confidence": r.ocr_confidence,
                "image_filename": r.image_filename,
                "image_url": resolve_public_asset_url(image_url),
            }
        )
    total_pages = 0 if total_runs == 0 else int((total_runs + safe_limit - 1) / safe_limit)
    ordered_runs = [grouped[str(rid)] for rid in run_ids if str(rid) in grouped]
    return {
        "runs": ordered_runs,
        "pagination": {
            "page": safe_page,
            "limit": safe_limit,
            "total": total_runs,
            "total_pages": total_pages,
        },
    }


@router.patch("/admin/run-items/{run_item_id}")
async def admin_patch_run_item(
    run_item_id: int,
    body: AdminPatchRunItemBody,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """run_item의 OCR 텍스트 수정 (DB 검증 화면용)."""
    await _require_admin(request, db)
    result = await db.execute(select(RunItem).where(RunItem.id == run_item_id))
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="run_item을 찾을 수 없습니다.")
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="변경할 필드를 보내 주세요.")
    if "ocr_text" in updates:
        row.ocr_text = updates["ocr_text"]
    await db.flush()
    return {
        "ok": True,
        "run_item_id": run_item_id,
        "ocr_text": row.ocr_text,
    }


@router.delete("/admin/run-items/{run_item_id}")
async def admin_delete_run_item(run_item_id: int, request: Request, db: AsyncSession = Depends(get_db)):
    await _require_admin(request, db)
    result = await db.execute(select(RunItem).where(RunItem.id == run_item_id))
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="run_item을 찾을 수 없습니다.")
    await db.delete(row)
    return {"ok": True, "run_item_id": run_item_id}


@router.delete("/admin/runs/{run_id}")
async def admin_delete_run(run_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    await _require_admin(request, db)
    result = await db.execute(select(Run).where(Run.id == run_id))
    run = result.scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=404, detail="run을 찾을 수 없습니다.")

    # run_items 먼저 삭제
    rows = await db.execute(select(RunItem).where(RunItem.run_id == run_id))
    for it in rows.scalars().all():
        await db.delete(it)
    await db.delete(run)
    return {"ok": True, "run_id": run_id}
