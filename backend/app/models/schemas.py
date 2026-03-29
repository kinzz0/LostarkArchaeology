"""
Pydantic 데이터 모델 (API 요청/응답 스키마)
"""
from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class DetectionResult(BaseModel):
    """객체 탐지 결과"""
    label: str
    confidence: float
    bbox: list[int]
    class_id: int


class OcrResult(BaseModel):
    """OCR 결과"""
    text: str
    confidence: float
    details: list[dict] = []


class ImageUploadResponse(BaseModel):
    """이미지 업로드 응답"""
    filename: str
    original_name: str
    image_url: str
    ocr_data: Optional[OcrResult] = None
    timestamp: str


class CaptureResponse(BaseModel):
    """화면 캡처 응답"""
    filename: str
    image_url: str
    ocr_data: Optional[OcrResult] = None
    detections: list[DetectionResult] = []
    timestamp: str


class DataItem(BaseModel):
    """수집 데이터 항목"""
    filename: str
    image_url: str
    has_label: bool
    size_bytes: int
    created_at: str


class DataListResponse(BaseModel):
    """데이터 목록 응답"""
    items: list[DataItem]
    total: int
    page: int
    limit: int
    total_pages: int


class DataStatsResponse(BaseModel):
    """데이터 통계 응답"""
    total_images: int
    labeled_images: int
    unlabeled_images: int
    total_size_mb: float
