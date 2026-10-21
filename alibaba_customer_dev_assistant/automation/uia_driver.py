from __future__ import annotations

import time
import ctypes
from dataclasses import dataclass
from typing import Iterable

from alibaba_customer_dev_assistant.core.errors import AutomationStepFailed, NeedManualIntervention


@dataclass
class ControlRef:
    control: object
    name: str
    control_type: str = ""


class UiaDriver:
    def __init__(
        self,
        title_keywords: Iterable[str],
        action_timeout_seconds: int = 15,
        prefer_active_window: bool = True,
        selected_window_title: str = "",
    ):
        import uiautomation as auto

        self.auto = auto
        self.title_keywords = tuple(title_keywords)
        self.action_timeout_seconds = action_timeout_seconds
        self.prefer_active_window = prefer_active_window
        self.selected_window_title = selected_window_title.strip()
        self.window = None
        self.native_hwnd = 0
        self.native_title = ""

    def attach_main_window(self) -> ControlRef:
        if self.selected_window_title:
            native = self._find_native_window(self.selected_window_title)
            if native is not None:
                self.native_hwnd, self.native_title = native
                self.window = self._find_uia_window_by_handle(self.native_hwnd)
                self._activate_native(self.native_hwnd)
                return ControlRef(self.window, self.native_title, "Window")
            selected = self._find_window_by_title(self.selected_window_title)
            if selected is not None:
                self.window = selected
                self.native_hwnd = self._native_handle(selected)
                self.native_title = selected.Name or self.selected_window_title
                self._activate(selected)
                return ControlRef(selected, self.native_title, "Window")

        if self.prefer_active_window:
            active = self.auto.GetForegroundControl()
            active_window = self._as_window(active)
            if active_window is not None:
                name = active_window.Name or ""
                if name and not self._is_own_tool_window(name):
                    self.window = active_window
                    self.native_hwnd = self._native_handle(active_window)
                    self.native_title = name
                    return ControlRef(active_window, name, "Window")

        deadline = time.time() + self.action_timeout_seconds
        while time.time() < deadline:
            root = self.auto.GetRootControl()
            for window in root.GetChildren():
                name = window.Name or ""
                if any(keyword.lower() in name.lower() for keyword in self.title_keywords):
                    self.window = window
                    self.native_hwnd = self._native_handle(window)
                    self.native_title = name
                    self._activate(window)
                    return ControlRef(window, name, "Window")
            time.sleep(0.5)
        raise NeedManualIntervention(
            "未识别到阿里国际站客户端窗口。请先打开客户端并进入客户管理页面。"
        )

    def list_windows(self) -> list[str]:
        root = self.auto.GetRootControl()
        names = []
        for window in root.GetChildren():
            name = window.Name or ""
            if name:
                names.append(name)
        return names

    def active_window(self):
        if self.window is None:
            return self.attach_main_window().control
        return self.window

    def find_first(
        self,
        *,
        names: Iterable[str],
        control_types: Iterable[str] = (),
        root: object | None = None,
        timeout: float | None = None,
        max_depth: int = 5,
        max_nodes: int = 600,
    ) -> ControlRef:
        root_control = root or self.active_window()
        deadline = time.time() + (timeout or self.action_timeout_seconds)
        name_list = tuple(names)
        type_list = tuple(control_types)
        while time.time() < deadline:
            matched = self._walk_find(
                root_control,
                name_list,
                type_list,
                max_depth=max_depth,
                max_nodes=max_nodes,
                deadline=deadline,
            )
            if matched:
                return matched
            time.sleep(0.4)
        raise AutomationStepFailed("find_control", f"找不到控件：{', '.join(name_list)}")

    def click_text(
        self,
        names: Iterable[str],
        *,
        control_types: Iterable[str] = ("ButtonControl", "TextControl", "HyperlinkControl", "TabItemControl"),
        timeout: float | None = None,
        max_depth: int = 5,
        max_nodes: int = 600,
    ) -> ControlRef:
        ref = self.find_first(
            names=names,
            control_types=control_types,
            timeout=timeout,
            max_depth=max_depth,
            max_nodes=max_nodes,
        )
        self.safe_click(ref)
        return ref

    def safe_click(self, ref: ControlRef) -> None:
        control = ref.control
        try:
            control.SetFocus()
        except Exception:
            pass
        try:
            control.Click()
            return
        except Exception:
            pass
        try:
            rect = control.BoundingRectangle
            x = int((rect.left + rect.right) / 2)
            y = int((rect.top + rect.bottom) / 2)
            self.auto.Click(x, y)
        except Exception as error:
            raise AutomationStepFailed("click_control", f"点击控件失败：{ref.name}") from error

    def window_rect(self) -> tuple[int, int, int, int]:
        self.active_window()
        if self.native_hwnd:
            self._activate_native(self.native_hwnd)
            rect = self._native_rect(self.native_hwnd)
            if rect is not None:
                return rect
        window = self.active_window()
        self._activate(window)
        try:
            rect = window.BoundingRectangle
            left = int(rect.left)
            top = int(rect.top)
            right = int(rect.right)
            bottom = int(rect.bottom)
        except Exception as error:
            raise AutomationStepFailed("window_rect", "无法读取目标窗口位置。") from error
        if right <= left or bottom <= top:
            raise AutomationStepFailed("window_rect", "目标窗口位置异常，请确认窗口没有最小化。")
        return left, top, right, bottom

    def click_relative(self, x_ratio: float, y_ratio: float, label: str = "窗口内位置") -> tuple[int, int]:
        left, top, right, bottom = self.window_rect()
        width = right - left
        height = bottom - top
        x = int(left + width * x_ratio)
        y = int(top + height * y_ratio)
        try:
            self.auto.Click(x, y)
        except Exception as error:
            raise AutomationStepFailed("click_relative", f"点击{label}失败。") from error
        return x, y

    def click_text_or_relative(
        self,
        names: Iterable[str],
        *,
        x_ratio: float,
        y_ratio: float,
        label: str,
        timeout: float | None = None,
        max_depth: int = 5,
        max_nodes: int = 600,
    ) -> str:
        try:
            ref = self.click_text(
                names,
                timeout=timeout,
                max_depth=max_depth,
                max_nodes=max_nodes,
            )
            return f"控件：{ref.name}"
        except AutomationStepFailed:
            x, y = self.click_relative(x_ratio, y_ratio, label)
            return f"窗口位置：{label} ({x}, {y})"

    def get_visible_text(self) -> str:
        return self._collect_text(self.active_window(), max_depth=5, max_nodes=700, deadline_seconds=8.0)

    def dump_tree_text(
        self,
        max_depth: int = 4,
        max_nodes: int = 500,
        deadline_seconds: float = 8.0,
    ) -> str:
        lines = []
        visited = 0
        deadline = time.time() + deadline_seconds

        def walk(control: object, depth: int = 0) -> None:
            nonlocal visited
            if depth > max_depth:
                return
            if visited >= max_nodes or time.time() > deadline:
                return
            visited += 1
            try:
                name = control.Name or ""
                control_type = control.ControlTypeName or ""
                if name or control_type:
                    lines.append(f"{'  ' * depth}{control_type}: {name}")
                for child in control.GetChildren():
                    walk(child, depth + 1)
            except Exception:
                return

        walk(self.active_window())
        if visited >= max_nodes:
            lines.append(f"... stopped after {max_nodes} nodes")
        elif time.time() > deadline:
            lines.append(f"... stopped after {deadline_seconds:.1f}s")
        return "\n".join(lines)

    def detect_blocking_state(self) -> None:
        text = self.get_visible_text()
        blocking_keywords = (
            "验证码",
            "安全验证",
            "登录",
            "重新登录",
            "账号异常",
            "无权限",
            "OKKI未加载",
            "加载失败",
        )
        for keyword in blocking_keywords:
            if keyword in text:
                raise NeedManualIntervention(f"检测到需要人工处理：{keyword}")

    def _walk_find(
        self,
        root: object,
        names: tuple[str, ...],
        control_types: tuple[str, ...],
        depth: int = 0,
        max_depth: int = 8,
        max_nodes: int = 1000,
        deadline: float | None = None,
        _state: dict[str, int] | None = None,
    ) -> ControlRef | None:
        if _state is None:
            _state = {"count": 0}
        if depth > max_depth or _state["count"] >= max_nodes:
            return None
        if deadline is not None and time.time() > deadline:
            return None
        _state["count"] += 1
        try:
            children = root.GetChildren()
        except Exception:
            return None
        for child in children:
            child_name = child.Name or ""
            child_type = child.ControlTypeName or ""
            name_match = any(name in child_name for name in names)
            type_match = not control_types or child_type in control_types
            if child_name and name_match and type_match:
                return ControlRef(child, child_name, child_type)
            found = self._walk_find(
                child,
                names,
                control_types,
                depth + 1,
                max_depth,
                max_nodes,
                deadline,
                _state,
            )
            if found:
                return found
        return None

    def _collect_text(
        self,
        root: object,
        depth: int = 0,
        max_depth: int = 5,
        max_nodes: int = 700,
        deadline_seconds: float = 8.0,
        _state: dict[str, float] | None = None,
    ) -> str:
        if _state is None:
            _state = {"count": 0, "deadline": time.time() + deadline_seconds}
        if depth > max_depth or _state["count"] >= max_nodes or time.time() > _state["deadline"]:
            return ""
        _state["count"] += 1
        chunks = []
        try:
            name = root.Name or ""
            if name:
                chunks.append(name)
            for child in root.GetChildren():
                text = self._collect_text(child, depth + 1, max_depth, max_nodes, deadline_seconds, _state)
                if text:
                    chunks.append(text)
        except Exception:
            return ""
        return "\n".join(chunks)

    def _as_window(self, control: object | None):
        current = control
        for _ in range(8):
            if current is None:
                return None
            try:
                if current.ControlTypeName == "WindowControl":
                    return current
                current = current.GetParentControl()
            except Exception:
                return None
        return None

    def _is_own_tool_window(self, name: str) -> bool:
        return "公海客户开发助手" in name or "阿里国际站公海客户开发助手" in name

    def _activate(self, control: object) -> None:
        self._activate_native(self._native_handle(control))

    def _native_handle(self, control: object | None) -> int:
        if control is None:
            return 0
        try:
            return int(control.NativeWindowHandle)
        except Exception:
            return 0

    def _activate_native(self, hwnd: int) -> None:
        if not hwnd:
            return
        try:
            user32 = ctypes.windll.user32
            user32.ShowWindowAsync(hwnd, 9)
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
            flags = 0x0001 | 0x0002 | 0x0040
            user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, flags)
            user32.SetWindowPos(hwnd, -2, 0, 0, 0, 0, flags)
        except Exception:
            pass

    def _native_rect(self, hwnd: int) -> tuple[int, int, int, int] | None:
        if not hwnd:
            return None
        class Rect(ctypes.Structure):
            _fields_ = [
                ("left", ctypes.c_long),
                ("top", ctypes.c_long),
                ("right", ctypes.c_long),
                ("bottom", ctypes.c_long),
            ]

        rect = Rect()
        try:
            ok = ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect))
        except Exception:
            return None
        if not ok:
            return None
        left, top, right, bottom = int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)
        if right <= left or bottom <= top:
            return None
        return left, top, right, bottom

    def _find_uia_window_by_handle(self, hwnd: int):
        if not hwnd:
            return None
        try:
            root = self.auto.GetRootControl()
            for window in root.GetChildren():
                if self._native_handle(window) == hwnd:
                    return window
        except Exception:
            return None
        return None

    def _find_native_window(self, title: str) -> tuple[int, str] | None:
        if not title:
            return None
        user32 = ctypes.windll.user32
        candidates: list[tuple[int, str, int]] = []

        class Rect(ctypes.Structure):
            _fields_ = [
                ("left", ctypes.c_long),
                ("top", ctypes.c_long),
                ("right", ctypes.c_long),
                ("bottom", ctypes.c_long),
            ]

        enum_proc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

        def callback(hwnd: int, _lparam: int) -> bool:
            if not user32.IsWindowVisible(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            if length <= 0:
                return True
            buffer = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buffer, length + 1)
            name = buffer.value
            if not name or self._is_own_tool_window(name):
                return True
            exact = name == title
            partial = title in name or name in title
            if not exact and not partial:
                return True
            rect = Rect()
            if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                return True
            area = max(0, int(rect.right) - int(rect.left)) * max(0, int(rect.bottom) - int(rect.top))
            score = area + (10_000_000_000 if exact else 0)
            candidates.append((int(hwnd), name, score))
            return True

        try:
            user32.EnumWindows(enum_proc(callback), 0)
        except Exception:
            return None
        if not candidates:
            return None
        hwnd, name, _score = max(candidates, key=lambda item: item[2])
        return hwnd, name

    def _find_window_by_title(self, title: str):
        root = self.auto.GetRootControl()
        for window in root.GetChildren():
            name = window.Name or ""
            if name == title:
                return window
        matches = []
        for window in root.GetChildren():
            name = window.Name or ""
            if not name:
                continue
            if title in name or name in title:
                matches.append(window)
        if not matches:
            return None
        return max(matches, key=self._window_area)

    def _window_area(self, window: object) -> int:
        try:
            rect = window.BoundingRectangle
            width = max(0, int(rect.right) - int(rect.left))
            height = max(0, int(rect.bottom) - int(rect.top))
            return width * height
        except Exception:
            return 0
