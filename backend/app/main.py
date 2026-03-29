import os

# ONNX Runtime이 CUDA EP를 못 쓸 때 stderr에 찍는 경고(“CUDA requested…”) 억제.
# 디버그 시 .env 에 ORT_LOG_SEVERITY_LEVEL=2 로 경고까지 볼 수 있음.
os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv

load_dotenv()

from app.config import DATABASE_URL
from app.database import init_db, AsyncSessionLocal
from app.db_seed import seed_if_empty
from app.models import db_models  # noqa: F401  # 테이블 등록
from app.routers import upload, capture, data, detect, track_ocr, db as db_router, auth, admin


@asynccontextmanager
async def lifespan(app: FastAPI):
    """앱 기동 시 DB 테이블 생성 및 시드"""
    if DATABASE_URL:
        await init_db()
        async with AsyncSessionLocal() as session:
            await seed_if_empty(session)
            await session.commit()
    yield
    # shutdown (필요 시 정리)


app = FastAPI(
    lifespan=lifespan,
    title="AI 데이터 수집기 API",
    description="게임 화면 OCR 및 객체 탐지 데이터 수집 서버",
    version="1.0.0",
)

def _parse_cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "").strip()
    if not raw:
        return ["*"]
    return [o.strip() for o in raw.split(",") if o.strip()]

_allow_origins = _parse_cors_origins()
_allow_credentials = True
# Starlette: allow_origins에 "*"이면 allow_credentials는 False여야 함

if _allow_origins == ["*"]:
    _allow_credentials = False

# CORS 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_credentials=_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 정적 파일 서빙 (캡처된 이미지)
os.makedirs("data/images/raw", exist_ok=True)
os.makedirs("data/images/processed", exist_ok=True)
os.makedirs("data/labels", exist_ok=True)
os.makedirs("data/track_ocr", exist_ok=True)
app.mount("/static", StaticFiles(directory="data"), name="static")

# 라우터 등록
app.include_router(upload.router, prefix="/api", tags=["upload"])
app.include_router(capture.router, prefix="/api", tags=["capture"])
app.include_router(data.router, prefix="/api", tags=["data"])
app.include_router(detect.router, prefix="/api", tags=["detect"])
app.include_router(track_ocr.router, prefix="/api", tags=["종합 OCR"])
app.include_router(db_router.router, prefix="/api", tags=["db"])
app.include_router(auth.router, prefix="/api", tags=["auth"])
app.include_router(admin.router, prefix="/api", tags=["admin"])


@app.get("/api/health")
async def health_check():
    return {
        "status": "ok",
        "message": "AI 데이터 수집기 서버가 정상 작동 중입니다.",
    }
