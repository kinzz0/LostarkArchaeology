"""SQLAlchemy DB 모델 (PostgreSQL)"""
from datetime import datetime
from sqlalchemy import (
    Column, String, Integer, SmallInteger, Float, Boolean, Text, DateTime,
    ForeignKey, Index,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

from app.database import Base


class DropType(Base):
    __tablename__ = "drop_types"
    id = Column(SmallInteger, primary_key=True, autoincrement=True)
    label = Column(String(32), unique=True, nullable=False)
    display_name = Column(String(64))
    rarity_order = Column(SmallInteger, default=0)


class ActionType(Base):
    __tablename__ = "action_types"
    id = Column(SmallInteger, primary_key=True, autoincrement=True)
    label = Column(String(32), unique=True, nullable=False)
    display_name = Column(String(64))
    gauge_default = Column(SmallInteger)


class ScanResult(Base):
    __tablename__ = "scan_results"
    id = Column(SmallInteger, primary_key=True, autoincrement=True)
    label = Column(String(32), unique=True, nullable=False)
    display_name = Column(String(64))


class Tool(Base):
    __tablename__ = "tools"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(128), nullable=False)
    game_id = Column(String(64))
    description = Column(Text)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


class ToolSpec(Base):
    __tablename__ = "tool_specs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tool_id = Column(Integer, ForeignKey("tools.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(128), nullable=False)

    # 아이템 드랍에 영향을 미치는 생활 스펙
    common_reward_bonus = Column(Float)        # 일반 등급 보상 획득률 증가 (%)
    uncommon_reward_bonus = Column(Float)      # 고급 등급 보상 획득률 증가 (%)
    rare_reward_bonus = Column(Float)          # 희귀 등급 보상 획득률 증가 (%)
    minigame_reward_bonus = Column(Float)      # 미니게임 보상 획득률 증가 (%)
    minigame_chance_bonus = Column(Float)      # 미니게임 기회 획득 확률 증가 (%)
    chest_spawn_bonus = Column(Float)          # 보물상자 등장 확률 증가 (%)

    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    discord_id = Column(String(64), unique=True, nullable=False)
    username = Column(String(128), nullable=False)
    global_name = Column(String(128))
    avatar = Column(String(128))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    settings = relationship("UserSetting", back_populates="user", uselist=False, cascade="all, delete-orphan")


class UserSetting(Base):
    __tablename__ = "user_settings"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True)
    tool_spec_id = Column(Integer, ForeignKey("user_tool_specs.id", ondelete="SET NULL"))
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="settings")


class UserToolSpec(Base):
    __tablename__ = "user_tool_specs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(128), nullable=False)
    common_reward_bonus = Column(Float)
    uncommon_reward_bonus = Column(Float)
    rare_reward_bonus = Column(Float)
    minigame_reward_bonus = Column(Float)
    minigame_chance_bonus = Column(Float)
    chest_spawn_bonus = Column(Float)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("idx_user_tool_specs_user_id", "user_id"),
    )


class Run(Base):
    __tablename__ = "runs"
    id = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    tool_spec_id = Column(Integer, ForeignKey("user_tool_specs.id", ondelete="SET NULL"))
    scan_result_id = Column(SmallInteger, ForeignKey("scan_results.id", ondelete="RESTRICT"))
    action_type_id = Column(SmallInteger, ForeignKey("action_types.id", ondelete="RESTRICT"), nullable=False)
    gauge = Column(SmallInteger, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False)
    tracked_count = Column(Integer, default=0)

    run_items = relationship("RunItem", back_populates="run", cascade="all, delete-orphan")


class RunItem(Base):
    __tablename__ = "run_items"
    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String(64), ForeignKey("runs.id", ondelete="CASCADE"), nullable=False)
    drop_type_id = Column(SmallInteger, ForeignKey("drop_types.id", ondelete="RESTRICT"), nullable=False)
    label = Column(String(32), nullable=False)
    ocr_text = Column(Text)
    ocr_confidence = Column(Float)
    verified = Column(Boolean, default=False)
    image_filename = Column(String(256))
    bbox = Column(JSONB)
    confidence = Column(Float)
    item_index = Column(Integer)

    run = relationship("Run", back_populates="run_items")

    __table_args__ = (
        Index("idx_run_items_run_id", "run_id"),
        Index("idx_run_items_drop_type_id", "drop_type_id"),
    )
