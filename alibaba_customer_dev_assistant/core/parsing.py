from __future__ import annotations

import hashlib
import re


LIST_FIELD_NAMES = (
    "客户名称",
    "客户等级",
    "邮箱",
    "国家",
    "客户阶段",
    "跟进状态",
    "小记时间",
    "采购意向",
    "年采购额",
    "采购品类",
    "客户来源",
)


def stable_hash(text: str) -> str:
    normalized = re.sub(r"\s+", " ", text).strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def parse_customer_rows(visible_text: str) -> list[dict[str, str]]:
    lines = [line.strip() for line in visible_text.splitlines() if line.strip()]
    data_lines = [
        line
        for line in lines
        if not any(header == line for header in LIST_FIELD_NAMES)
        and "加为我的客户" not in line
        and "更多筛选项" not in line
    ]
    rows = []
    current: list[str] = []
    for line in data_lines:
        if looks_like_row_start(line) and current:
            rows.append(build_row(current))
            current = [line]
        else:
            current.append(line)
    if current:
        rows.append(build_row(current))
    return [row for row in rows if row.get("customer_name")]


def looks_like_row_start(line: str) -> bool:
    if re.match(r"^\d{4}-\d{2}-\d{2}$", line):
        return False
    if line in {"未标记", "TM沟通", "公海召回", "无采购额", "无潜力分"}:
        return False
    return bool(re.search(r"[A-Za-z\u4e00-\u9fff]", line)) and len(line) >= 2


def build_row(parts: list[str]) -> dict[str, str]:
    text = "\n".join(parts)
    level = next((part for part in parts if re.fullmatch(r"L[1-5]", part)), "")
    date = next((part for part in parts if re.fullmatch(r"\d{4}-\d{2}-\d{2}", part)), "")
    email = next((part for part in parts if "@" in part), "")
    follow = next((part for part in parts if part in {"TM沟通", "公海召回"}), "")
    stage = next((part for part in parts if part in {"未标记", "已标记"}), "")
    amount = next((part for part in parts if "采购额" in part), "")
    return {
        "list_row_hash": stable_hash(text),
        "customer_name": parts[0] if parts else "",
        "customer_level": level,
        "email": email,
        "country": "",
        "customer_stage": stage,
        "follow_status": follow,
        "note_time": date,
        "purchase_intention": "",
        "annual_purchase_amount": amount,
        "purchase_category": "",
        "customer_source": "",
        "raw_list_text": text,
    }


def parse_detail_fields(visible_text: str) -> dict[str, str]:
    return {
        "customer_id": find_after_label(visible_text, ("customerId", "客户ID", "ID")),
        "customer_name": find_after_label(visible_text, ("客户名称", "公司名称")),
        "email": find_email(visible_text),
        "country": find_after_label(visible_text, ("国家", "地区")),
        "identity_level": find_after_label(visible_text, ("身份等级", "客户等级")),
        "customer_source": find_after_label(visible_text, ("客户来源",)),
        "registered_at": find_after_label(visible_text, ("注册时间",)),
        "established_at": find_after_label(visible_text, ("建立时间",)),
        "annual_purchase_amount": find_after_label(visible_text, ("年采购额",)),
        "business_type": find_after_label(visible_text, ("商业类型",)),
        "raw_detail_text": visible_text,
    }


def find_after_label(text: str, labels: tuple[str, ...]) -> str:
    for label in labels:
        pattern = re.compile(re.escape(label) + r"[:：]?\s*([^\n\r]+)")
        match = pattern.search(text)
        if match:
            return match.group(1).strip()
    return ""


def find_email(text: str) -> str:
    match = re.search(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", text)
    return match.group(0) if match else ""
