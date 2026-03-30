from datetime import datetime
from pathlib import Path
from typing import List, Optional
import asyncio
import json
import os
import tempfile
import uuid

import aiofiles
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.config import ALLOWED_EXTENSIONS, TRACK_OCR_DIR
from app.ocr.onnx_postprocess import detections_from_onnx_frame_payload
from app.ocr.processor import process_image
from app.ocr.run_inference import ACTION_LABELS, SCAN_LABELS
from app.services.track_ocr_pipeline import (
    TRACK_OCR_JOBS,
    _cleanup_old_jobs,
    _run_track_ocr_job,
)

router = APIRouter()


def _normalize_detection_frame_rows(frame) -> List[dict]:
    """탐지 dict 목록 → track_ocr 파이프라인용 행(8점 bbox 등)."""
    if not isinstance(frame, list):
        return []
    frame_rows: List[dict] = []
    for det in frame:
        if not isinstance(det, dict):
            continue
        label = str(det.get("label") or "").strip()
        bbox = det.get("bbox")
        if not label or not isinstance(bbox, list) or len(bbox) < 8:
            continue
        try:
            confidence = float(det.get("confidence") or 0.0)
        except Exception:
            confidence = 0.0
        frame_rows.append(
            {
                "label": label,
                "confidence": confidence,
                "bbox": bbox[:8],
                "class_id": det.get("class_id"),
                "obb": bool(det.get("obb", True)),
            }
        )
    return frame_rows


@router.post("/capture")
async def capture_screen(file: UploadFile = File(...)):
    """화면 공유로 캡처한 이미지를 받아 저장하고 OCR·객체 탐지를 수행합니다."""

    ext = Path(file.filename or "capture.png").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        ext = ".png"

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"capture_{timestamp}_{uuid.uuid4().hex[:8]}{ext}"

    content = await file.read()
    fd, tmp_path = tempfile.mkstemp(suffix=ext)
    os.close(fd)
    try:
        async with aiofiles.open(tmp_path, "wb") as f:
            await f.write(content)

        ocr_data = await process_image(str(tmp_path))

        return {
            "filename": filename,
            "image_url": None,
            "ocr_data": ocr_data,
            "detections": [],
            "timestamp": datetime.now().isoformat(),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"캡처 처리 실패: {str(e)}")
    finally:
        Path(tmp_path).unlink(missing_ok=True)


@router.post("/capture/track-and-ocr")
async def capture_track_and_ocr(
    files: List[UploadFile] = File(...),
    action_hint: Optional[str] = Form(default=None),
    has_double_potion_hint: Optional[str] = Form(default=None),
    scan_hint: Optional[str] = Form(default=None),
    frontend_detections_json: Optional[str] = Form(default=None),
    frontend_onnx_outputs_json: Optional[str] = Form(default=None),
    onnx_conf_fallback: Optional[str] = Form(default="0.5"),
):
    """여러 프레임을 받아 track-ocr 작업을 백그라운드로 등록하고 job_id를 반환."""
    if len(files) < 2:
        raise HTTPException(status_code=400, detail="트래킹을 위해 최소 2개 이상의 이미지를 보내주세요.")

    try:
        conf_fb = float((onnx_conf_fallback or "0.5").strip())
    except Exception:
        conf_fb = 0.5

    frontend_detections_by_frame: Optional[List[List[dict]]] = None

    if frontend_onnx_outputs_json:
        try:
            parsed_onnx = json.loads(frontend_onnx_outputs_json)
        except Exception:
            raise HTTPException(
                status_code=400,
                detail="frontend_onnx_outputs_json 파싱 실패(JSON 형식 오류)",
            )
        if not isinstance(parsed_onnx, list):
            raise HTTPException(
                status_code=400,
                detail="frontend_onnx_outputs_json은 프레임별 배열(list)이어야 합니다.",
            )
        normalized: List[List[dict]] = []
        for item in parsed_onnx:
            if not isinstance(item, dict):
                normalized.append([])
                continue
            raw_dets = detections_from_onnx_frame_payload(item, conf_fallback=conf_fb)
            normalized.append(_normalize_detection_frame_rows(raw_dets))
        frontend_detections_by_frame = normalized

    elif frontend_detections_json:
        try:
            parsed = json.loads(frontend_detections_json)
        except Exception:
            raise HTTPException(status_code=400, detail="frontend_detections_json 파싱 실패(JSON 형식 오류)")
        if not isinstance(parsed, list):
            raise HTTPException(status_code=400, detail="frontend_detections_json은 프레임별 배열(list)이어야 합니다.")
        normalized = []
        for frame in parsed:
            normalized.append(_normalize_detection_frame_rows(frame if isinstance(frame, list) else []))
        frontend_detections_by_frame = normalized

    if not frontend_detections_by_frame:
        raise HTTPException(
            status_code=400,
            detail="frontend_onnx_outputs_json(ONNX raw 텐서·meta) 또는 frontend_detections_json 중 하나가 필요합니다.",
        )

    if len(frontend_detections_by_frame) != len(files):
        raise HTTPException(
            status_code=400,
            detail=f"프레임 수 불일치: 이미지 {len(files)}장, 탐지/ONNX 배열 {len(frontend_detections_by_frame)}개",
        )

    _cleanup_old_jobs()
    job_id = uuid.uuid4().hex
    run_id = uuid.uuid4().hex
    frames_dir = TRACK_OCR_DIR / "frames" / run_id
    frames_dir.mkdir(parents=True, exist_ok=True)
    saved_paths = []
    for i, f in enumerate(files):
        ext = Path(f.filename or "frame.png").suffix.lower() or ".png"
        if ext not in ALLOWED_EXTENSIONS:
            ext = ".png"
        path = frames_dir / f"frame_{i:04d}{ext}"
        content = await f.read()
        async with aiofiles.open(path, "wb") as out:
            await out.write(content)
        saved_paths.append(str(path))

    TRACK_OCR_JOBS[job_id] = {
        "job_id": job_id,
        "run_id": run_id,
        "status": "queued",
        "created_at": datetime.now().isoformat(),
        "result": None,
        "error": None,
        "started_at": None,
        "completed_at": None,
    }

    if action_hint is not None:
        action_hint = action_hint.strip() or None
        if action_hint is not None and action_hint not in ACTION_LABELS:
            action_hint = None

    parsed_scan_hint: Optional[str] = None
    if scan_hint is not None:
        s = scan_hint.strip() or None
        if s is not None and s in SCAN_LABELS:
            parsed_scan_hint = s

    parsed_has_double_potion_hint: Optional[bool] = None
    if has_double_potion_hint is not None:
        raw = str(has_double_potion_hint).strip().lower()
        if raw in {"1", "true", "t", "yes", "y"}:
            parsed_has_double_potion_hint = True
        elif raw in {"0", "false", "f", "no", "n"}:
            parsed_has_double_potion_hint = False

    asyncio.create_task(
        _run_track_ocr_job(
            job_id=job_id,
            run_id=run_id,
            frames_dir=frames_dir,
            saved_paths=saved_paths,
            action_hint=action_hint,
            has_double_potion_hint=parsed_has_double_potion_hint,
            scan_hint=parsed_scan_hint,
            frontend_detections_by_frame=frontend_detections_by_frame,
        )
    )
    return {
        "job_id": job_id,
        "run_id": run_id,
        "status": "queued",
    }


@router.get("/capture/track-and-ocr/jobs/{job_id}")
async def get_track_ocr_job(job_id: str):
    _cleanup_old_jobs()
    job = TRACK_OCR_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")

    response = {
        "job_id": job["job_id"],
        "run_id": job["run_id"],
        "status": job["status"],
        "created_at": job["created_at"],
        "started_at": job["started_at"],
        "completed_at": job["completed_at"],
    }
    if job["status"] == "done":
        response["result"] = job["result"]
    if job["status"] == "failed":
        response["error"] = job["error"]
    return response
