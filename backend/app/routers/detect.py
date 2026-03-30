"""이미지 파일을 받아 객체 탐지/숫자 OCR 테스트 수행 (저장 없음)"""
import asyncio

from fastapi import APIRouter, UploadFile, File, HTTPException
from pathlib import Path
import tempfile
import uuid
import aiofiles
import cv2
import numpy as np
from app.config import ALLOWED_EXTENSIONS
from app.ocr.detector import detect_objects, warmup_model
from app.ocr.processor import process_crop_image, process_gauge_crop_image, parse_gauge_remaining_total
from app.ocr.run_inference import scan_result_and_confidence_from_detections

router = APIRouter()


@router.post("/detect/warmup")
async def detect_warmup():
    """YOLO 싱글톤 로드(첫 추론 전). 프론트에서 화면 공유 직후 게이지 기준선 OCR 전에 호출."""
    try:
        await asyncio.to_thread(warmup_model)
        return {"ok": True, "model_ready": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"모델 워밍업 실패: {str(e)}")


@router.post("/detect")
async def detect_image(file: UploadFile = File(...)):
    """이미지를 받아 객체 탐지 결과만 반환 (저장하지 않음)"""

    ext = Path(file.filename or "image.png").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        ext = ".png"

    content = await file.read()
    tmp_path = Path(tempfile.gettempdir()) / f"detect_{uuid.uuid4().hex}{ext}"

    try:
        async with aiofiles.open(tmp_path, "wb") as f:
            await f.write(content)
        detections = await detect_objects(str(tmp_path), confidence_threshold=0.6)
        scan_result, scan_confidence = scan_result_and_confidence_from_detections(detections)
        return {
            "detections": detections,
            "scan_result": scan_result,
            "scan_confidence": scan_confidence,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"탐지 실패: {str(e)}")
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


@router.post("/detect/number-ocr")
async def detect_number_ocr(file: UploadFile = File(...)):
    """이미지 1장을 받아 숫자 OCR 테스트 결과 반환 (크롭 가정)."""
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="빈 파일입니다.")

    try:
        arr = np.frombuffer(content, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise HTTPException(status_code=400, detail="이미지 디코딩 실패")

        ocr = await process_crop_image(img)
        return {
            "ocr_text": ocr.get("text", ""),
            "ocr_number": ocr.get("number"),
            "ocr_confidence": float(ocr.get("confidence", 0.0) or 0.0),
            "ocr_details": ocr.get("details", []),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"숫자 OCR 테스트 실패: {str(e)}")


@router.post("/detect/gauge-ocr")
async def detect_gauge_ocr(file: UploadFile = File(...)):
    """YOLO `gauge` 클래스로 잘린 크롭 1장 — 게이지 숫자 전용 전처리 후 OCR."""
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="빈 파일입니다.")

    try:
        arr = np.frombuffer(content, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise HTTPException(status_code=400, detail="이미지 디코딩 실패")

        ocr = await process_gauge_crop_image(img)
        raw_text = ocr.get("text", "") or ""
        frac = parse_gauge_remaining_total(raw_text)
        return {
            "ocr_text": raw_text,
            "ocr_number": ocr.get("number"),
            "ocr_confidence": float(ocr.get("confidence", 0.0) or 0.0),
            "ocr_details": ocr.get("details", []),
            "gauge_remaining": frac["remaining"],
            "gauge_total": frac["total"],
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"게이지 OCR 실패: {str(e)}")
