"""
Cloud backend -> Modal OCR client template.
"""
from __future__ import annotations

import base64
import os
from typing import Any, Dict, Optional

import httpx


def _modal_url() -> str:
    return os.getenv("MODAL_EASYOCR_URL", "").strip()


def _modal_token() -> Optional[str]:
    token = os.getenv("MODAL_EASYOCR_TOKEN", "").strip()
    return token or None


def _timeout_sec() -> float:
    raw = os.getenv("MODAL_TIMEOUT_SEC", "12").strip()
    try:
        return max(1.0, float(raw))
    except ValueError:
        return 12.0


def call_modal_easyocr(image_bytes: bytes) -> Dict[str, Any]:
    """
    Call Modal easyocr.onnx endpoint.

    Request:
      { "image_base64": "<...>" }
    Response (example):
      { "ok": true, "text": "...", "confidence": 0.97, "number": "123" }
    """
    url = _modal_url()
    if not url:
        raise RuntimeError("MODAL_EASYOCR_URL is required")

    headers: Dict[str, str] = {"Content-Type": "application/json"}
    token = _modal_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    payload = {"image_base64": base64.b64encode(image_bytes).decode("utf-8")}
    timeout = _timeout_sec()

    last_error: Optional[Exception] = None
    # 최소 1회 재시도 정책
    for _ in range(2):
        try:
            with httpx.Client(timeout=timeout) as client:
                res = client.post(url, json=payload, headers=headers)
            res.raise_for_status()
            data: Dict[str, Any] = res.json()
            return data
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"Modal OCR call failed: {last_error}")

