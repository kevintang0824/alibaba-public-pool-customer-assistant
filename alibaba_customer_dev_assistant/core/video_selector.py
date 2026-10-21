from __future__ import annotations

from .models import RunConfig


def select_video_path(customer: dict[str, str], config: RunConfig) -> str:
    level = (customer.get("customer_level") or "").upper()
    if level == "L3" and config.video_l3_path:
        return config.video_l3_path
    if level == "L4" and config.video_l4_path:
        return config.video_l4_path
    return config.video_default_path
