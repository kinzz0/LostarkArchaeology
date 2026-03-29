"""
객체 탐지 모듈 (OBB: Oriented Bounding Box)
YOLOv8-OBB 기반으로 회전 박스로 게임 화면 객체 탐지
"""
import asyncio
from pathlib import Path

from app.config import (
    YOLO_MODEL_PATH,
    YOLO_DEVICE,
    DETECTION_CLASSES,
    FRONTEND_MODEL_MODE,
    get_label_confidence_threshold,
)
from typing import List, Dict, Any

# YOLO 모델 인스턴스 (싱글톤)
_model_instance = None


def get_model():
    """YOLO-OBB 모델 싱글톤 인스턴스 반환"""
    if FRONTEND_MODEL_MODE:
        raise RuntimeError("FRONTEND_MODEL_MODE enabled: backend YOLO is disabled")
    global _model_instance
    if _model_instance is None:
        model_path = YOLO_MODEL_PATH
        if not model_path.exists():
            from ultralytics import YOLO
            _model_instance = YOLO("yolov8n-obb.pt")
        else:
            from ultralytics import YOLO

            # ONNX export 시 Ultralytics가 task 자동 추론에 실패할 수 있음 — OBB 모델이면 명시
            if model_path.suffix.lower() == ".onnx":
                _model_instance = YOLO(str(model_path), task="obb")
            else:
                _model_instance = YOLO(str(model_path))
    return _model_instance


def warmup_model() -> None:
    """첫 /detect 전에 호출해 YOLO 싱글톤 로드를 끝낸다 (화면 공유 직후 게이지 OCR 등)."""
    if FRONTEND_MODEL_MODE:
        return
    get_model()


def _detect_objects_sync(image_path: str, confidence_threshold: float = 0.5) -> list:
    """동기 YOLO 추론 — `asyncio.to_thread`로 이벤트 루프에서 분리해 호출한다."""
    if FRONTEND_MODEL_MODE:
        return []
    try:
        model = get_model()
        results = model(image_path, verbose=False, device=YOLO_DEVICE, iou=0.4)

        detections = []
        for result in results:
            obb = getattr(result, "obb", None)
            if obb is not None and obb.xyxyxyxy is not None:
                for i in range(len(obb.conf)):
                    conf = float(obb.conf[i])
                    cls_id = int(obb.cls[i])
                    label = DETECTION_CLASSES.get(cls_id, f"class_{cls_id}")
                    min_conf = get_label_confidence_threshold(label, fallback=confidence_threshold)
                    if conf < min_conf:
                        continue
                    pts = obb.xyxyxyxy[i].flatten().tolist()
                    bbox_obb = [int(round(x)) for x in pts]
                    detections.append({
                        "label": label,
                        "confidence": round(conf, 4),
                        "bbox": bbox_obb,
                        "class_id": cls_id,
                        "obb": True,
                    })
                continue

            boxes = getattr(result, "boxes", None)
            if boxes is None:
                continue
            for box in boxes:
                conf = float(box.conf[0])
                cls_id = int(box.cls[0])
                label = DETECTION_CLASSES.get(cls_id, f"class_{cls_id}")
                min_conf = get_label_confidence_threshold(label, fallback=confidence_threshold)
                if conf < min_conf:
                    continue
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                bbox_obb = [int(x1), int(y1), int(x2), int(y1), int(x2), int(y2), int(x1), int(y2)]
                detections.append({
                    "label": label,
                    "confidence": round(conf, 4),
                    "bbox": bbox_obb,
                    "class_id": cls_id,
                    "obb": True,
                })

        return detections

    except Exception as e:
        print(f"객체 탐지 오류: {e}")
        return []


async def detect_objects(image_path: str, confidence_threshold: float = 0.5) -> list:
    """이미지에서 객체를 OBB(회전 박스)로 탐지합니다. bbox는 4꼭짓점 [x1,y1,x2,y2,x3,y3,x4,y4]."""
    return await asyncio.to_thread(_detect_objects_sync, image_path, confidence_threshold)

def detect_and_track(
    frame_paths: List[str],
    confidence_threshold: float = 0.4,
    tracker: str = "bytetrack.yaml",
    best_per_track: bool = False,
) -> List[Dict[str, Any]]:
    """
    연속 프레임에 대해 트래킹 결과를 반환.
    - best_per_track=False(기본): 프레임별 후보 전체
    - best_per_track=True: track_id별 대표 1개(최고 탐지 confidence)
    반환: [ {"track_id": int, "label": str, "bbox": [...], "image_path": str, "confidence": float}, ... ]
    """
    if not frame_paths:
        return []
    if FRONTEND_MODEL_MODE:
        return []
    try:
        model = get_model()
    except Exception:
        return []
    # track_id -> (best_confidence, image_path, bbox, label, class_id)
    best_by_track: Dict[int, tuple] = {}
    all_rows: List[Dict[str, Any]] = []
    for image_path in frame_paths:
        # track() 사용 시 id가 result.obb.id 또는 result.boxes.id에 올 수 있음
        results = model.track(
            image_path,
            verbose=False,
            device=YOLO_DEVICE,
            iou=0.5,
            tracker=tracker,
            persist=True,
        )
        for result in results:
            obb = getattr(result, "obb", None)
            ids = getattr(result, "boxes", None)
            track_ids = ids.id if (ids is not None and hasattr(ids, "id") and ids.id is not None) else None
            if obb is None or obb.xyxyxyxy is None:
                boxes = getattr(result, "boxes", None)
                if boxes is None:
                    continue
                for i, box in enumerate(boxes):
                    conf = float(box.conf[0])
                    tid = int(track_ids[i]) if track_ids is not None else i
                    cls_id = int(box.cls[0])
                    label = DETECTION_CLASSES.get(cls_id, f"class_{cls_id}")
                    min_conf = get_label_confidence_threshold(label, fallback=confidence_threshold)
                    if conf < min_conf:
                        continue
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    bbox = [int(x1), int(y1), int(x2), int(y1), int(x2), int(y2), int(x1), int(y2)]
                    row = {
                        "track_id": tid,
                        "label": label,
                        "bbox": bbox,
                        "image_path": image_path,
                        "confidence": round(conf, 4),
                        "class_id": cls_id,
                    }
                    all_rows.append(row)
                    if tid not in best_by_track or conf > best_by_track[tid][0]:
                        best_by_track[tid] = (conf, image_path, bbox, label, cls_id)
                continue
            for i in range(len(obb.conf)):
                conf = float(obb.conf[i])
                tid = int(obb.id[i]) if (hasattr(obb, "id") and obb.id is not None) else i
                cls_id = int(obb.cls[i])
                label = DETECTION_CLASSES.get(cls_id, f"class_{cls_id}")
                min_conf = get_label_confidence_threshold(label, fallback=confidence_threshold)
                if conf < min_conf:
                    continue
                pts = obb.xyxyxyxy[i].flatten().tolist()
                bbox = [int(round(x)) for x in pts]
                row = {
                    "track_id": tid,
                    "label": label,
                    "bbox": bbox,
                    "image_path": image_path,
                    "confidence": round(conf, 4),
                    "class_id": cls_id,
                }
                all_rows.append(row)
                if tid not in best_by_track or conf > best_by_track[tid][0]:
                    best_by_track[tid] = (conf, image_path, bbox, label, cls_id)
    if not best_per_track:
        return all_rows
    out = []
    for track_id, (conf, image_path, bbox, label, cls_id) in best_by_track.items():
        out.append({
            "track_id": track_id,
            "label": label,
            "bbox": bbox,
            "image_path": image_path,
            "confidence": round(conf, 4),
            "class_id": cls_id,
        })
    return out