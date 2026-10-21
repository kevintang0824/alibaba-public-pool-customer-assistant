from __future__ import annotations

from datetime import datetime
from pathlib import Path

from alibaba_customer_dev_assistant.automation.uia_driver import UiaDriver
from alibaba_customer_dev_assistant.core.models import RunConfig


def write_window_diagnostics(config: RunConfig, logs_dir: Path) -> Path:
    logs_dir.mkdir(parents=True, exist_ok=True)
    driver = UiaDriver(
        config.window_title_keywords,
        action_timeout_seconds=config.action_timeout_seconds,
        prefer_active_window=config.prefer_active_window,
        selected_window_title=config.selected_window_title,
    )
    ref = driver.attach_main_window()
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = logs_dir / f"uia_diagnostics_{stamp}.txt"
    visible_text = driver.get_visible_text()
    tree_text = driver.dump_tree_text(max_depth=7)
    all_windows = "\n".join(driver.list_windows())
    path.write_text(
        "\n".join(
            [
                "=== Selected Window ===",
                ref.name,
                "",
                "=== All Windows ===",
                all_windows,
                "",
                "=== Visible Text ===",
                visible_text,
                "",
                "=== Control Tree ===",
                tree_text,
                "",
            ]
        ),
        encoding="utf-8",
    )
    return path
