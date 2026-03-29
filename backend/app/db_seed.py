"""DB 초기 데이터 (마스터 테이블)"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.db_models import DropType, ActionType, ScanResult, Tool


async def seed_if_empty(session: AsyncSession) -> None:
    """테이블이 비어 있으면 drop_types, action_types, scan_results, tools 시드 삽입"""
    result = await session.execute(select(DropType).limit(1))
    if result.scalars().first() is not None:
        return

    session.add_all([
        DropType(label="common_item", display_name="일반", rarity_order=1),
        DropType(label="uncommon_item", display_name="고급", rarity_order=2),
        DropType(label="rare_item", display_name="희귀", rarity_order=3),
    ])
    session.add_all([
        ActionType(label="normal", display_name="고고학", gauge_default=None),
        ActionType(label="chest", display_name="보물상자", gauge_default=0),
        ActionType(label="mini", display_name="미니게임", gauge_default=0),
    ])
    session.add_all([
        ScanResult(label="common", display_name="일반 스캔"),
        ScanResult(label="uncommon", display_name="고급 스캔"),
    ])
    session.add(Tool(name="도구 1", game_id="default", description=None))
    await session.flush()
