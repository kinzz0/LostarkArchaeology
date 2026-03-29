"""
EasyOCR ONNX recognizer (crop-only).

참고: asmud/EasyOCR-onnx 모델 카드는 영어/라틴 인식 모델 위주다.
한국어 인식이 필요하면 한국어 charset/모델 쌍을 별도로 준비해야 한다.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

_session: Any = None
_input_name: Optional[str] = None
_output_name: Optional[str] = None
_ORT_RUN_LOCK = threading.Lock()


def _get_charset() -> List[str]:
    raw = (os.getenv("EASYOCR_ONNX_CHARSET") or "").strip()
    if raw:
        return list(raw)
    # asmud/EasyOCR-onnx model card example charset (english)
    default_charset = (
        "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
    )
    return list(default_charset)


def _resolve_model_path() -> Path:
    from app.config import BASE_DIR

    raw = (
        os.getenv("EASYOCR_ONNX_REC_PATH")
        or "models/easyocr-onnx/english_g2_jpqd.onnx"
    ).strip()
    p = Path(raw)
    if not p.is_absolute():
        p = (BASE_DIR / p).resolve()
    return p


def _get_session(model_path: Path):
    global _session, _input_name, _output_name
    if _session is not None:
        return _session
    import onnxruntime as ort

    providers: List[Any] = ["CPUExecutionProvider"]
    use_gpu = os.getenv("EASYOCR_ONNX_USE_GPU", "false").strip().lower() in ("1", "true", "yes", "on")
    if use_gpu:
        avail = ort.get_available_providers()
        if "CUDAExecutionProvider" in avail:
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]

    so = ort.SessionOptions()
    # ORT가 CUDA 실패 후 CPU로 폴백할 때 콘솔 경고를 줄임(환경 ORT_LOG_SEVERITY_LEVEL과 동조)
    try:
        so.log_severity_level = 3  # 0=VERBOSE … 3=ERROR, 4=FATAL
    except Exception:
        pass

    _session = ort.InferenceSession(str(model_path), sess_options=so, providers=providers)
    inp = _session.get_inputs()[0]
    _input_name = inp.name
    outs = _session.get_outputs()
    _output_name = outs[0].name if outs else None
    return _session


def _preprocess(bgr: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY) if bgr.ndim == 3 else bgr
    resized = cv2.resize(gray, (100, 32), interpolation=cv2.INTER_CUBIC)
    x = resized.astype(np.float32) / 255.0
    x = np.expand_dims(np.expand_dims(x, axis=0), axis=0)  # 1x1x32x100
    return x


def _decode(logits: np.ndarray) -> Dict[str, Any]:
    # expected: [1, T, C] or [1, C, T]
    if logits.ndim != 3:
        return {"text": "", "confidence": 0.0, "details": [], "number": None}

    if logits.shape[1] < logits.shape[2]:
        # [1, T, C]
        probs = logits[0]
    else:
        # [1, C, T] -> [T, C]
        probs = logits[0].transpose(1, 0)

    best_idx = np.argmax(probs, axis=1)
    best_prob = np.max(probs, axis=1)

    blank_idx = int(os.getenv("EASYOCR_ONNX_BLANK_IDX", "0"))
    charset = _get_charset()
    chars: List[str] = []
    confs: List[float] = []
    prev = -1
    for idx, conf in zip(best_idx.tolist(), best_prob.tolist()):
        if idx == blank_idx:
            prev = idx
            continue
        if idx == prev:
            continue
        prev = idx
        map_idx = idx - 1 if blank_idx == 0 else idx
        if 0 <= map_idx < len(charset):
            chars.append(charset[map_idx])
            confs.append(float(conf))

    text = "".join(chars).strip()
    avg_conf = float(np.mean(confs)) if confs else 0.0
    detail = [{"text": text, "confidence": avg_conf}] if text else []
    return {"text": text, "confidence": avg_conf, "details": detail, "number": None}


def run_easyocr_onnx_on_bgr(bgr: np.ndarray) -> Optional[Dict[str, Any]]:
    model_path = _resolve_model_path()
    if not model_path.is_file():
        return None
    try:
        sess = _get_session(model_path)
        x = _preprocess(bgr)
        out_name = _output_name or sess.get_outputs()[0].name
        with _ORT_RUN_LOCK:
            logits = sess.run([out_name], {_input_name: x})[0]
        return _decode(logits)
    except Exception:
        return None

