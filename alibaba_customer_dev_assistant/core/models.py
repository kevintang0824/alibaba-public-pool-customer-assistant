from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path


class TaskStatus(StrEnum):
    NEW = "NEW"
    LIST_CAPTURED = "LIST_CAPTURED"
    DETAIL_OPENED = "DETAIL_OPENED"
    CUSTOMER_ADDED = "CUSTOMER_ADDED"
    CHAT_OPENED = "CHAT_OPENED"
    OKKI_OPENED = "OKKI_OPENED"
    REPLY_GENERATED = "REPLY_GENERATED"
    TEXT_FILLED = "TEXT_FILLED"
    TEXT_SENT = "TEXT_SENT"
    VIDEO_SENT = "VIDEO_SENT"
    DONE = "DONE"
    FAILED = "FAILED"
    NEED_MANUAL = "NEED_MANUAL"


@dataclass(frozen=True)
class AppPaths:
    root: Path
    database: Path
    logs: Path
    screenshots: Path


@dataclass
class RunConfig:
    max_customers: int = 1
    require_confirm_before_send: bool = True
    dry_run: bool = True
    video_default_path: str = ""
    video_l3_path: str = ""
    video_l4_path: str = ""
    auto_apply_l3_l4_filter: bool = False
    window_title_keywords: tuple[str, ...] = (
        "阿里巴巴国际站",
        "Alibaba",
        "My Alibaba",
        "工作台",
        "OKKI",
        "Google Chrome",
        "接待中心",
    )
    prefer_active_window: bool = True
    selected_window_title: str = ""
    okki_timeout_seconds: int = 45
    action_timeout_seconds: int = 15
