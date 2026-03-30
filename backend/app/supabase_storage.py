"""Supabase Storage — track OCR 크롭 PNG 업로드 (서비스 롤, 서버 전용)."""
from __future__ import annotations

import asyncio
import os
from functools import lru_cache
from typing import Optional

from app.config import (
    SUPABASE_CROPS_BUCKET,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_URL,
)


def supabase_crops_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and SUPABASE_CROPS_BUCKET)


@lru_cache(maxsize=1)
def _sync_client():
    if not supabase_crops_configured():
        return None
    from supabase import create_client

    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def _upload_png_sync(object_path: str, png_bytes: bytes) -> str:
    client = _sync_client()
    if client is None:
        raise RuntimeError("Supabase client unavailable")
    bucket = SUPABASE_CROPS_BUCKET
    client.storage.from_(bucket).upload(
        object_path,
        png_bytes,
        file_options={"content-type": "image/png", "upsert": "true"},
    )
    pub = client.storage.from_(bucket).get_public_url(object_path)
    return str(pub).rstrip("?")


def get_track_ocr_crop_public_url(image_filename: Optional[str]) -> Optional[str]:
    """
    업로드 경로와 동일하게 `track_ocr/crops/{파일명}` 에 대해 get_public_url 로 절대 URL 조합.
    DB에 image_storage_url 이 없어도 스토리지에 객체만 있으면 관리자 썸네일에 사용 가능.
    """
    if not image_filename or not supabase_crops_configured():
        return None
    safe = os.path.basename(str(image_filename).strip())
    if not safe or safe in (".", ".."):
        return None
    client = _sync_client()
    if client is None:
        return None
    object_path = f"track_ocr/crops/{safe}"
    pub = client.storage.from_(SUPABASE_CROPS_BUCKET).get_public_url(object_path)
    return str(pub).rstrip("?")


async def upload_track_ocr_crop_png(object_path: str, png_bytes: bytes) -> Optional[str]:
    """
    크롭 PNG를 버킷에 올리고 공개 URL 반환.
    설정이 없거나 실패 시 None (호출측에서 로컬 저장 폴백).
    """
    if not supabase_crops_configured():
        return None
    try:
        return await asyncio.to_thread(_upload_png_sync, object_path, png_bytes)
    except Exception:
        return None
