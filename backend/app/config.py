import os
from pathlib import Path
from typing import Dict, Optional

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

# Ultralytics YOLO-OBB: .pt 또는 export .onnx (task=obb). 미설정 시 backend/models/best.pt
YOLO_MODEL_PATH = Path(os.getenv("YOLO_MODEL_PATH", str(BASE_DIR / "models" / "best.pt")))
# 추론 디바이스 (기본 cpu). GPU 사용 시 예: cuda:0
YOLO_DEVICE = os.getenv("YOLO_DEVICE", "cpu").strip() or "cpu"

# track-ocr·/detect 에서 라벨별 최소 confidence (미정의 라벨은 YOLO_DETECT_CONF_FALLBACK)
YOLO_DETECT_CONF_FALLBACK = _float_env("YOLO_DETECT_CONF_FALLBACK", 0.5)
DETECTION_CONFIDENCE_THRESHOLDS: Dict[str, float] = {
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


def get_label_confidence_threshold(label: str, fallback: float) -> float:
    v = DETECTION_CONFIDENCE_THRESHOLDS.get(label)
    return float(v) if isinstance(v, (int, float)) else float(fallback)


# 클래스 id → 라벨 (학습 data.yaml 순서와 동일)
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

# API와 프론트가 다른 호스트일 때 JSON의 /static/... 을 브라우저가 API 서버로 요청하도록 절대 URL로 만든다.
PUBLIC_APP_BASE_URL = os.getenv("PUBLIC_APP_BASE_URL", "").strip().rstrip("/")


def resolve_public_asset_url(url: Optional[str]) -> Optional[str]:
    """상대 경로(/static/...)는 PUBLIC_APP_BASE_URL 이 있으면 한 번에 절대 URL로 붙인다. http(s)는 그대로."""
    if url is None:
        return None
    s = str(url).strip()
    if not s:
        return None
    low = s[:8].lower()
    if low.startswith("http://") or low.startswith("https://"):
        return s
    if s.startswith("/") and PUBLIC_APP_BASE_URL:
        return f"{PUBLIC_APP_BASE_URL}{s}"
    return s
