import os
import json
from pathlib import Path

# 프로젝트 루트 경로
BASE_DIR = Path(__file__).resolve().parent.parent

# 데이터 저장 경로
DATA_DIR = BASE_DIR / "data"
RAW_IMAGE_DIR = DATA_DIR / "images" / "raw"
CLEAN_RAW_DIR = DATA_DIR / "images" / "clean_raw"
PROCESSED_IMAGE_DIR = DATA_DIR / "images" / "processed"
LABEL_DIR = DATA_DIR / "labels"
TRACK_OCR_DIR = DATA_DIR / "track_ocr"
TRACK_OCR_RESULTS_FILE = TRACK_OCR_DIR / "results.json"

# 지원하는 이미지 확장자
ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".tiff"}


def _bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


# true면 객체탐지/트래킹은 프론트(또는 외부)에서만 수행 — 백엔드는 best.onnx·YOLO 경로 불필요
FRONTEND_MODEL_MODE = _bool_env("FRONTEND_MODEL_MODE", False)

# OCR 설정
OCR_LANG = "korean"
# 크롭 OCR 엔진: easyocr | easyocr_onnx
OCR_CROP_ENGINE = os.getenv("OCR_CROP_ENGINE", "easyocr").strip().lower()
# EasyOCR 사용 여부. true면 easyocr_onnx 실패 시 EasyOCR 폴백 허용
OCR_USE_EASYOCR = _bool_env("OCR_USE_EASYOCR", False)


def _float_env(name: str, default: float) -> float:
    try:
        raw = os.getenv(name, "").strip()
        return float(raw) if raw else default
    except Exception:
        return default


def _int_env(name: str, default: int) -> int:
    try:
        raw = os.getenv(name, "").strip()
        return int(float(raw)) if raw else default
    except Exception:
        return default


# 크롭 숫자 OCR 전 업스케일 (기본 2배). 1.0이면 비활성.
OCR_CROP_UPSCALE_FACTOR = _float_env("OCR_CROP_UPSCALE_FACTOR", 2.0)
# 업스케일 후 긴 변 상한(픽셀). 0이면 제한 없음. 메모리·속도 보호용 기본 1920.
OCR_CROP_UPSCALE_MAX_SIDE = _int_env("OCR_CROP_UPSCALE_MAX_SIDE", 1920)

# 추적+OCR 적용할 라벨 (이 라벨에만 crop 후 OCR 수행)
OCR_TARGET_LABELS = {"common_item", "uncommon_item", "rare_item"}

# 탐지 대상 클래스 (data/data.yaml의 names와 순서 일치해야 함)
DETECTION_CLASSES = {
    0: "common",
    1: "uncommon",
    2: "normal",
    3: "chest",
    4: "mini",
    5: "gauge",
    6: "chat",
    7: "skill_on",
    8: "skill_off",
    9: "skill_popup",
    10: "common_item",
    11: "uncommon_item",
    12: "rare_item",
    13: "double_potion",
    14: "action_gauge",
}

CONFIDENCE_THRESHOLD_DEFAULT = 0.5

# 라벨별 탐지 confidence 기본값.
# 기본 동작 변화 최소화를 위해 우선 전체 0.5와 동일하게 맞추고,
# 운영 시 환경변수로 라벨별 값을 조정한다.
CONFIDENCE_THRESHOLDS = {
    # 스캔 UI·infer_scan_and_action_from_frames: 너무 높으면 common/uncommon 박스가 잘려 scan_result가 항상 None
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


def _load_label_thresholds_from_env() -> dict:
    """
    환경변수 JSON으로 라벨별 threshold를 덮어쓴다.
    예) DETECTION_THRESHOLDS_JSON='{"normal":0.55,"double_potion":0.4}'
    """
    raw = os.getenv("DETECTION_THRESHOLDS_JSON", "").strip()
    if not raw:
        return {}
    try:
        obj = json.loads(raw)
    except Exception:
        return {}
    if not isinstance(obj, dict):
        return {}
    out = {}
    for k, v in obj.items():
        try:
            key = str(k).strip()
            val = float(v)
            if key and 0.0 <= val <= 1.0:
                out[key] = val
        except Exception:
            continue
    return out


LABEL_CONFIDENCE_THRESHOLDS = {**CONFIDENCE_THRESHOLDS, **_load_label_thresholds_from_env()}


def get_label_confidence_threshold(label: str, fallback: float = CONFIDENCE_THRESHOLD_DEFAULT) -> float:
    if not label:
        return fallback
    try:
        return float(LABEL_CONFIDENCE_THRESHOLDS.get(label, fallback))
    except Exception:
        return fallback

# 백엔드 Ultralytics YOLO — FRONTEND_MODEL_MODE 이면 로드하지 않으므로 경로·디바이스 미사용
MODEL_DIR = BASE_DIR / "models"

if FRONTEND_MODEL_MODE:
    # detector는 이 경로를 열지 않음 (get_model이 즉시 실패/미호출)
    YOLO_MODEL_PATH = BASE_DIR / ".backend_yolo_disabled"
    YOLO_DEVICE = "cpu"
else:

    def _resolve_yolo_model_path() -> Path:
        """
        YOLO 가중치 경로 (백엔드에서 /detect·track 파이프라인 쓸 때만).
        - YOLO_MODEL_PATH: models/best.onnx 또는 절대경로 (우선)
        - 없으면 YOLO_USE_ONNX: best.onnx 우선(best.onnx 가 있으면 기본 True)
        - 아니면 best.pt
        """
        raw = os.getenv("YOLO_MODEL_PATH", "").strip()
        if raw:
            p = Path(raw)
            return p if p.is_absolute() else (MODEL_DIR / p.name).resolve()
        use_onnx = _bool_env("YOLO_USE_ONNX", (MODEL_DIR / "best.onnx").exists())
        onnx_p = MODEL_DIR / "best.onnx"
        pt_p = MODEL_DIR / "best.pt"
        if use_onnx and onnx_p.exists():
            return onnx_p.resolve()
        if pt_p.exists():
            return pt_p.resolve()
        if onnx_p.exists():
            return onnx_p.resolve()
        return pt_p.resolve()

    YOLO_MODEL_PATH = _resolve_yolo_model_path()

    def _resolve_yolo_device() -> str:
        """
        Ultralytics(YOLO) 추론 디바이스.
        - YOLO_DEVICE 미설정: torch.cuda 사용 가능하면 cuda, 아니면 cpu
        - YOLO_DEVICE=cuda | cuda:0 | cpu | 0 등 명시 가능 (torch+cpu 인데 cuda 지정 시 런타임 오류)
        """
        raw = os.getenv("YOLO_DEVICE", "").strip()
        if raw:
            return raw
        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            return "cpu"

    YOLO_DEVICE = _resolve_yolo_device()

def _get_database_url():
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        url = "postgresql+asyncpg://postgres:postgres@localhost:5432/cursoragent"
    return url

DATABASE_URL = _get_database_url()

# Supabase Storage (track OCR 크롭 업로드 — 미설정 시 로컬 디스크만 사용)
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
SUPABASE_CROPS_BUCKET = os.getenv("SUPABASE_CROPS_BUCKET", "track-ocr-crops").strip()