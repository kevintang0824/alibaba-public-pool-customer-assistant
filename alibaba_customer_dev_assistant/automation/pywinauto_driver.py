from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from alibaba_customer_dev_assistant.core.errors import NeedManualIntervention


@dataclass
class WindowInfo:
    title: str
    handle: int


class PywinautoDriver:
    def __init__(self, title_keywords: Iterable[str]):
        from pywinauto import Desktop

        self.desktop = Desktop(backend="uia")
        self.title_keywords = tuple(title_keywords)

    def list_candidate_windows(self) -> list[WindowInfo]:
        result = []
        for window in self.desktop.windows():
            title = window.window_text()
            if any(keyword.lower() in title.lower() for keyword in self.title_keywords):
                result.append(WindowInfo(title=title, handle=int(window.handle)))
        return result

    def ensure_window_exists(self) -> WindowInfo:
        windows = self.list_candidate_windows()
        if not windows:
            raise NeedManualIntervention("未找到阿里国际站客户端窗口。")
        return windows[0]
