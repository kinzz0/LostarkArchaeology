"""
객체 탐지 — Ultralytics YOLO-OBB (CPU 기본). .pt 또는 export ONNX.
"""
from __future__ import annotations

import asyncio
import threading
from typing import Any, Dict, List

from app.config import (
    DETECTION_CLASSES,
    YOLO_DEVICE,
    YOLO_MODEL_PATH,
    get_label_confidence_threshold,
)

_lock = threading.Lock()
_model_instance = None


def get_model():
    """YOLO-OBB 싱글톤."""
    global _model_instance
    with _lock:
        if _model_instance is None:
            from ultralytics import YOLO

            model_path = YOLO_MODEL_PATH
            if not model_path.exists():
                raise FileNotFoundError(
                    f"YOLO 모델이 없습니다: {model_path.resolve()}. "
                    "YOLO_MODEL_PATH 또는 backend/models/best.pt(.onnx) 를 배치하세요."
                )
            if model_path.suffix.lower() == ".onnx":
                _model_instance = YOLO(str(model_path), task="obb")
            else:
                _model_instance = YOLO(str(model_path))
        return _model_instance


def warmup_model() -> None:
    """첫 추론 전 세션 로드."""
    get_model()


def _detect_objects_sync(image_path: str, confidence_threshold: float = 0.5) -> List[Dict[str, Any]]:
    try:
        model = get_model()
        results = model(image_path, verbose=False, device=YOLO_DEVICE, iou=0.45)

        detections: List[Dict[str, Any]] = []
        for result in results:
            obb = getattr(result, "obb", None)
            if obb is not None and obb.xyxyxyxy is not None:
                for i in range(len(obb.conf)):
                    conf = float(obb.conf[i])
                    cls_id = int(obb.cls[i])
                    label = DETECTION_CLASSES.get(cls_id, f"class_{cls_id}")
                    min_conf = get_label_confidence_threshold(label, confidence_threshold)
                    if conf < min_conf:
                        continue
                    pts = obb.xyxyxyxy[i].flatten().tolist()
                    bbox_obb = [int(round(x)) for x in pts]
                    detections.append(
                        {
                            "label": label,
                            "confidence": round(conf, 4),
                            "bbox": bbox_obb,
                            "class_id": cls_id,
                            "obb": True,
                        }
                    )
                continue

            boxes = getattr(result, "boxes", None)
            if boxes is None:
                continue
            for box in boxes:
                conf = float(box.conf[0])
                cls_id = int(box.cls[0])
                label = DETECTION_CLASSES.get(cls_id, f"class_{cls_id}")
                min_conf = get_label_confidence_threshold(label, confidence_threshold)
                if conf < min_conf:
                    continue
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                bbox_obb = [
                    int(x1),
                    int(y1),
                    int(x2),
                    int(y1),
                    int(x2),
                    int(y2),
                    int(x1),
                    int(y2),
                ]
                detections.append(
                    {
                        "label": label,
                        "confidence": round(conf, 4),
                        "bbox": bbox_obb,
                        "class_id": cls_id,
                        "obb": True,
                    }
                )

        return detections
    except Exception as e:
        print(f"객체 탐지 오류: {e}")
        return []


async def detect_objects(image_path: str, confidence_threshold: float = 0.5) -> List[Dict[str, Any]]:
    """비동기 API·라우터용 — 스레드에서 동기 추론."""
    return await asyncio.to_thread(_detect_objects_sync, image_path, confidence_threshold)


def detect_objects_for_paths(
    paths: List[str], conf_fallback: float = 0.5
) -> List[List[Dict[str, Any]]]:
    """track-ocr 등 동기 배치 (asyncio.to_thread 로 감싸서 호출)."""
    return [_detect_objects_sync(p, conf_fallback) for p in paths]
