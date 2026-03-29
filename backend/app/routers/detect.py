"""숫자/게이지 OCR 등. 객체 탐지는 프론트 ONNX 전담 — /detect 비활성."""
from fastapi import APIRouter, UploadFile, File, HTTPException
import cv2
import numpy as np
from app.ocr.processor import process_crop_image, process_gauge_crop_image, parse_gauge_remaining_total

router = APIRouter()


@router.post("/detect/warmup")
async def detect_warmup():
    """백엔드 YOLO 없음. 프론트에서 ONNX 세션 준비."""
    return {"ok": True, "model_ready": False, "frontend_model_mode": True}


@router.post("/detect")
async def detect_image(file: UploadFile = File(...)):  # noqa: ARG001
    """비활성. 탐지는 브라우저에서 수행 후 track-and-ocr에 frontend_detections_json으로 전달."""
    raise HTTPException(
        status_code=409,
        detail="백엔드 객체 탐지는 지원하지 않습니다. 프론트 ONNX 탐지 결과를 사용하세요.",
    )


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
    """gauge 클래스로 잘린 크롭 1장 — 게이지 숫자 전용 전처리 후 OCR."""
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
