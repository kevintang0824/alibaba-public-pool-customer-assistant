from __future__ import annotations

from pathlib import Path
from tkinter import Tk

from alibaba_customer_dev_assistant.core.models import AppPaths
from alibaba_customer_dev_assistant.ui.desktop_console import DesktopConsole


def build_paths() -> AppPaths:
    root = Path(__file__).resolve().parent
    return AppPaths(
        root=root,
        database=root / "data" / "assistant.db",
        logs=root / "logs",
        screenshots=root / "screenshots",
    )


def main() -> None:
    paths = build_paths()
    paths.logs.mkdir(parents=True, exist_ok=True)
    paths.screenshots.mkdir(parents=True, exist_ok=True)
    root = Tk()
    DesktopConsole(root, paths)
    root.mainloop()


if __name__ == "__main__":
    main()
