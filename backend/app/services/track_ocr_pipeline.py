"""
트랙-OCR 백그라운드 파이프라인: 프레임 저장·YOLO 트래킹·OCR·스캔/행동 추론·결과 JSON.
라우터(`routers/capture.py`)는 엔드포인트만 두고 이 모듈을 호출한다.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import uuid
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import aiofiles
import cv2

from app.config import (
    ALLOWED_EXTENSIONS,
    OCR_TARGET_LABELS,
    TRACK_OCR_DIR,
    TRACK_OCR_RESULTS_FILE,
)
from app.ocr.detector import detect_objects
from app.ocr.preprocessor import crop_obb_region
from app.ocr.processor import ocr_on_tracked_data
from app.ocr.run_inference import (
    ACTION_LABELS,
    infer_double_potion_from_frames,
    infer_gauge_consumed_by_rules,
    infer_scan_and_action_from_frames,
)

# 1/true/on 이면 매 run마다 아이템 라벨 디버그 JSON 저장 (TRACK_OCR_ITEM_LABEL_DEBUG=0 으로 끔)
TRACK_OCR_ITEM_LABEL_DEBUG_ENABLED = os.getenv("TRACK_OCR_ITEM_LABEL_DEBUG", "1").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

TRACK_OCR_JOB_TTL_SECONDS = 60 * 60
TRACK_OCR_JOBS: Dict[str, Dict[str, Any]] = {}
TRACK_OCR_TOPN_PER_TRACK_DEFAULT = 1
TRACK_OCR_TOPN_PER_TRACK_MINI = 5
TRACK_OCR_FALLBACK_EXTRA_PER_TRACK = 4
TRACK_OCR_INFER_MAX_FRAMES_DEFAULT = 8
TRACK_OCR_INFER_MAX_FRAMES_WITH_HINT = 5
PERF_LOG_ENABLED = True
ITEM_REFINE_PREV_WINDOW = 4


def _first_pass_detect_stride() -> int:
    """
    첫 패스 YOLO 호출 간격. 1=매 프레임, 2=격프레임만 탐지 → track_ms 대략 절반.
    한 프레임만 깜빡이는 UI는 놓칠 수 있음. 환경변수 TRACK_OCR_FIRST_PASS_STRIDE (기본 1).
    """
    try:
        v = int(os.getenv("TRACK_OCR_FIRST_PASS_STRIDE", "1").strip())
    except ValueError:
        return 1
    return max(1, v)


def _count_rows_by_label(rows: List[Dict[str, Any]]) -> Dict[str, int]:
    c: Counter = Counter()
    for r in rows:
        lab = str(r.get("label") or "").strip() or "(empty)"
        c[lab] += 1
    return dict(c)


def _count_ocr_target_rows_missing_track_id(rows: List[Dict[str, Any]]) -> Dict[str, int]:
    c: Counter = Counter()
    for r in rows:
        if r.get("track_id") is not None:
            continue
        lab = str(r.get("label") or "").strip() or "(empty)"
        c[lab] += 1
    return dict(c)


def _unique_track_ids_by_label(rows: List[Dict[str, Any]]) -> Dict[str, List[int]]:
    m: Dict[str, set] = defaultdict(set)
    for r in rows:
        tid = r.get("track_id")
        if tid is None:
            continue
        lab = str(r.get("label") or "").strip() or "(empty)"
        m[lab].add(int(tid))
    return {k: sorted(v) for k, v in sorted(m.items())}


def _has_readable_ocr_number(x: Dict[str, Any]) -> int:
    num = x.get("ocr_number")
    if num is None:
        return 0
    s = str(num).strip()
    return 1 if s.isdigit() else 0


def _obb_center_xy(bbox: Any) -> Optional[tuple]:
    if not isinstance(bbox, (list, tuple)) or len(bbox) < 8:
        return None
    try:
        xs = [float(bbox[i]) for i in range(0, 8, 2)]
        ys = [float(bbox[i]) for i in range(1, 8, 2)]
        return (sum(xs) / 4.0, sum(ys) / 4.0)
    except Exception:
        return None


def _crop_sharpness_score(image_path: str, bbox: Any) -> float:
    """
    크롭 내부의 Laplacian 분산으로 선명도 점수를 계산한다.
    숫자/획이 찌그러지는 마지막 프레임을 피하기 위한 보조 지표.
    """
    try:
        crop = crop_obb_region(str(image_path), bbox)
        if crop is None or crop.size == 0:
            return 0.0
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())
    except Exception:
        return 0.0


def _write_track_ocr_item_label_debug(
    run_id: str,
    created_at: str,
    action_hint: Optional[str],
    saved_paths: List[str],
    tracked_all: List[Dict[str, Any]],
    tracked_candidates: List[Dict[str, Any]],
    with_ocr: List[Dict[str, Any]],
    grouped_with_ocr_by_track: Optional[Dict[int, List[Dict[str, Any]]]] = None,
) -> Optional[str]:
    if not TRACK_OCR_ITEM_LABEL_DEBUG_ENABLED:
        return None

    labels_all_rows = _count_rows_by_label(tracked_all)
    non_target_rows = [t for t in tracked_all if t.get("label") not in OCR_TARGET_LABELS]
    labels_non_target_rows = _count_rows_by_label(non_target_rows)
    labels_candidate_rows = _count_rows_by_label(tracked_candidates)
    missing_tid = _count_ocr_target_rows_missing_track_id(tracked_candidates)
    tracks_by_label = _unique_track_ids_by_label(tracked_candidates)
    item_labels = ["common_item", "uncommon_item", "rare_item"]
    item_counts_before_filter = {k: int(labels_all_rows.get(k, 0)) for k in item_labels}
    item_counts_after_filter = {k: int(labels_candidate_rows.get(k, 0)) for k in item_labels}

    final_items = []
    for it in with_ocr:
        final_items.append(
            {
                "track_id": it.get("track_id"),
                "label": it.get("label"),
                "ocr_number": it.get("ocr_number"),
                "ocr_text": it.get("ocr_text"),
                "detection_confidence": it.get("confidence"),
                "ocr_confidence": it.get("ocr_confidence"),
            }
        )
    final_label_counts: Counter = Counter(str(x.get("label") or "").strip() or "(empty)" for x in with_ocr)

    absent_in_final: List[str] = []
    for lab in sorted(OCR_TARGET_LABELS):
        if labels_candidate_rows.get(lab, 0) > 0 and final_label_counts.get(lab, 0) == 0:
            absent_in_final.append(lab)

    final_by_track: Dict[int, Dict[str, Any]] = {}
    for it in with_ocr:
        tid = it.get("track_id")
        if tid is None:
            continue
        final_by_track[int(tid)] = it

    per_track_selection_debug: List[Dict[str, Any]] = []
    labels_present_but_lost_by_track: Counter = Counter()
    grouped_src = grouped_with_ocr_by_track or {}
    for track_id in sorted(grouped_src.keys()):
        candidates = list(grouped_src.get(track_id) or [])
        if not candidates:
            continue
        candidates.sort(
            key=lambda x: (
                _has_readable_ocr_number(x),
                float(x.get("ocr_confidence") or 0.0),
                float(x.get("confidence") or 0.0),
            ),
            reverse=True,
        )
        selected = final_by_track.get(track_id)
        selected_label = str(selected.get("label") or "").strip() if selected else None
        label_counts: Counter = Counter(str(c.get("label") or "").strip() or "(empty)" for c in candidates)
        present_labels = sorted([lab for lab in label_counts.keys() if lab])

        losing_labels: List[str] = []
        if selected_label:
            losing_labels = [lab for lab in present_labels if lab != selected_label]
            for lab in losing_labels:
                labels_present_but_lost_by_track[lab] += 1

        candidate_rows = []
        for c in candidates:
            candidate_rows.append(
                {
                    "label": c.get("label"),
                    "ocr_number": c.get("ocr_number"),
                    "ocr_text": c.get("ocr_text"),
                    "has_readable_number": _has_readable_ocr_number(c),
                    "ocr_confidence": float(c.get("ocr_confidence") or 0.0),
                    "detection_confidence": float(c.get("confidence") or 0.0),
                }
            )

        per_track_selection_debug.append(
            {
                "track_id": track_id,
                "candidate_count": len(candidates),
                "candidate_label_counts": dict(label_counts),
                "selected_label": selected_label,
                "labels_present_but_not_selected_same_track": losing_labels,
                "not_selected_reason_ko": (
                    "동일 track 내 후보 정렬(숫자 읽힘 > OCR 신뢰도 > 탐지 신뢰도)에서 밀림"
                    if losing_labels
                    else None
                ),
                "candidate_rows_sorted_by_selection_rule": candidate_rows,
            }
        )

    summary_lines = [
        f"run_id={run_id}",
        f"프레임 수: {len(saved_paths)}",
        f"[1] detect_and_track 전체 검출 행 수: {len(tracked_all)} → 라벨별 행 수: {labels_all_rows}",
        f"[2] OCR_TARGET({sorted(OCR_TARGET_LABELS)}) 밖이라 파이프라인에서 제외된 행: {len(non_target_rows)} → {labels_non_target_rows}",
        f"[3] OCR 대상 후보(tracked_candidates) 행 수: {len(tracked_candidates)} → 라벨별 행 수: {labels_candidate_rows}",
        f"[3-1] item(필터 전) 건수: {item_counts_before_filter}",
        f"[3-2] item(필터 후) 건수: {item_counts_after_filter}",
        f"[4] 후보 중 track_id 없음(트래커 미할당, 이후 그룹에서 제외됨): {missing_tid}",
        f"[5] 후보에서 라벨별 유니크 track_id: {tracks_by_label}",
        f"[6] 최종 결과(with_ocr) 줄 수: {len(with_ocr)} → 라벨별 줄 수: {dict(final_label_counts)}",
    ]
    if absent_in_final:
        summary_lines.append(
            f"[주의] 후보에는 검출 행이 있었으나 최종 줄에는 해당 라벨이 없음: {absent_in_final} "
            f"(원인 후보: track_id 전부 None, 또는 동일 track이 다른 라벨 후보로만 채택 등)"
        )
    if labels_present_but_lost_by_track:
        summary_lines.append(
            "[추가] 동일 track 내 후보에는 있었지만 최종 라벨로는 선택되지 않은 라벨(트랙 단위 누적): "
            f"{dict(labels_present_but_lost_by_track)}"
        )

    payload: Dict[str, Any] = {
        "run_id": run_id,
        "created_at": created_at,
        "action_hint": action_hint,
        "summary_ko": "\n".join(summary_lines),
        "frames_count": len(saved_paths),
        "step1_labels_all_detect_track_rows": labels_all_rows,
        "step2_excluded_not_in_ocr_target": {
            "row_count": len(non_target_rows),
            "labels": labels_non_target_rows,
        },
        "step3_ocr_target_candidates": {
            "row_count": len(tracked_candidates),
            "labels": labels_candidate_rows,
            "item_counts_before_filter": item_counts_before_filter,
            "item_counts_after_filter": item_counts_after_filter,
            "rows_missing_track_id_by_label": missing_tid,
            "unique_track_ids_by_label": tracks_by_label,
        },
        "step6_final_items": final_items,
        "step6_final_label_row_counts": dict(final_label_counts),
        "ocr_target_labels_in_candidates_but_absent_in_final": absent_in_final,
        "track_level_labels_present_but_not_selected": dict(labels_present_but_lost_by_track),
        "track_level_selection_debug": per_track_selection_debug,
    }

    debug_dir = TRACK_OCR_DIR / "debug"
    debug_dir.mkdir(parents=True, exist_ok=True)
    try:
        ts = datetime.fromisoformat(created_at).strftime("%Y%m%d_%H%M%S")
    except Exception:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{ts}_{run_id}_item_labels.json"
    out_path = debug_dir / filename
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return f"/static/track_ocr/debug/{filename}"


async def _save_scan_ocr_reference_images(
    _run_id: str,
    _best_scan_src_path: Optional[str],
    _scan_bbox: Optional[List[Any]] = None,
) -> Dict[str, Optional[str]]:
    """스캔 참고 이미지는 디스크에 저장하지 않음 (track_ocr/crops 만 유지)."""
    return {
        "scan_frame_image_url": None,
        "scan_ocr_processed_image_url": None,
    }


def _cleanup_old_jobs() -> None:
    now_ts = datetime.now().timestamp()
    expired = []
    for job_id, job in TRACK_OCR_JOBS.items():
        completed_at = job.get("completed_at")
        if not completed_at:
            continue
        try:
            completed_ts = datetime.fromisoformat(completed_at).timestamp()
        except Exception:
            continue
        if now_ts - completed_ts > TRACK_OCR_JOB_TTL_SECONDS:
            expired.append(job_id)
    for job_id in expired:
        TRACK_OCR_JOBS.pop(job_id, None)


def _write_item_only_frame_debug(
    *,
    run_id: str,
    created_at: str,
    saved_paths: List[str],
    tracked_all: List[Dict[str, Any]],
) -> Optional[str]:
    """
    item 3클래스(common_item/uncommon_item/rare_item)만 프레임별 카운트 디버그를 저장.
    스캔/행동 라벨은 제외해 혼동을 줄인다.
    """
    if not TRACK_OCR_ITEM_LABEL_DEBUG_ENABLED:
        return None

    item_labels = ["common_item", "uncommon_item", "rare_item"]
    path_to_rows: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in tracked_all:
        p = str(row.get("image_path") or "").strip()
        if not p:
            continue
        path_to_rows[p].append(row)

    frames: List[Dict[str, Any]] = []
    total_item_rows = 0
    for idx, p in enumerate(saved_paths):
        rows = path_to_rows.get(p, [])
        counts = {k: 0 for k in item_labels}
        for r in rows:
            lab = str(r.get("label") or "").strip()
            if lab in counts:
                counts[lab] += 1
                total_item_rows += 1
        item_sum = int(sum(counts.values()))
        frames.append(
            {
                "frame_index": idx,
                "image_path": p,
                "item_counts": counts,
                "item_row_count": item_sum,
                "has_item": item_sum > 0,
            }
        )

    payload = {
        "run_id": run_id,
        "created_at": created_at,
        "labels": item_labels,
        "frames_count": len(saved_paths),
        "total_item_rows": total_item_rows,
        "frames_with_item": int(sum(1 for f in frames if f["has_item"])),
        "frames": frames,
    }

    debug_dir = TRACK_OCR_DIR / "debug"
    debug_dir.mkdir(parents=True, exist_ok=True)
    try:
        ts = datetime.fromisoformat(created_at).strftime("%Y%m%d_%H%M%S")
    except Exception:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{ts}_{run_id}_item_only_frames.json"
    out_path = debug_dir / filename
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return f"/static/track_ocr/debug/{filename}"


def _write_non_item_frame_debug(
    *,
    run_id: str,
    created_at: str,
    saved_paths: List[str],
    tracked_all: List[Dict[str, Any]],
) -> Optional[str]:
    """
    item이 아닌 라벨(common/normal 등)이 프레임별로 얼마나 검출됐는지 저장.
    item이 0인데도 눈에 보이는 이유(다른 라벨로 검출) 확인용.
    """
    if not TRACK_OCR_ITEM_LABEL_DEBUG_ENABLED:
        return None

    path_to_rows: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in tracked_all:
        p = str(row.get("image_path") or "").strip()
        if p:
            path_to_rows[p].append(row)

    frames: List[Dict[str, Any]] = []
    for idx, p in enumerate(saved_paths):
        rows = path_to_rows.get(p, [])
        counts: Counter = Counter()
        for r in rows:
            lab = str(r.get("label") or "").strip()
            if lab and lab not in OCR_TARGET_LABELS:
                counts[lab] += 1
        frames.append(
            {
                "frame_index": idx,
                "image_path": p,
                "non_item_counts": dict(sorted(counts.items())),
                "non_item_row_count": int(sum(counts.values())),
            }
        )

    payload = {
        "run_id": run_id,
        "created_at": created_at,
        "purpose": "item 미검출 프레임에서 어떤 non-item 라벨이 잡혔는지 확인",
        "frames_count": len(saved_paths),
        "frames": frames,
    }
    debug_dir = TRACK_OCR_DIR / "debug"
    debug_dir.mkdir(parents=True, exist_ok=True)
    try:
        ts = datetime.fromisoformat(created_at).strftime("%Y%m%d_%H%M%S")
    except Exception:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{ts}_{run_id}_non_item_frames.json"
    out_path = debug_dir / filename
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return f"/static/track_ocr/debug/{filename}"


async def _process_track_and_ocr(
    saved_paths: List[str],
    run_id: str,
    action_hint: Optional[str] = None,
    has_double_potion_hint: Optional[bool] = None,
    scan_hint: Optional[str] = None,
    frontend_detections_by_frame: Optional[List[List[Dict[str, Any]]]] = None,
) -> Dict[str, Any]:
    t0_total = datetime.now().timestamp()
    # 1) action_gauge 이후 프레임 후보를 위해 프레임별 탐지(트래킹 미사용)
    t0 = datetime.now().timestamp()
    first_pass_stride = _first_pass_detect_stride()
    if frontend_detections_by_frame is not None:
        # 프론트가 프레임별 탐지 결과를 넘긴 경우, 누락 없이 그대로 사용한다.
        first_pass_stride = 1
    tracked_all: List[Dict[str, Any]] = []
    first_pass_detect_count = 0
    for frame_idx, image_path in enumerate(saved_paths):
        if frame_idx % first_pass_stride != 0:
            continue
        dets: List[Dict[str, Any]]
        if frontend_detections_by_frame and frame_idx < len(frontend_detections_by_frame):
            dets = frontend_detections_by_frame[frame_idx] or []
        else:
            dets = await detect_objects(image_path, confidence_threshold=0.5)
        first_pass_detect_count += 1
        for det_idx, d in enumerate(dets):
            tracked_all.append(
                {
                    **d,
                    "image_path": image_path,
                    # 트래킹을 쓰지 않으므로 프레임 기준 임시 식별자 부여
                    "track_id": int(frame_idx * 10000 + det_idx),
                }
            )
    track_ms = int((datetime.now().timestamp() - t0) * 1000)
    tracked_candidates = [t for t in tracked_all if t.get("label") in OCR_TARGET_LABELS]

    # 스캔/행동·도약 추론에서 YOLO 재호출 방지: 프레임별 탐지 결과를 경로 키로 재사용
    dets_by_path_cache: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in tracked_all:
        p = str(r.get("image_path") or "").strip()
        if not p:
            continue
        row = {k: v for k, v in r.items() if k not in ("image_path", "track_id")}
        dets_by_path_cache[p].append(row)
    dets_by_path_cache = dict(dets_by_path_cache)

    # 2) 새 매커니즘:
    # action_gauge 첫 검출 이후 프레임만 보고,
    # item이 처음 등장한 프레임 전까지 스킵한 뒤,
    # item 행 수가 가장 많은 프레임 1장을 선택해 그 프레임 item들만 OCR.
    path_to_rows: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in tracked_all:
        p = str(r.get("image_path") or "").strip()
        if p:
            path_to_rows[p].append(r)

    first_action_idx: Optional[int] = None
    for i, p in enumerate(saved_paths):
        rows = path_to_rows.get(p, [])
        if any(str(x.get("label") or "").strip() == "action_gauge" for x in rows):
            first_action_idx = i
            break
    scan_phase_paths = saved_paths if first_action_idx is None else saved_paths[first_action_idx:]

    first_item_idx: Optional[int] = None
    for i, p in enumerate(scan_phase_paths):
        rows = path_to_rows.get(p, [])
        if any(str(x.get("label") or "").strip() in OCR_TARGET_LABELS for x in rows):
            first_item_idx = i
            break

    item_phase_paths: List[str] = []
    if first_item_idx is not None:
        item_phase_paths = scan_phase_paths[first_item_idx:]

    best_item_frame_path: Optional[str] = None
    best_item_frame_rows: List[Dict[str, Any]] = []
    best_item_count = -1
    best_conf_sum = -1.0
    # 프레임 선택 점수(항상 적용):
    # score = item_count*100 + readable_number_count*80 + ocr_conf_sum*10 + det_conf_sum*5
    best_score = float("-inf")
    for p in item_phase_paths:
        rows = path_to_rows.get(p, [])
        item_rows = [x for x in rows if str(x.get("label") or "").strip() in OCR_TARGET_LABELS]
        if not item_rows:
            continue
        item_count = len(item_rows)
        det_conf_sum = float(sum(float(x.get("confidence") or 0.0) for x in item_rows))
        preview_with_ocr = await ocr_on_tracked_data(item_rows)
        readable_count = 0
        ocr_conf_sum = 0.0
        for it in preview_with_ocr:
            num = str(it.get("ocr_number") or "").strip()
            if num.isdigit():
                readable_count += 1
                ocr_conf_sum += float(it.get("ocr_confidence") or 0.0)
        score = (
            item_count * 100.0
            + readable_count * 80.0
            + ocr_conf_sum * 10.0
            + det_conf_sum * 5.0
        )
        if score > best_score:
            best_score = score
            best_item_frame_path = p
            best_item_frame_rows = item_rows
            best_item_count = item_count
            best_conf_sum = det_conf_sum

    selected_item_candidates: List[Dict[str, Any]] = []
    if best_item_frame_path and best_item_frame_rows:
        selected_item_candidates = sorted(
            best_item_frame_rows, key=lambda x: float(x.get("confidence") or 0.0), reverse=True
        )

    # 3) 아이템별 정밀 선택:
    # 대표 프레임을 고른 뒤, 해당 프레임의 각 아이템(anchor)에 대해
    # 이전 N프레임까지 같은 라벨/근접 위치 후보를 모아 OCR 품질(읽힘/신뢰도/선명도)로 재선정.
    frame_index_by_path = {p: i for i, p in enumerate(saved_paths)}
    best_frame_idx = frame_index_by_path.get(best_item_frame_path, -1) if best_item_frame_path else -1

    if best_item_frame_path and best_item_frame_rows and best_frame_idx >= 0:
        win_start = max(0, best_frame_idx - ITEM_REFINE_PREV_WINDOW)
        candidate_paths = saved_paths[win_start : best_frame_idx + 1]
        per_anchor_candidates: List[List[Dict[str, Any]]] = []

        for anchor in best_item_frame_rows:
            anchor_label = str(anchor.get("label") or "").strip()
            anchor_center = _obb_center_xy(anchor.get("bbox"))
            anchor_rows: List[Dict[str, Any]] = []

            for p in candidate_paths:
                rows = path_to_rows.get(p, [])
                same_label = [r for r in rows if str(r.get("label") or "").strip() == anchor_label]
                if not same_label:
                    continue
                if anchor_center is None:
                    # 중심점을 못 쓰면 confidence 최대 행을 후보로
                    same_label.sort(key=lambda x: float(x.get("confidence") or 0.0), reverse=True)
                    row = dict(same_label[0])
                else:
                    # anchor와 중심점이 가장 가까운 행을 선택
                    best_row = None
                    best_dist = float("inf")
                    ax, ay = anchor_center
                    for r in same_label:
                        c = _obb_center_xy(r.get("bbox"))
                        if c is None:
                            continue
                        dx = float(c[0]) - ax
                        dy = float(c[1]) - ay
                        dist = dx * dx + dy * dy
                        if dist < best_dist:
                            best_dist = dist
                            best_row = r
                    row = dict(best_row) if best_row is not None else dict(same_label[0])
                anchor_rows.append(row)

            if not anchor_rows:
                anchor_rows = [dict(anchor)]
            per_anchor_candidates.append(anchor_rows)

        t0 = datetime.now().timestamp()
        refined_with_ocr: List[Dict[str, Any]] = []
        for rows in per_anchor_candidates:
            rows_with_ocr = await ocr_on_tracked_data(rows)
            best_row = None
            best_key = None
            for r in rows_with_ocr:
                readable = 1 if str(r.get("ocr_number") or "").strip().isdigit() else 0
                ocr_conf = float(r.get("ocr_confidence") or 0.0)
                det_conf = float(r.get("confidence") or 0.0)
                sharp = _crop_sharpness_score(str(r.get("image_path") or ""), r.get("bbox"))
                fidx = int(frame_index_by_path.get(str(r.get("image_path") or ""), -1))
                # 정렬 우선순위: 읽힘 > OCR신뢰도 > 선명도 > 탐지신뢰도 > 최신프레임
                key = (readable, ocr_conf, sharp, det_conf, fidx)
                if best_key is None or key > best_key:
                    best_key = key
                    best_row = r
            if best_row is not None:
                refined_with_ocr.append(best_row)
        with_ocr = refined_with_ocr
        ocr_ms_primary = int((datetime.now().timestamp() - t0) * 1000)
    else:
        t0 = datetime.now().timestamp()
        with_ocr = await ocr_on_tracked_data(selected_item_candidates)
        ocr_ms_primary = int((datetime.now().timestamp() - t0) * 1000)

    ocr_ms_fallback = 0
    ocr_ms = ocr_ms_primary

    grouped: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for item in with_ocr:
        if item.get("track_id") is None:
            continue
        grouped[int(item["track_id"])].append(item)

    # 4) 프레임으로 스캔/행동/double_potion 추론 후 규칙으로 게이지 소모량 계산
    t0 = datetime.now().timestamp()
    infer_max_frames = TRACK_OCR_INFER_MAX_FRAMES_WITH_HINT if action_hint in ACTION_LABELS else TRACK_OCR_INFER_MAX_FRAMES_DEFAULT
    scan_result, action_type, best_scan_src_path, best_scan_bbox = await infer_scan_and_action_from_frames(
        saved_paths,
        max_frames=infer_max_frames,
        action_hint=action_hint,
        scan_hint=scan_hint,
        dets_by_path_cache=dets_by_path_cache,
    )
    has_double_potion: bool = False
    double_potion_source = "skipped"
    if action_type == "normal":
        has_double_potion = False
        double_potion_source = "default_false"
        if has_double_potion_hint is not None:
            has_double_potion = bool(has_double_potion_hint)
            double_potion_source = "hint"
        else:
            has_double_potion = await infer_double_potion_from_frames(
                saved_paths[:1], max_frames=1, dets_by_path_cache=dets_by_path_cache
            )
            double_potion_source = "single_frame_fallback"
    gauge_consumed = infer_gauge_consumed_by_rules(action_type, has_double_potion)
    infer_ms = int((datetime.now().timestamp() - t0) * 1000)

    scan_images = await _save_scan_ocr_reference_images(run_id, best_scan_src_path, best_scan_bbox)

    created_at = datetime.now().isoformat()
    crops_dir = TRACK_OCR_DIR / "crops"
    crops_dir.mkdir(parents=True, exist_ok=True)

    items_to_save = []
    for i, item in enumerate(with_ocr):
        obj = {**item, "verified": False, "item_index": i}
        try:
            path_str = str(Path(item["image_path"]))
            crop_img = crop_obb_region(path_str, item["bbox"])
            crop_filename = f"{run_id}_{i}.png"
            crop_path = crops_dir / crop_filename
            cv2.imwrite(str(crop_path), crop_img)
            obj["image_filename"] = crop_filename
            obj["image_url"] = f"/static/track_ocr/crops/{crop_filename}"
        except Exception:
            obj["image_filename"] = None
            obj["image_url"] = None
        items_to_save.append(obj)

    item_label_debug_url = _write_track_ocr_item_label_debug(
        run_id=run_id,
        created_at=created_at,
        action_hint=action_hint,
        saved_paths=saved_paths,
        tracked_all=tracked_all,
        tracked_candidates=tracked_candidates,
        with_ocr=with_ocr,
        grouped_with_ocr_by_track=grouped,
    )
    item_only_frame_debug_url = _write_item_only_frame_debug(
        run_id=run_id,
        created_at=created_at,
        saved_paths=saved_paths,
        tracked_all=tracked_all,
    )
    non_item_frame_debug_url = _write_non_item_frame_debug(
        run_id=run_id,
        created_at=created_at,
        saved_paths=saved_paths,
        tracked_all=tracked_all,
    )

    TRACK_OCR_DIR.mkdir(parents=True, exist_ok=True)
    t0 = datetime.now().timestamp()
    data = {"runs": []}
    if TRACK_OCR_RESULTS_FILE.exists():
        try:
            data = json.loads(TRACK_OCR_RESULTS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    run_payload = {
        "id": run_id,
        "created_at": created_at,
        "tracked_count": len(items_to_save),
        "items": items_to_save,
    }
    if scan_result is not None:
        run_payload["scan_result"] = scan_result
    if action_type is not None:
        run_payload["action_type"] = action_type
    if gauge_consumed is not None:
        run_payload["gauge_consumed"] = gauge_consumed
    if scan_images.get("scan_frame_image_url"):
        run_payload["scan_frame_image_url"] = scan_images["scan_frame_image_url"]
    if scan_images.get("scan_ocr_processed_image_url"):
        run_payload["scan_ocr_processed_image_url"] = scan_images["scan_ocr_processed_image_url"]
    if item_label_debug_url:
        run_payload["item_label_debug_url"] = item_label_debug_url
    if item_only_frame_debug_url:
        run_payload["item_only_frame_debug_url"] = item_only_frame_debug_url
    if non_item_frame_debug_url:
        run_payload["non_item_frame_debug_url"] = non_item_frame_debug_url
    data["runs"].append(run_payload)
    TRACK_OCR_RESULTS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    save_ms = int((datetime.now().timestamp() - t0) * 1000)

    n_ocr_primary = len(selected_item_candidates)
    n_ocr_fallback = 0
    n_ocr_total = n_ocr_primary + n_ocr_fallback
    ocr_ms_avg_per_crop = round(ocr_ms / n_ocr_total, 1) if n_ocr_total else 0.0

    out = {
        "run_id": run_id,
        "tracked_count": len(with_ocr),
        "items": with_ocr,
        "timestamp": created_at,
        # ocr_ms = 1차 OCR(ocr_ms_primary) + 숫자 없을 때만 돌리는 fallback(ocr_ms_fallback)
        # 실제 작업: app.ocr.processor.ocr_on_tracked_data → process_crop_image → _run_crop_ocr(Paddle 등)
        "ocr_ms": ocr_ms,
        "ocr_ms_primary": ocr_ms_primary,
        "ocr_ms_fallback": ocr_ms_fallback,
        "ocr_crops_primary": n_ocr_primary,
        "ocr_crops_fallback": n_ocr_fallback,
        "ocr_ms_avg_per_crop": ocr_ms_avg_per_crop,
    }
    if scan_result is not None:
        out["scan_result"] = scan_result
    if action_type is not None:
        out["action_type"] = action_type
    if gauge_consumed is not None:
        out["gauge_consumed"] = gauge_consumed
    if scan_images.get("scan_frame_image_url"):
        out["scan_frame_image_url"] = scan_images["scan_frame_image_url"]
    if scan_images.get("scan_ocr_processed_image_url"):
        out["scan_ocr_processed_image_url"] = scan_images["scan_ocr_processed_image_url"]
    if item_label_debug_url:
        out["item_label_debug_url"] = item_label_debug_url
    if item_only_frame_debug_url:
        out["item_only_frame_debug_url"] = item_only_frame_debug_url
    if non_item_frame_debug_url:
        out["non_item_frame_debug_url"] = non_item_frame_debug_url
    if PERF_LOG_ENABLED:
        total_ms = int((datetime.now().timestamp() - t0_total) * 1000)
        print(
            "[PERF][track-ocr]",
            {
                "run_id": run_id,
                "action_hint": action_hint,
                "scan_hint": scan_hint,
                "frames": len(saved_paths),
                "first_pass_stride": first_pass_stride,
                "first_pass_detect_count": first_pass_detect_count,
                "candidates_total": len(tracked_candidates),
                "scan_phase_frames": len(scan_phase_paths),
                "item_phase_frames": len(item_phase_paths),
                "best_item_frame_path": best_item_frame_path,
                "best_item_frame_item_count": max(0, best_item_count),
                "candidates_limited": len(selected_item_candidates),
                "candidates_fallback": 0,
                "items_final": len(with_ocr),
                "track_ms": track_ms,
                "ocr_ms": ocr_ms,
                "ocr_ms_primary": ocr_ms_primary,
                "ocr_ms_fallback": ocr_ms_fallback,
                "ocr_ms_avg_per_crop": ocr_ms_avg_per_crop,
                "infer_ms": infer_ms,
                "infer_max_frames": infer_max_frames,
                "save_ms": save_ms,
                "total_ms": total_ms,
                "has_double_potion": has_double_potion,
                "double_potion_source": double_potion_source,
            },
        )
    return out


async def _run_track_ocr_job(
    job_id: str,
    run_id: str,
    frames_dir: Path,
    saved_paths: List[str],
    action_hint: Optional[str] = None,
    has_double_potion_hint: Optional[bool] = None,
    scan_hint: Optional[str] = None,
    frontend_detections_by_frame: Optional[List[List[Dict[str, Any]]]] = None,
) -> None:
    TRACK_OCR_JOBS[job_id]["status"] = "running"
    TRACK_OCR_JOBS[job_id]["started_at"] = datetime.now().isoformat()
    try:
        # 전체 파이프라인을 별도 스레드에서 돌려 메인 이벤트 루프(/detect 등)가 막히지 않게 함.
        # 내부에서 별도 asyncio.run 루프가 돌며, detect/OCR은 추가로 to_thread 분산.
        def _pipeline_in_thread() -> Dict[str, Any]:
            return asyncio.run(
                _process_track_and_ocr(
                    saved_paths=saved_paths,
                    run_id=run_id,
                    action_hint=action_hint,
                    has_double_potion_hint=has_double_potion_hint,
                    scan_hint=scan_hint,
                    frontend_detections_by_frame=frontend_detections_by_frame,
                )
            )

        result = await asyncio.to_thread(_pipeline_in_thread)
        TRACK_OCR_JOBS[job_id]["status"] = "done"
        TRACK_OCR_JOBS[job_id]["result"] = result
    except Exception as e:
        TRACK_OCR_JOBS[job_id]["status"] = "failed"
        TRACK_OCR_JOBS[job_id]["error"] = str(e)
    finally:
        TRACK_OCR_JOBS[job_id]["completed_at"] = datetime.now().isoformat()
        if frames_dir.exists():
            try:
                shutil.rmtree(frames_dir)
            except Exception:
                pass
