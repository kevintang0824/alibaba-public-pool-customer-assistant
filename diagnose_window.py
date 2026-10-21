from __future__ import annotations

import argparse
import multiprocessing as mp
import sys
from pathlib import Path

from alibaba_customer_dev_assistant.automation.diagnostics import write_window_diagnostics
from alibaba_customer_dev_assistant.core.models import RunConfig


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Write UI Automation diagnostics for a target window.")
    parser.add_argument("--window-title", default="", help="Exact or partial target window title.")
    parser.add_argument("--prefer-active", action="store_true", help="Prefer current foreground window.")
    parser.add_argument("--timeout", type=int, default=15, help="Max seconds before stopping diagnostics.")
    return parser.parse_args()


def run_diagnostics(args: argparse.Namespace, queue: mp.Queue) -> None:
    root = Path(__file__).resolve().parent
    path = write_window_diagnostics(
        RunConfig(
            prefer_active_window=bool(args.prefer_active),
            selected_window_title=args.window_title,
        ),
        root / "logs",
    )
    queue.put(("ok", f"诊断已保存：{path}"))


def main() -> int:
    args = parse_args()
    queue: mp.Queue = mp.Queue(maxsize=1)
    process = mp.Process(target=run_diagnostics, args=(args, queue), daemon=True)
    process.start()
    process.join(args.timeout)
    if process.is_alive():
        process.terminate()
        process.join(3)
        print("诊断超时：目标窗口控件树读取过慢或卡住。请换一个目标窗口，或用 start_accessible_chrome.bat 打开页面后再诊断。")
        return 2
    if not queue.empty():
        status, message = queue.get()
        print(message)
        return 0 if status == "ok" else 1
    if process.exitcode:
        print(f"诊断失败，进程状态码：{process.exitcode}")
        return int(process.exitcode)
    print("诊断结束，但没有返回诊断文件。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
