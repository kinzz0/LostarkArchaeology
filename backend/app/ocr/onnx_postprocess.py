"""
YOLO ONNX raw 출력(float32) + letterbox meta → 박스·라벨·점수 (참고·테스트용).

운영 탐지는 `app.ocr.detector`(Ultralytics)를 사용한다.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

# detection-classes.js / app.config.DETECTION_CLASSES 순서와 동기화
DETECTION_CLASS_NAMES: Tuple[str, ...] = (
    "common",
    "uncommon",
    "normal",
    "chest",
    "mini",
    "gauge",
    "chat",
    "skill_on",
    "skill_off",
    "skill_popup",
    "common_item",
    "uncommon_item",
    "rare_item",
    "double_potion",
    "action_gauge",
)

CONFIDENCE_THRESHOLDS: Dict[str, float] = {
    "common": 0.7,
    "uncommon": 0.7,
    "normal": 0.6,
    "chest": 0.5,
    "mini": 0.8,
    "gauge": 0.8,
    "chat": 0.9,
    "skill_on": 0.9,
    "skill_off": 0.9,
    "skill_popup": 0.9,
    "common_item": 0.75,
    "uncommon_item": 0.75,
    "rare_item": 0.75,
    "double_potion": 0.8,
    "action_gauge": 0.8,
}


def _sigmoid(x: float) -> float:
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    z = math.exp(x)
    return z / (1.0 + z)


def _xywh2xyxy(cx: float, cy: float, w: float, h: float) -> Tuple[float, float, float, float]:
    hw, hh = w / 2, h / 2
    return cx - hw, cy - hh, cx + hw, cy + hh


def _xywhr_to_flat_corners(cx: float, cy: float, w: float, h: float, angle_rad: float) -> List[float]:
    cos_t = math.cos(angle_rad)
    sin_t = math.sin(angle_rad)
    w2, h2 = w / 2, h / 2
    v1x, v1y = w2 * cos_t, w2 * sin_t
    v2x, v2y = -h2 * sin_t, h2 * cos_t
    p1x, p1y = cx + v1x + v2x, cy + v1y + v2y
    p2x, p2y = cx + v1x - v2x, cy + v1y - v2y
    p3x, p3y = cx - v1x - v2x, cy - v1y - v2y
    p4x, p4y = cx - v1x + v2x, cy - v1y + v2y
    return [p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y]


def _decode_obb_angle(raw_logit: float) -> float:
    return (_sigmoid(raw_logit) - 0.25) * math.pi


def _iou_aabb(a: List[float], b: List[float]) -> float:
    xx1 = max(a[0], b[0])
    yy1 = max(a[1], b[1])
    xx2 = min(a[2], b[2])
    yy2 = min(a[3], b[3])
    iw = max(0.0, xx2 - xx1)
    ih = max(0.0, yy2 - yy1)
    inter = iw * ih
    a1 = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    a2 = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = a1 + a2 - inter
    return inter / union if union > 0 else 0.0


def _nms_aabb_class_aware(
    boxes: List[List[float]],
    scores: List[float],
    class_ids: List[int],
    iou_thresh: float,
    max_det: int,
    max_wh: float = 7680.0,
) -> List[int]:
    n = len(boxes)
    order = sorted(range(n), key=lambda i: scores[i], reverse=True)
    suppressed = [False] * n
    picked: List[int] = []
    for idx in order:
        if suppressed[idx]:
            continue
        picked.append(idx)
        if len(picked) >= max_det:
            break
        bi = boxes[idx]
        ci = class_ids[idx] * max_wh
        bi_off = [bi[0] + ci, bi[1] + ci, bi[2] + ci, bi[3] + ci]
        for j in range(n):
            if j == idx or suppressed[j]:
                continue
            if class_ids[j] != class_ids[idx]:
                continue
            bj = [
                boxes[j][0] + class_ids[j] * max_wh,
                boxes[j][1] + class_ids[j] * max_wh,
                boxes[j][2] + class_ids[j] * max_wh,
                boxes[j][3] + class_ids[j] * max_wh,
            ]
            if _iou_aabb(bi_off, bj) > iou_thresh:
                suppressed[j] = True
    return picked


def _aabb_from_corners8(c: List[float]) -> List[float]:
    xs = [c[0], c[2], c[4], c[6]]
    ys = [c[1], c[3], c[5], c[7]]
    return [min(xs), min(ys), max(xs), max(ys)]


def _unletterbox_corners(flat8: List[float], meta: Dict[str, Any]) -> List[int]:
    r = float(meta["r"])
    dw = float(meta["dw"])
    dh = float(meta["dh"])
    orig_w = int(meta["origW"])
    orig_h = int(meta["origH"])
    out: List[int] = []
    for k in range(0, 8, 2):
        x = (flat8[k] - dw) / r
        y = (flat8[k + 1] - dh) / r
        out.append(int(round(max(0, min(orig_w, x)))))
        out.append(int(round(max(0, min(orig_h, y)))))
    return out


def _label_for_class_id(class_id: int) -> str:
    cid = int(math.floor(float(class_id)))
    if 0 <= cid < len(DETECTION_CLASS_NAMES):
        return DETECTION_CLASS_NAMES[cid]
    return f"class_{cid}"


def _min_confidence_for_label(label: str, fallback: float) -> float:
    v = CONFIDENCE_THRESHOLDS.get(label)
    return float(v) if isinstance(v, (int, float)) else fallback


def _parse_end_to_end_bcn(pred: np.ndarray, meta: Dict[str, Any], conf_fallback: float) -> List[Dict[str, Any]]:
    if pred.ndim != 3 or pred.shape[0] != 1:
        return []
    d1, d2 = int(pred.shape[1]), int(pred.shape[2])
    if d2 <= 16 and d1 > d2:
        num, fields = d1, d2

        def getv(i: int, f: int) -> float:
            return float(pred[0, i, f])

    elif d1 <= 16 and d2 > d1:
        num, fields = d2, d1

        def getv(i: int, f: int) -> float:
            return float(pred[0, f, i])

    else:
        return []
    if fields < 6:
        return []

    max_v = 0.0
    for i in range(min(num, 50)):
        for f in range(min(4, fields)):
            max_v = max(max_v, abs(getv(i, f)))
    maybe_norm = max_v <= 1.5

    in_w = int(meta["inW"])
    in_h = int(meta["inH"])
    orig_w = int(meta["origW"])
    orig_h = int(meta["origH"])
    r = float(meta["r"])
    dw = float(meta["dw"])
    dh = float(meta["dh"])
    meta_full = {"r": r, "dw": dw, "dh": dh, "origW": orig_w, "origH": orig_h, "inW": in_w, "inH": in_h}

    candidates: List[Dict[str, Any]] = []
    for i in range(num):
        x1 = getv(i, 0)
        y1 = getv(i, 1)
        x2 = getv(i, 2)
        y2 = getv(i, 3)
        conf = getv(i, 4)
        cls = getv(i, 5)
        if not (conf > 0):
            continue
        if maybe_norm:
            x1 *= in_w
            y1 *= in_h
            x2 *= in_w
            y2 *= in_h
        flat_lb = [x1, y1, x2, y1, x2, y2, x1, y2]
        class_id = int(round(cls))
        label = _label_for_class_id(class_id)
        th = _min_confidence_for_label(label, conf_fallback)
        if conf < th:
            continue
        aabb_net = _aabb_from_corners8(flat_lb)
        candidates.append(
            {
                "label": label,
                "confidence": round(conf * 10000) / 10000,
                "class_id": class_id,
                "obb": True,
                "_aabb": aabb_net,
                "_cls": class_id,
                "_flat_lb": flat_lb,
            }
        )
    if not candidates:
        return []
    boxes = [c["_aabb"] for c in candidates]
    scores = [float(c["confidence"]) for c in candidates]
    class_ids = [int(c["_cls"]) for c in candidates]
    keep = _nms_aabb_class_aware(boxes, scores, class_ids, 0.45, 300)
    out: List[Dict[str, Any]] = []
    for k in keep:
        c = candidates[k]
        bbox = _unletterbox_corners(c["_flat_lb"], meta_full)
        out.append(
            {
                "label": c["label"],
                "confidence": c["confidence"],
                "bbox": bbox,
                "class_id": c["class_id"],
                "obb": True,
            }
        )
    return out


def _parse_yolo_bcn_raw(
    pred: np.ndarray,
    meta: Dict[str, Any],
    conf_fallback: float,
    fixed_nc: Optional[int] = None,
) -> List[Dict[str, Any]]:
    if pred.ndim != 3 or pred.shape[0] != 1:
        return []
    d1, d2 = int(pred.shape[1]), int(pred.shape[2])
    if d1 <= d2:
        C, N = d1, d2

        def at(ch: int, i: int) -> float:
            return float(pred[0, ch, i])

    else:
        C, N = d2, d1

        def at(ch: int, i: int) -> float:
            return float(pred[0, i, ch])

    nc = fixed_nc if fixed_nc is not None else len(DETECTION_CLASS_NAMES)
    extra = C - 4 - nc
    if extra < 0:
        alt_nc = C - 4
        if alt_nc < 1:
            return []
        return _parse_yolo_bcn_raw(pred, meta, conf_fallback, alt_nc)

    in_w = int(meta["inW"])
    in_h = int(meta["inH"])
    orig_w = int(meta["origW"])
    orig_h = int(meta["origH"])
    r = float(meta["r"])
    dw = float(meta["dw"])
    dh = float(meta["dh"])
    meta_full = {"r": r, "dw": dw, "dh": dh, "origW": orig_w, "origH": orig_h, "inW": in_w, "inH": in_h}

    candidates: List[Dict[str, Any]] = []
    for i in range(N):
        best_score = 0.0
        best_cls = 0
        for c in range(nc):
            v = _sigmoid(at(4 + c, i))
            if v > best_score:
                best_score = v
                best_cls = c
        label = _label_for_class_id(best_cls)
        th = _min_confidence_for_label(label, conf_fallback)
        if best_score < th:
            continue

        cx = at(0, i)
        cy = at(1, i)
        bw = at(2, i)
        bh = at(3, i)
        if extra >= 1:
            angle_raw = at(4 + nc, i)
            angle = _decode_obb_angle(angle_raw)
            flat8 = _xywhr_to_flat_corners(cx, cy, bw, bh, angle)
        else:
            x1, y1, x2, y2 = _xywh2xyxy(cx, cy, bw, bh)
            flat8 = [x1, y1, x2, y1, x2, y2, x1, y2]
        bbox = _unletterbox_corners(flat8, meta_full)
        aabb_net = _aabb_from_corners8(flat8)
        candidates.append(
            {
                "label": label,
                "confidence": round(best_score * 10000) / 10000,
                "bbox": bbox,
                "class_id": best_cls,
                "obb": True,
                "_aabb": aabb_net,
                "_cls": best_cls,
            }
        )

    if not candidates:
        return []
    boxes = [c["_aabb"] for c in candidates]
    scores = [float(c["confidence"]) for c in candidates]
    class_ids = [int(c["_cls"]) for c in candidates]
    keep = _nms_aabb_class_aware(boxes, scores, class_ids, 0.45, 300)
    out: List[Dict[str, Any]] = []
    for k in keep:
        c = candidates[k]
        out.append(
            {
                "label": c["label"],
                "confidence": c["confidence"],
                "bbox": c["bbox"],
                "class_id": c["class_id"],
                "obb": c["obb"],
            }
        )
    return out


def detections_from_raw_prediction(
    pred: np.ndarray,
    meta: Dict[str, Any],
    conf_fallback: float = 0.5,
) -> List[Dict[str, Any]]:
    """
    pred: float32, shape (1, d1, d2) — 프론트 pickMainOutput 과 동일 텐서.
    meta: r, dw, dh, origW, origH, inW, inH (숫자)
    """
    if pred.dtype != np.float32:
        pred = pred.astype(np.float32, copy=False)
    if pred.ndim != 3 or pred.shape[0] != 1:
        return []
    a, b = int(pred.shape[1]), int(pred.shape[2])
    fields = min(a, b)
    num = max(a, b)
    if 6 <= fields <= 12 and num <= 500:
        e2e = _parse_end_to_end_bcn(pred, meta, conf_fallback)
        if e2e:
            return e2e
    return _parse_yolo_bcn_raw(pred, meta, conf_fallback, None)


def detections_from_onnx_frame_payload(
    item: Dict[str, Any],
    conf_fallback: float = 0.5,
) -> List[Dict[str, Any]]:
    """
    프론트가 보낸 단일 프레임 객체:
    { "meta": {...}, "pred_dims": [1,C,N], "pred_data_b64": "..." }
    """
    import base64

    meta = item.get("meta")
    if not isinstance(meta, dict):
        return []
    dims = item.get("pred_dims")
    b64 = item.get("pred_data_b64")
    if not isinstance(dims, list) or not isinstance(b64, str):
        return []
    if not dims or not b64:
        return []
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return []
    try:
        arr = np.frombuffer(raw, dtype=np.float32)
        shape = tuple(int(x) for x in dims)
        need = int(np.prod(shape))
        if arr.size != need:
            return []
        pred = arr.reshape(shape)
    except Exception:
        return []
    return detections_from_raw_prediction(pred, meta, conf_fallback=conf_fallback)
