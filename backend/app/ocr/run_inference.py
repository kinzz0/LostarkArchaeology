"""
프레임으로 스캔 결과·행동 추론, double_potion 감지 여부 추론.
게이지 소모량은 OCR 대신 규칙 기반으로 계산:
- action_type == "normal" 이고 double_potion 존재: 360 (180 * 2)
- action_type == "normal" 이고 double_potion 없음: 180 (180 * 1)
"""
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# 스캔: common(0), uncommon(1) / 행동: normal(2), chest(3), mini(4) / 게이지: gauge(5)
SCAN_LABELS = {"common", "uncommon"}
ACTION_LABELS = {"normal", "chest", "mini"}
DOUBLE_POTION_LABEL = "double_potion"
NORMAL_GAUGE_BASE = 180

# 프레임 샘플 최대 개수 (스캔·행동 추론 시)
MAX_FRAMES_FOR_SCAN_ACTION = 8


def _accumulate_scan_counts_from_detections(detections: List[Dict[str, Any]], scan_counts: Counter) -> None:
    """infer_scan_and_action_from_frames와 동일: SCAN_LABELS 박스마다 카운트 +1."""
    for d in detections:
        label = (d.get("label") or "").strip()
        if label in SCAN_LABELS:
            scan_counts[label] += 1


def scan_result_and_confidence_from_detections(
    detections: List[Dict[str, Any]],
) -> Tuple[Optional[str], Optional[float]]:
    """
    단일 프레임 탐지 결과에서 스캔(common/uncommon)을 고른다.
    집계 방식은 ``infer_scan_and_action_from_frames`` 한 프레임분과 동일(다수결 = 박스 개수).

    반환된 라벨에 해당하는 박스들 중 confidence 최대값을 scan_confidence로 준다.
    """
    scan_counts: Counter = Counter()
    _accumulate_scan_counts_from_detections(detections, scan_counts)
    if not scan_counts:
        return None, None
    scan_result = scan_counts.most_common(1)[0][0]
    confs: List[float] = []
    for d in detections:
        if (d.get("label") or "").strip() != scan_result:
            continue
        try:
            confs.append(float(d.get("confidence") or 0.0))
        except (TypeError, ValueError):
            pass
    scan_conf = round(max(confs), 4) if confs else None
    return scan_result, scan_conf


def _pick_best_scan_path_from_cached_dets(
    dets_by_path: Dict[str, List[Dict[str, Any]]],
    scan_result: Optional[str],
    paths_to_use: List[str],
    frame_paths: List[str],
) -> Optional[str]:
    """
    샘플 프레임별 탐지 결과(dict)로부터 스캔 참고용 대표 프레임 경로를 고른다.
    (기존 `_pick_best_scan_frame_path`와 동일 규칙, 단 탐지는 이미 수행된 dict를 사용)
    """
    if not dets_by_path:
        return paths_to_use[0] if paths_to_use else (frame_paths[0] if frame_paths else None)
    best_path: Optional[str] = None
    best_conf = -1.0
    for path, dets in dets_by_path.items():
        for d in dets:
            label = (d.get("label") or "").strip()
            if label not in SCAN_LABELS:
                continue
            if scan_result in SCAN_LABELS and label != scan_result:
                continue
            conf = float(d.get("confidence") or 0.0)
            if conf > best_conf:
                best_conf = conf
                best_path = path
    if best_path is not None:
        return best_path
    return paths_to_use[0] if paths_to_use else (frame_paths[0] if frame_paths else None)


def pick_best_scan_bbox_for_label(
    detections: List[Dict[str, Any]],
    scan_label: Optional[str],
) -> Optional[List[Any]]:
    """
    common 또는 uncommon 중 ``scan_label``과 일치하는 박스만 골라 confidence 최대 1개의 bbox(OBB 8점) 반환.
    """
    if not scan_label or scan_label not in SCAN_LABELS:
        return None
    best_conf = -1.0
    best_bbox = None
    for d in detections:
        lab = (d.get("label") or "").strip()
        if lab != scan_label:
            continue
        try:
            conf = float(d.get("confidence") or 0.0)
        except (TypeError, ValueError):
            conf = 0.0
        bbox = d.get("bbox")
        if bbox and len(bbox) >= 8 and conf > best_conf:
            best_conf = conf
            best_bbox = bbox
    return best_bbox


async def infer_scan_and_action_from_frames(
    frame_paths: List[str],
    max_frames: int = MAX_FRAMES_FOR_SCAN_ACTION,
    confidence_threshold: float = 0.4,
    action_hint: Optional[str] = None,
    scan_hint: Optional[str] = None,
    dets_by_path_cache: Optional[Dict[str, List[Dict[str, Any]]]] = None,
) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[List[Any]]]:
    """
    프레임들에 대해 탐지 결과(프론트 ONNX → 파이프라인 캐시)로 스캔·행동을 추론.

    - ``dets_by_path_cache``: ``track_ocr_pipeline`` 첫 패스에서 채운 프레임별 탐지 목록.
      캐시에 없는 경로는 빈 탐지로 간주한다(백엔드 YOLO 없음).
    - ``scan_hint`` / ``action_hint``가 유효하면 해당 축 추론 루프를 생략할 수 있다.
      둘 다 유효하면 스캔 bbox용으로만 탐지 1회(또는 캐시 히트 시 생략).

    반환: (scan_label, action_label, best_scan_frame_path, scan_bbox_for_crop or None)
    ``scan_bbox_for_crop`` 은 확정 스캔 라벨(common/uncommon)에 해당하는 박스 1개(OBB 8점)로, 참고 이미지 크롭용.
    """
    if not frame_paths:
        return None, None, None, None

    use_action_hint = action_hint in ACTION_LABELS
    raw_scan = (scan_hint or "").strip() if scan_hint is not None else ""
    use_scan_hint = raw_scan in SCAN_LABELS

    step = max(1, len(frame_paths) // max_frames) if len(frame_paths) > max_frames else 1
    indices = list(range(0, len(frame_paths), step))[:max_frames]
    paths_to_use = [frame_paths[i] for i in indices]

    scan_result: Optional[str] = raw_scan if use_scan_hint else None
    action_type: Optional[str] = action_hint if use_action_hint else None

    # 스캔·행동 모두 힌트로 확정 가능 → 스캔 참고 크롭용 bbox만 필요 (캐시 또는 1회 탐지)
    if use_scan_hint and use_action_hint:
        best_scan_path = paths_to_use[0] if paths_to_use else frame_paths[0]
        best_scan_bbox: Optional[List[Any]] = None
        if (
            best_scan_path
            and Path(best_scan_path).exists()
            and scan_result in SCAN_LABELS
        ):
            try:
                if dets_by_path_cache is not None and best_scan_path in dets_by_path_cache:
                    dets_one = dets_by_path_cache[best_scan_path]
                else:
                    dets_one = []
                best_scan_bbox = pick_best_scan_bbox_for_label(dets_one, scan_result)
            except Exception:
                best_scan_bbox = None
        return scan_result, action_type, best_scan_path, best_scan_bbox

    scan_counts = Counter()
    action_counts = Counter()
    first_action_type: Optional[str] = None
    dets_by_path: Dict[str, List[Dict[str, Any]]] = {}

    for path in paths_to_use:
        try:
            if dets_by_path_cache is not None and path in dets_by_path_cache:
                dets = dets_by_path_cache[path]
            else:
                dets = []
            dets_by_path[path] = dets
        except Exception:
            continue
        if not use_scan_hint:
            _accumulate_scan_counts_from_detections(dets, scan_counts)
        if not use_action_hint:
            for d in dets:
                label = (d.get("label") or "").strip()
                if label in ACTION_LABELS:
                    action_counts[label] += 1
                    if first_action_type is None:
                        first_action_type = label

    if not use_scan_hint:
        scan_result = scan_counts.most_common(1)[0][0] if scan_counts else None

    if use_action_hint:
        action_type = action_hint
    else:
        action_type = (
            first_action_type
            if first_action_type is not None
            else (action_counts.most_common(1)[0][0] if action_counts else None)
        )

    best_scan_path = _pick_best_scan_path_from_cached_dets(dets_by_path, scan_result, paths_to_use, frame_paths)
    dets_at_best: List[Dict[str, Any]] = []
    if best_scan_path:
        dets_at_best = dets_by_path.get(best_scan_path) or []
    best_scan_bbox = pick_best_scan_bbox_for_label(dets_at_best, scan_result)
    return scan_result, action_type, best_scan_path, best_scan_bbox


async def infer_double_potion_from_frames(
    frame_paths: List[str],
    max_frames: int = MAX_FRAMES_FOR_SCAN_ACTION,
    confidence_threshold: float = 0.4,
    dets_by_path_cache: Optional[Dict[str, List[Dict[str, Any]]]] = None,
) -> bool:
    """샘플 프레임들에서 double_potion 라벨 존재 여부. 캐시에 없는 경로는 탐지 없음으로 간주."""
    if not frame_paths:
        return False
    step = max(1, len(frame_paths) // max_frames) if len(frame_paths) > max_frames else 1
    indices = list(range(0, len(frame_paths), step))[:max_frames]
    paths_to_use = [frame_paths[i] for i in indices]

    for path in paths_to_use:
        try:
            if dets_by_path_cache is not None and path in dets_by_path_cache:
                dets = dets_by_path_cache[path]
            else:
                dets = []
            for d in dets:
                label = (d.get("label") or "").strip()
                if label == DOUBLE_POTION_LABEL:
                    return True
        except Exception:
            continue
    return False


def infer_gauge_consumed_by_rules(action_type: Optional[str], has_double_potion: bool) -> Optional[int]:
    """
    게이지 소모량 규칙:
    - normal + double_potion: 360
    - normal + no double_potion: 180
    - 그 외 행동(chest/mini/미추론): 미추론(None)
    """
    if action_type != "normal":
        return None
    multiplier = 2 if has_double_potion else 1
    return NORMAL_GAUGE_BASE * multiplier
