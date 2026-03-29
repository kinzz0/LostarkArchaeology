from fastapi import APIRouter, UploadFile, File, HTTPException
from pathlib import Path
import os
import tempfile
import uuid
import aiofiles
from datetime import datetime

from app.config import ALLOWED_EXTENSIONS
from app.ocr.processor import process_image

router = APIRouter()


@router.post("/upload")
async def upload_image(file: UploadFile = File(...)):
    """이미지를 업로드하고 OCR/탐지 분석을 수행합니다."""

    # 확장자 검증
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"지원하지 않는 파일 형식입니다. 지원: {', '.join(ALLOWED_EXTENSIONS)}",
        )

    # 고유 파일명 생성
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    unique_name = f"{timestamp}_{uuid.uuid4().hex[:8]}{ext}"

    content = await file.read()
    fd, tmp_path = tempfile.mkstemp(suffix=ext)
    os.close(fd)
    try:
        async with aiofiles.open(tmp_path, "wb") as f:
            await f.write(content)

        try:
            ocr_data = await process_image(str(tmp_path))
        except Exception as e:
            ocr_data = {"error": str(e), "text": "", "confidence": 0}

        return {
            "filename": unique_name,
            "original_name": file.filename,
            "image_url": None,
            "ocr_data": ocr_data,
            "timestamp": datetime.now().isoformat(),
        }
    finally:
        Path(tmp_path).unlink(missing_ok=True)
