"""
OCR 처리 모듈
전처리된 게임 화면에서 텍스트를 추출
"""
import asyncio
import os
import re
import threading
from pathlib import Path
import cv2
import numpy as np
from modal_client import call_modal_easyocr
from app.ocr.preprocessor import preprocess_for_ocr, preprocess_gauge_crop, crop_obb_region
from app.config import (
    OCR_TARGET_LABELS,
    OCR_CROP_UPSCALE_FACTOR,
    OCR_CROP_UPSCALE_MAX_SIDE,
    OCR_CROP_ENGINE,
    OCR_USE_EASYOCR,
)
from typing import List, Dict, Any, Optional, Tuple, cast

MIN_NUMBER_OCR_CONFIDENCE = 0.75

# EasyOCR Reader 싱글톤은 동시 readtext 비권장 → 크롭 OCR 구간만 직렬화
_EASYOCR_READ_LOCK = threading.Lock()


def _ocr_tracked_max_concurrent() -> int:
    """
    ocr_on_tracked_data 내부에서만 쓰는 동시 크롭 OCR 상한.
    전역 asyncio 기본 스레드 풀을 YOLO(to_thread) 등과 과하게 나눠 쓰지 않도록 1~4로 제한.
    """
    try:
        n = int(os.getenv("OCR_ON_TRACKED_MAX_CONCURRENT", "2").strip())
    except ValueError:
        n = 2
    return max(1, min(4, n))


def normalize_ocr_text_for_quantity(text: str) -> str:
    """
    EasyOCR 등에서 흔한 오인식 보정 (개수 표기용).
    - '11'이 로마자 'ii'로 읽힘 → x 11 / xii 형태를 숫자로 되돌림.
    """
    if not text or not text.strip():
        return text
    s = text
    # "x11" / "x 11" → "x ii", "xii" 등
    s = re.sub(r"(?i)x\s*ii\b", "x 11", s)
    s = re.sub(r"(?i)x\s*ll\b", "x 11", s)
    return s


def normalize_digit_confusions_in_numeric_runs(text: str) -> str:
    """
    개수/숫자 표기에서 0이 O·o로 잘못 인식된 경우 보정.
    연속된 [0-9Oo] 구간 안의 O, o만 0으로 치환 (한글·영단어는 건드리지 않음).
    예: "5O"→"50", "1O3"→"103", "x 2O"→"x 20"
    """
    if not text:
        return text

    def _repl(m):
        return m.group(0).replace("O", "0").replace("o", "0")

    return re.sub(r"[0-9Oo]+", _repl, text)


def extract_number_from_ocr_text(text: str) -> Optional[str]:
    """
    '고대유물 x 17' 같은 문자열에서 숫자만 추출. 마지막 정수(개수)를 반환.
    """
    if not text or not text.strip():
        return None
    text = normalize_ocr_text_for_quantity(text)
    text = normalize_digit_confusions_in_numeric_runs(text)
    numbers = re.findall(r"\d+", text)
    return numbers[-1] if numbers else None


def parse_gauge_remaining_total(text: str) -> Dict[str, Optional[str]]:
    """
    게이지 UI 문자열 `남은량 / 전체` 파싱.
    `/` 또는 전각 `／` 기준 앞=남은량, 뒤=전체 (로아 고고학 게이지 규칙).

    슬래시가 OCR에서 빠진 경우 연속 숫자 2개면 앞·뒤 순으로 해석.
    """
    if not text or not str(text).strip():
        return {"remaining": None, "total": None}
    t = normalize_ocr_text_for_quantity(str(text).strip())
    t = normalize_digit_confusions_in_numeric_runs(t)
    parts = re.split(r"\s*[/／]\s*", t, maxsplit=1)
    if len(parts) >= 2:
        left, right = parts[0], parts[1]
        rm = re.search(r"\d+", left)
        tm = re.search(r"\d+", right)
        return {
            "remaining": rm.group(0) if rm else None,
            "total": tm.group(0) if tm else None,
        }
    nums = re.findall(r"\d+", t)
    if len(nums) >= 2:
        return {"remaining": nums[0], "total": nums[1]}
    if len(nums) == 1:
        return {"remaining": nums[0], "total": None}
    return {"remaining": None, "total": None}


def extract_number_confidence(details: List[Dict[str, Any]]) -> Optional[float]:
    """
    OCR details 중 숫자를 포함한 토큰들의 confidence에서 최대값을 반환.
    숫자 토큰이 없으면 None.
    """
    if not details:
        return None
    digit_confs: List[float] = []
    for d in details:
        txt = normalize_ocr_text_for_quantity(str(d.get("text", "") or ""))
        txt = normalize_digit_confusions_in_numeric_runs(txt)
        if re.search(r"\d+", txt):
            try:
                digit_confs.append(float(d.get("confidence", 0.0) or 0.0))
            except Exception:
                continue
    return max(digit_confs) if digit_confs else None
# EasyOCR 인스턴스 (싱글톤) - process_crop_image(crop)용, 한글·숫자 인식
_easyocr_reader = None


def _empty_crop_ocr_result() -> dict:
    return {"text": "", "confidence": 0.0, "details": [], "number": None}


def get_easyocr_reader():
    """EasyOCR 싱글톤 (한글+영어, CPU). crop OCR용. OCR_USE_EASYOCR=false면 호출하지 말 것."""
    global _easyocr_reader
    if not OCR_USE_EASYOCR:
        raise RuntimeError("EasyOCR 비활성화됨 (OCR_USE_EASYOCR=false)")
    if _easyocr_reader is None:
        import easyocr
        _easyocr_reader = easyocr.Reader(["ko", "en"], gpu=True, verbose=False)
    return _easyocr_reader


async def process_image(image_path: str) -> dict:
    """전체 이미지 OCR (EasyOCR)"""

    # 전처리 (전처리 결과는 디스크에 저장하지 않음)
    processed = preprocess_for_ocr(image_path)
    ocr_result = _run_easyocr_on_crop(processed, upscale=False)
    return {
        "text": ocr_result.get("text", ""),
        "confidence": float(ocr_result.get("confidence", 0.0) or 0.0),
        "details": ocr_result.get("details", []),
    }


def _upscale_crop_for_number_ocr(crop_bgr: np.ndarray) -> np.ndarray:
    """
    작은 크롭에서 숫자/텍스트 인식률을 올리기 위해 업스케일.
    INTER_CUBIC 사용. 긴 변이 OCR_CROP_UPSCALE_MAX_SIDE를 넘으면 비율 유지하며 축소.
    """
    if crop_bgr is None or crop_bgr.size == 0:
        return crop_bgr
    factor = float(OCR_CROP_UPSCALE_FACTOR)
    if factor <= 1.001:
        return crop_bgr
    h, w = crop_bgr.shape[:2]
    if h < 1 or w < 1:
        return crop_bgr
    new_w = max(1, int(round(w * factor)))
    new_h = max(1, int(round(h * factor)))
    max_side = int(OCR_CROP_UPSCALE_MAX_SIDE)
    if max_side > 0:
        cur = max(new_w, new_h)
        if cur > max_side:
            s = max_side / float(cur)
            new_w = max(1, int(round(new_w * s)))
            new_h = max(1, int(round(new_h * s)))
    if new_w == w and new_h == h:
        return crop_bgr
    return cv2.resize(crop_bgr, (new_w, new_h), interpolation=cv2.INTER_CUBIC)


def _run_crop_ocr(crop_bgr: np.ndarray, *, upscale: bool = True) -> dict:
    """
    크롭 OCR. OCR_CROP_ENGINE=easyocr_onnx 이면 ONNX rec,
    실패 시 OCR_USE_EASYOCR=true 일 때만 EasyOCR 폴백.
    """
    if OCR_CROP_ENGINE == "easyocr" and OCR_USE_EASYOCR:
        return _run_easyocr_on_crop(crop_bgr, upscale=upscale)
    if OCR_CROP_ENGINE == "easyocr" and not OCR_USE_EASYOCR:
        return _empty_crop_ocr_result()
    if OCR_CROP_ENGINE == "easyocr_onnx":
        prepared = _upscale_crop_for_number_ocr(crop_bgr) if upscale else crop_bgr
        from app.ocr.easyocr_onnx_rec import run_easyocr_onnx_on_bgr

        # Cloud 운영: MODAL_EASYOCR_URL이 있으면 Modal OCR을 우선 시도하고
        # 실패 시 기존 로컬 ONNX/EasyOCR 경로로 폴백한다.
        if os.getenv("MODAL_EASYOCR_URL", "").strip():
            try:
                ok, encoded = cv2.imencode(".png", prepared)
                if ok:
                    modal_res = call_modal_easyocr(encoded.tobytes())
                    if modal_res.get("ok") and str(modal_res.get("text", "")).strip():
                        full_text = normalize_ocr_text_for_quantity(str(modal_res.get("text", "")))
                        full_text = normalize_digit_confusions_in_numeric_runs(full_text)
                        number = modal_res.get("number") or extract_number_from_ocr_text(full_text)
                        conf = float(modal_res.get("confidence", 0.0) or 0.0)
                        return {
                            "text": full_text,
                            "confidence": conf,
                            "details": [{"text": full_text, "confidence": conf}],
                            "number": number,
                        }
            except Exception:
                pass

        p = run_easyocr_onnx_on_bgr(prepared)
        if p is not None and str(p.get("text", "")).strip():
            full_text = normalize_ocr_text_for_quantity(p["text"])
            full_text = normalize_digit_confusions_in_numeric_runs(full_text)
            number = extract_number_from_ocr_text(full_text)
            details = p.get("details") or []
            number_conf = extract_number_confidence(details)
            conf = (
                float(number_conf)
                if number_conf is not None
                else float(p.get("confidence", 0.0) or 0.0)
            )
            return {
                "text": full_text,
                "confidence": conf,
                "details": details,
                "number": number,
            }
        if OCR_USE_EASYOCR:
            return _run_easyocr_on_crop(crop_bgr, upscale=upscale)
        return _empty_crop_ocr_result()
    return _empty_crop_ocr_result()


def _run_easyocr_on_crop(crop_bgr: np.ndarray, *, upscale: bool = True) -> dict:
    if not OCR_USE_EASYOCR:
        return _empty_crop_ocr_result()
    if upscale:
        crop_bgr = _upscale_crop_for_number_ocr(crop_bgr)
    reader = get_easyocr_reader()
    with _EASYOCR_READ_LOCK:
        result = reader.readtext(
            crop_bgr,
            decoder="beamsearch",
            beamWidth=5,
            contrast_ths=0.05,
            adjust_contrast=0.7,
            low_text=0.3,
            text_threshold=0.6,
        )
    if not result:
        return {"text": "", "confidence": 0.0, "details": [], "number": None}
    details = []
    full_text_parts = []
    total_conf = 0.0
    for item in result:
        bbox_ln, text, conf = item[0], item[1], item[2]
        xs = [p[0] for p in bbox_ln]
        ys = [p[1] for p in bbox_ln]
        details.append({
            "text": text,
            "confidence": float(conf),
            "bbox": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
        })
        full_text_parts.append(text)
        total_conf += float(conf)
    avg_conf = total_conf / len(details) if details else 0.0
    full_text = normalize_ocr_text_for_quantity(" ".join(full_text_parts))
    full_text = normalize_digit_confusions_in_numeric_runs(full_text)
    number = extract_number_from_ocr_text(full_text)
    number_conf = extract_number_confidence(details)
    confidence = float(number_conf) if number_conf is not None else float(avg_conf)
    return {"text": full_text, "confidence": confidence, "details": details, "number": number}


def _preprocess_crop_stage2_pad_upscale(crop_bgr: np.ndarray) -> np.ndarray:
    h, w = crop_bgr.shape[:2]
    pad = max(3, int(round(min(h, w) * 0.08)))
    padded = cv2.copyMakeBorder(crop_bgr, pad, pad, pad, pad, cv2.BORDER_REPLICATE)
    return cv2.resize(padded, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)


def _preprocess_crop_stage2_clahe_adaptive(crop_bgr: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    binary = cv2.adaptiveThreshold(
        enhanced, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 7
    )
    return cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)


def _preprocess_crop_stage2_digit_stroke_enhance(crop_bgr: np.ndarray) -> np.ndarray:
    """
    숫자(특히 11)의 세로 획을 살리는 전처리.
    - 업스케일 후 노이즈 제거
    - CLAHE 대비 강화
    - 세로 커널 close로 끊긴 '1' 획 연결
    - OTSU 이진화
    """
    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    up = cv2.resize(gray, None, fx=2.2, fy=2.2, interpolation=cv2.INTER_CUBIC)
    den = cv2.GaussianBlur(up, (3, 3), 0)
    clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8))
    enh = clahe.apply(den)
    # 세로획 연결(11 안정화)
    k_vert = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 3))
    closed = cv2.morphologyEx(enh, cv2.MORPH_CLOSE, k_vert, iterations=1)
    _, binary = cv2.threshold(closed, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)


def _is_confident_number_result(ocr_result: dict) -> bool:
    number = ocr_result.get("number")
    conf = float(ocr_result.get("confidence", 0.0) or 0.0)
    return number is not None and conf >= MIN_NUMBER_OCR_CONFIDENCE


async def process_gauge_crop_image(crop_bgr: np.ndarray) -> dict:
    """
    `gauge` 클래스 crop: 게이지 숫자용 전처리 후 OCR, 실패 시 일반 crop 파이프라인으로 폴백.
    """
    if crop_bgr is None or crop_bgr.size == 0:
        return {"text": "", "confidence": 0.0, "details": [], "number": None}
    pre = preprocess_gauge_crop(crop_bgr)
    primary = _run_crop_ocr(pre)
    if _is_confident_number_result(primary):
        return primary
    # 게이지 전용 전처리만으로 부족하면 일반 다단계 OCR
    return await process_crop_image(crop_bgr)


def _process_crop_image_sync(crop_bgr: np.ndarray) -> dict:
    """crop OCR 동기 본문 — CPU·OCR 엔진 작업을 스레드 풀에서 실행한다."""
    # 1차: 원본 crop OCR
    primary = _run_crop_ocr(crop_bgr)
    if _is_confident_number_result(primary):
        return primary

    # 2차: 전처리 2종에 대해 재시도 후 가장 좋은 결과 선택
    stage2_inputs = [
        _preprocess_crop_stage2_pad_upscale(crop_bgr),
        _preprocess_crop_stage2_clahe_adaptive(crop_bgr),
        _preprocess_crop_stage2_digit_stroke_enhance(crop_bgr),
    ]
    candidates = [primary]
    for img in stage2_inputs:
        try:
            candidates.append(_run_crop_ocr(img, upscale=False))
        except Exception:
            continue

    def _rank(x: dict):
        num = x.get("number")
        has_num = 1 if num is not None and str(num).strip().isdigit() else 0
        conf = float(x.get("confidence", 0.0) or 0.0)
        return (has_num, conf)

    candidates.sort(key=_rank, reverse=True)
    return candidates[0]


async def process_crop_image(crop_bgr: np.ndarray) -> dict:
    """crop된 BGR 이미지에서 숫자 OCR 수행. 실패 시 2단계 전처리 재시도."""
    return await asyncio.to_thread(_process_crop_image_sync, crop_bgr)

def _row_after_ocr(item: dict, ocr_result: dict) -> dict:
    raw_text = ocr_result.get("text", "")
    number = ocr_result.get("number")
    conf = float(ocr_result.get("confidence", 0.0) or 0.0)
    is_number_confident = number is not None and conf >= MIN_NUMBER_OCR_CONFIDENCE
    ocr_display = str(number).strip() if is_number_confident else ""
    return {
        **item,
        "ocr_text": ocr_display,
        "ocr_raw": raw_text,
        "ocr_number": str(number).strip() if is_number_confident else None,
        "ocr_confidence": conf,
    }


async def ocr_on_tracked_data(tracked_list: List[dict]) -> List[dict]:
    """
    저장된 추적 데이터 리스트에 OCR 결과를 붙여 반환.
    common_item, uncommon_item, rare_item 라벨에만 OCR 수행. 나머지는 ocr_text/ocr_confidence 빈 값.
    tracked_list: [ {"track_id", "label", "bbox", "image_path", ...}, ... ]
    bbox는 OBB 4꼭짓점 [x1,y1,x2,y2,x3,y3,x4,y4].

    주의: `ocr_text`는 **개수 숫자**만 신뢰도 충족 시 표시한다. 전체 인식 문장은 `ocr_raw`에 남는다.

    성능: OCR 대상 행은 ``OCR_ON_TRACKED_MAX_CONCURRENT``(기본 2, 최대 4)로 동시 ``process_crop_image``만 제한.
    전역 ``to_thread`` 풀을 탐지 등 다른 작업과 과하게 나눠 쓰지 않게 한다. EasyOCR ``readtext``는 락으로 직렬화.
    """
    if not tracked_list:
        return []

    sem = asyncio.Semaphore(_ocr_tracked_max_concurrent())

    async def ocr_one(index: int, item: dict, crop: np.ndarray) -> Tuple[int, dict]:
        async with sem:
            try:
                ocr_result = await process_crop_image(crop)
                return index, _row_after_ocr(item, ocr_result)
            except Exception:
                return index, {
                    **item,
                    "ocr_text": "",
                    "ocr_raw": "",
                    "ocr_number": None,
                    "ocr_confidence": 0.0,
                }

    out: List[Optional[dict]] = [None] * len(tracked_list)
    tasks: List[asyncio.Task] = []

    for i, item in enumerate(tracked_list):
        label = item.get("label", "")
        if label not in OCR_TARGET_LABELS:
            out[i] = {**item, "ocr_text": "", "ocr_confidence": 0.0}
            continue
        image_path = item.get("image_path")
        bbox = item.get("bbox")
        if not image_path or not bbox or len(bbox) < 8:
            out[i] = {**item, "ocr_text": "", "ocr_confidence": 0.0}
            continue
        try:
            path_str = str(Path(image_path)) if isinstance(image_path, str) else image_path
            crop = crop_obb_region(path_str, bbox)
        except Exception:
            out[i] = {**item, "ocr_text": "", "ocr_raw": "", "ocr_number": None, "ocr_confidence": 0.0}
            continue
        tasks.append(asyncio.create_task(ocr_one(i, item, crop)))

    if tasks:
        for idx, row in await asyncio.gather(*tasks):
            out[idx] = row

    return cast(List[dict], out)