"""종합 OCR 결과 조회 및 검증(verified) API + DB 전송"""
from fastapi import APIRouter, HTTPException, Depends
from pathlib import Path
import json
from datetime import datetime
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional
from app.config import TRACK_OCR_RESULTS_FILE
from app.database import get_db
from app.models.db_models import Run, RunItem, DropType, User, UserToolSpec

router = APIRouter()


class SendToDbBody(BaseModel):
    user_id: Optional[int] = None
    tool_spec_id: int
    scan_result_id: Optional[int] = None
    action_type_id: int
    gauge: int
    auto_verify: bool = False


class UpdateOcrTextBody(BaseModel):
    ocr_text: str


def _load_data():
    if not TRACK_OCR_RESULTS_FILE.exists():
        return {"runs": []}
    try:
        return json.loads(TRACK_OCR_RESULTS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"runs": []}


def _save_data(data: dict):
    TRACK_OCR_RESULTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    TRACK_OCR_RESULTS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


@router.get("/track-ocr/runs")
async def list_track_ocr_runs():
    """저장된 종합 OCR 실행 목록. 각 run의 id, 생성 시각, track 수, 검증 완료 수."""
    data = _load_data()
    runs = data.get("runs", [])
    out = []
    for r in runs:
        items = r.get("items", [])
        verified_count = sum(1 for it in items if it.get("verified") is True)
        row = {
            "id": r.get("id"),
            "created_at": r.get("created_at"),
            "tracked_count": r.get("tracked_count", len(items)),
            "verified_count": verified_count,
            "scan_result": r.get("scan_result"),
            "action_type": r.get("action_type"),
            "gauge_consumed": r.get("gauge_consumed"),
            "db_sent": r.get("db_sent", False),
            "db_sent_at": r.get("db_sent_at"),
        }
        out.append(row)
    out.reverse()
    return {"runs": out}


@router.get("/track-ocr/runs/{run_id}")
async def get_track_ocr_run(run_id: str):
    """한 실행의 상세: 모든 item (track_id, label, ocr_text, verified 등). 스캔·행동·게이지·common_item/uncommon_item/rare_item 개수는 프론트에서 종합 요약으로 표시."""
    data = _load_data()
    for r in data.get("runs", []):
        if r.get("id") == run_id:
            items = r.get("items", [])
            for it in items:
                fn = it.get("image_filename") or ""
                if fn.startswith(run_id + "_"):
                    it["image_url"] = f"/static/track_ocr/crops/{fn}"
                else:
                    it["image_url"] = it.get("image_url")
            payload = {
                "id": r.get("id"),
                "created_at": r.get("created_at"),
                "tracked_count": r.get("tracked_count"),
                "items": items,
                "scan_result": r.get("scan_result"),
                "action_type": r.get("action_type"),
                "gauge_consumed": r.get("gauge_consumed"),
                "scan_frame_image_url": r.get("scan_frame_image_url"),
                "scan_ocr_processed_image_url": r.get("scan_ocr_processed_image_url"),
                "db_sent": r.get("db_sent", False),
                "db_sent_at": r.get("db_sent_at"),
            }
            return payload
    raise HTTPException(status_code=404, detail="Run not found")


@router.patch("/track-ocr/runs/{run_id}/items/{item_index}")
async def verify_track_ocr_item(run_id: str, item_index: int, verified: bool = True):
    """해당 run의 item을 '완벽한 OCR'으로 검증 처리."""
    data = _load_data()
    runs = data.get("runs", [])
    for r in runs:
        if r.get("id") != run_id:
            continue
        items = r.get("items", [])
        if item_index < 0 or item_index >= len(items):
            raise HTTPException(status_code=404, detail="Item index out of range")
        items[item_index]["verified"] = bool(verified)
        _save_data(data)
        return {"ok": True, "run_id": run_id, "item_index": item_index, "verified": items[item_index]["verified"]}
    raise HTTPException(status_code=404, detail="Run not found")


@router.delete("/track-ocr/runs/{run_id}/items/{item_index}")
async def delete_track_ocr_item(run_id: str, item_index: int):
    """해당 run의 item을 삭제."""
    data = _load_data()
    runs = data.get("runs", [])
    for r in runs:
        if r.get("id") != run_id:
            continue
        items = r.get("items", [])
        target_idx = next((i for i, it in enumerate(items) if int(it.get("item_index", -1)) == item_index), None)
        if target_idx is None:
            raise HTTPException(status_code=404, detail="Item index out of range")
        items.pop(target_idx)
        r["tracked_count"] = len(items)
        _save_data(data)
        return {"ok": True, "run_id": run_id, "item_index": item_index, "tracked_count": len(items)}
    raise HTTPException(status_code=404, detail="Run not found")


@router.patch("/track-ocr/runs/{run_id}/items/{item_index}/ocr-text")
async def update_track_ocr_item_ocr_text(run_id: str, item_index: int, body: UpdateOcrTextBody):
    """해당 run item의 개수 OCR 텍스트를 수동 수정."""
    data = _load_data()
    runs = data.get("runs", [])
    for r in runs:
        if r.get("id") != run_id:
            continue
        items = r.get("items", [])
        target_idx = next((i for i, it in enumerate(items) if int(it.get("item_index", -1)) == item_index), None)
        if target_idx is None:
            raise HTTPException(status_code=404, detail="Item index out of range")

        txt = str(body.ocr_text or "").strip()
        items[target_idx]["ocr_text"] = txt
        # 숫자만 입력된 경우 ocr_number 동기화
        items[target_idx]["ocr_number"] = txt if txt.isdigit() else None
        items[target_idx]["ocr_raw"] = txt if txt else items[target_idx].get("ocr_raw", "")
        items[target_idx]["ocr_manual_edited"] = True
        _save_data(data)
        return {
            "ok": True,
            "run_id": run_id,
            "item_index": item_index,
            "ocr_text": items[target_idx]["ocr_text"],
        }
    raise HTTPException(status_code=404, detail="Run not found")


@router.post("/track-ocr/runs/{run_id}/send-to-db")
async def send_run_to_db(
    run_id: str,
    body: SendToDbBody,
    db: AsyncSession = Depends(get_db),
):
    """검증(통과)된 항목만 DB runs / run_items 에 저장."""
    data = _load_data()
    run_data = None
    for r in data.get("runs", []):
        if r.get("id") == run_id:
            run_data = r
            break
    if not run_data:
        raise HTTPException(status_code=404, detail="Run not found")

    items = run_data.get("items", [])
    if body.auto_verify:
        verified_items = list(items)
    else:
        verified_items = [it for it in items if it.get("verified") is True]
    if not verified_items:
        raise HTTPException(
            status_code=400,
            detail="통과(검증)된 항목이 없습니다. 항목에 '통과'를 눌러주세요.",
        )

    # run_id 이미 DB에 있으면 409
    r = await db.execute(select(Run).where(Run.id == run_id))
    existing = r.scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="이미 DB에 저장된 run입니다.")

    # created_at 파싱
    created_str = run_data.get("created_at") or ""
    try:
        created_at = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
    except Exception:
        created_at = datetime.utcnow()

    # label -> drop_type_id 매핑
    result = await db.execute(select(DropType))
    drop_types = {d.label: d.id for d in result.scalars().all()}

    spec_result = await db.execute(select(UserToolSpec).where(UserToolSpec.id == body.tool_spec_id))
    spec = spec_result.scalar_one_or_none()
    if spec is None:
        raise HTTPException(status_code=400, detail="선택한 사용자 생활 스펙을 찾을 수 없습니다.")

    resolved_user_id = int(spec.user_id)
    if body.user_id is not None:
        user_result = await db.execute(select(User).where(User.id == body.user_id))
        user = user_result.scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=400, detail="선택한 사용자를 찾을 수 없습니다.")
        if int(body.user_id) != resolved_user_id:
            raise HTTPException(status_code=400, detail="선택한 생활 스펙의 소유자와 user_id가 일치하지 않습니다.")

    run_entity = Run(
        id=run_id,
        user_id=resolved_user_id,
        tool_spec_id=body.tool_spec_id,
        scan_result_id=body.scan_result_id,
        action_type_id=body.action_type_id,
        gauge=body.gauge,
        created_at=created_at,
        tracked_count=len(verified_items),
    )
    db.add(run_entity)

    for it in verified_items:
        label = it.get("label") or ""
        drop_type_id = drop_types.get(label)
        if drop_type_id is None:
            raise HTTPException(
                status_code=400,
                detail=f"알 수 없는 라벨입니다: {label}. drop_types에 해당 라벨이 없습니다.",
            )
        db.add(
            RunItem(
                run_id=run_id,
                drop_type_id=drop_type_id,
                label=label,
                ocr_text=it.get("ocr_text"),
                ocr_confidence=it.get("ocr_confidence"),
                verified=True if body.auto_verify else bool(it.get("verified") is True),
                image_filename=it.get("image_filename"),
                bbox=it.get("bbox"),
                confidence=it.get("confidence"),
                item_index=it.get("item_index"),
            )
        )

    run_data["db_sent"] = True
    run_data["db_sent_at"] = datetime.utcnow().isoformat()
    _save_data(data)

    await db.flush()
    return {
        "ok": True,
        "run_id": run_id,
        "saved_items": len(verified_items),
        "message": "DB에 저장되었습니다.",
    }
