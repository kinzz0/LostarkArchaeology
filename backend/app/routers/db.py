"""DB 마스터 데이터 조회 API (도구, 스캔결과, 행동타입, 드롭타입)"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional
from app.database import get_db
from app.models.db_models import Tool, ScanResult, ActionType, DropType, ToolSpec

router = APIRouter()


class CreateToolBody(BaseModel):
    name: str
    game_id: Optional[str] = None
    description: Optional[str] = None


class CreateToolSpecBody(BaseModel):
    name: str
    common_reward_bonus: Optional[float] = None
    uncommon_reward_bonus: Optional[float] = None
    rare_reward_bonus: Optional[float] = None
    minigame_reward_bonus: Optional[float] = None
    minigame_chance_bonus: Optional[float] = None
    chest_spawn_bonus: Optional[float] = None


@router.get("/db/tools")
async def list_tools(db: AsyncSession = Depends(get_db)):
    """도구 목록"""
    result = await db.execute(select(Tool).order_by(Tool.id))
    rows = result.scalars().all()
    return {
        "tools": [
            {
                "id": t.id,
                "name": t.name,
                "game_id": t.game_id,
                "description": t.description,
                "created_at": t.created_at.isoformat() if t.created_at else None,
            }
            for t in rows
        ]
    }


@router.post("/db/tools")
async def create_tool(body: CreateToolBody, db: AsyncSession = Depends(get_db)):
    """도구 추가"""
    tool = Tool(name=body.name, game_id=body.game_id, description=body.description)
    db.add(tool)
    await db.flush()
    await db.refresh(tool)
    return {
        "id": tool.id,
        "name": tool.name,
        "game_id": tool.game_id,
        "description": tool.description,
        "created_at": tool.created_at.isoformat() if tool.created_at else None,
    }


@router.get("/db/tools/{tool_id}/specs")
async def list_tool_specs(tool_id: int, db: AsyncSession = Depends(get_db)):
    """특정 도구의 생활 스펙 프리셋 목록"""
    # 도구 존재 확인 (없으면 404)
    result_tool = await db.execute(select(Tool).where(Tool.id == tool_id))
    tool = result_tool.scalar_one_or_none()
    if tool is None:
        raise HTTPException(status_code=404, detail="도구를 찾을 수 없습니다.")

    result = await db.execute(
        select(ToolSpec)
        .where(ToolSpec.tool_id == tool_id)
        .order_by(ToolSpec.id)
    )
    rows = result.scalars().all()
    return {
        "specs": [
            {
                "id": s.id,
                "tool_id": s.tool_id,
                "name": s.name,
                "common_reward_bonus": s.common_reward_bonus,
                "uncommon_reward_bonus": s.uncommon_reward_bonus,
                "rare_reward_bonus": s.rare_reward_bonus,
                "minigame_reward_bonus": s.minigame_reward_bonus,
                "minigame_chance_bonus": s.minigame_chance_bonus,
                "chest_spawn_bonus": s.chest_spawn_bonus,
                "created_at": s.created_at.isoformat() if s.created_at else None,
            }
            for s in rows
        ]
    }


@router.get("/db/tool-specs")
async def list_all_tool_specs(db: AsyncSession = Depends(get_db)):
    """전체 생활 스펙 프리셋 목록 (도구명 포함)"""
    result = await db.execute(select(ToolSpec).order_by(ToolSpec.tool_id, ToolSpec.id))
    rows = result.scalars().all()
    tool_result = await db.execute(select(Tool).order_by(Tool.id))
    tools = tool_result.scalars().all()
    tool_name_by_id = {t.id: t.name for t in tools}
    return {
        "tool_specs": [
            {
                "id": s.id,
                "tool_id": s.tool_id,
                "tool_name": tool_name_by_id.get(s.tool_id),
                "name": s.name,
                "common_reward_bonus": s.common_reward_bonus,
                "uncommon_reward_bonus": s.uncommon_reward_bonus,
                "rare_reward_bonus": s.rare_reward_bonus,
                "minigame_reward_bonus": s.minigame_reward_bonus,
                "minigame_chance_bonus": s.minigame_chance_bonus,
                "chest_spawn_bonus": s.chest_spawn_bonus,
                "created_at": s.created_at.isoformat() if s.created_at else None,
            }
            for s in rows
        ]
    }


@router.post("/db/tools/{tool_id}/specs")
async def create_tool_spec(
    tool_id: int,
    body: CreateToolSpecBody,
    db: AsyncSession = Depends(get_db),
):
    """특정 도구에 대한 생활 스펙 프리셋 생성"""
    result_tool = await db.execute(select(Tool).where(Tool.id == tool_id))
    tool = result_tool.scalar_one_or_none()
    if tool is None:
        raise HTTPException(status_code=404, detail="도구를 찾을 수 없습니다.")

    spec = ToolSpec(
        tool_id=tool_id,
        name=body.name,
        common_reward_bonus=body.common_reward_bonus,
        uncommon_reward_bonus=body.uncommon_reward_bonus,
        rare_reward_bonus=body.rare_reward_bonus,
        minigame_reward_bonus=body.minigame_reward_bonus,
        minigame_chance_bonus=body.minigame_chance_bonus,
        chest_spawn_bonus=body.chest_spawn_bonus,
    )
    db.add(spec)
    await db.flush()
    await db.refresh(spec)
    return {
        "id": spec.id,
        "tool_id": spec.tool_id,
        "name": spec.name,
        "common_reward_bonus": spec.common_reward_bonus,
        "uncommon_reward_bonus": spec.uncommon_reward_bonus,
        "rare_reward_bonus": spec.rare_reward_bonus,
        "minigame_reward_bonus": spec.minigame_reward_bonus,
        "minigame_chance_bonus": spec.minigame_chance_bonus,
        "chest_spawn_bonus": spec.chest_spawn_bonus,
        "created_at": spec.created_at.isoformat() if spec.created_at else None,
    }


@router.delete("/db/tool-specs/{spec_id}")
async def delete_tool_spec(spec_id: int, db: AsyncSession = Depends(get_db)):
    """생활 스펙 프리셋 삭제"""
    result = await db.execute(select(ToolSpec).where(ToolSpec.id == spec_id))
    spec = result.scalar_one_or_none()
    if spec is None:
        raise HTTPException(status_code=404, detail="스펙 프리셋을 찾을 수 없습니다.")
    await db.delete(spec)
    return {"ok": True}


@router.get("/db/scan-results")
async def list_scan_results(db: AsyncSession = Depends(get_db)):
    """고고학 스캔 결과 목록 (common, uncommon)"""
    result = await db.execute(select(ScanResult).order_by(ScanResult.id))
    rows = result.scalars().all()
    return {
        "scan_results": [
            {"id": s.id, "label": s.label, "display_name": s.display_name}
            for s in rows
        ]
    }


@router.get("/db/action-types")
async def list_action_types(db: AsyncSession = Depends(get_db)):
    """행동 타입 목록 (normal, chest, mini)"""
    result = await db.execute(select(ActionType).order_by(ActionType.id))
    rows = result.scalars().all()
    return {
        "action_types": [
            {
                "id": a.id,
                "label": a.label,
                "display_name": a.display_name,
                "gauge_default": a.gauge_default,
            }
            for a in rows
        ]
    }


@router.get("/db/drop-types")
async def list_drop_types(db: AsyncSession = Depends(get_db)):
    """드롭 타입 목록 (common_item, uncommon_item, rare_item)"""
    result = await db.execute(select(DropType).order_by(DropType.rarity_order))
    rows = result.scalars().all()
    return {
        "drop_types": [
            {
                "id": d.id,
                "label": d.label,
                "display_name": d.display_name,
                "rarity_order": d.rarity_order,
            }
            for d in rows
        ]
    }
