"""PostgreSQL 비동기 연결 및 세션"""
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import declarative_base

from app.config import DATABASE_URL

# sync URL로 넘어오면 async 드라이버로 변환 (postgresql:// -> postgresql+asyncpg://)
_db_url = DATABASE_URL
if _db_url.startswith("postgresql://") and "+asyncpg" not in _db_url:
    _db_url = _db_url.replace("postgresql://", "postgresql+asyncpg://", 1)

engine = create_async_engine(
    _db_url,
    echo=False,
    # Supabase pooler(pgbouncer) 사용 시 asyncpg prepared statement cache 충돌 방지
    connect_args={"statement_cache_size": 0},
)
AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)
Base = declarative_base()


async def get_db():
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db():
    """테이블 생성 (앱 기동 시 호출)"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # 기존 DB에 컬럼만 추가 (create_all은 기존 테이블 ALTER 안 함)
        await conn.execute(
            text("ALTER TABLE run_items ADD COLUMN IF NOT EXISTS image_storage_url TEXT")
        )
