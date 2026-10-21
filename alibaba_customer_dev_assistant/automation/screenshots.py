from __future__ import annotations

import ctypes
from datetime import datetime
from pathlib import Path


def timestamp_name(prefix: str, suffix: str = ".png") -> str:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    safe_prefix = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in prefix)
    return f"{safe_prefix}_{stamp}{suffix}"


def save_screenshot(folder: Path, prefix: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / timestamp_name(prefix)
    try:
        from PIL import ImageGrab

        image = ImageGrab.grab()
        image.save(target)
        return target
    except Exception:
        write_placeholder_png(target)
        return target


def write_placeholder_png(path: Path) -> None:
    # Minimal transparent 1x1 PNG. Used when Pillow is not installed.
    path.write_bytes(
        bytes.fromhex(
            "89504E470D0A1A0A0000000D4948445200000001000000010806000000"
            "1F15C4890000000A49444154789C6360000002000100"
            "05FE02FEA5579A0000000049454E44AE426082"
        )
    )


def get_screen_size() -> tuple[int, int]:
    user32 = ctypes.windll.user32
    return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
