from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from alibaba_customer_dev_assistant.automation.cdp_client import CdpClient, CdpError, list_pages
from alibaba_customer_dev_assistant.core.parsing import stable_hash


PUBLIC_POOL_CAPTURE_JS = r"""
(() => {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const clickable = Array.from(document.querySelectorAll("a,button,span,div,[role='button']"))
    .filter(visible);
  const addButtons = clickable.filter((el) => norm(el.innerText || el.textContent || el.title).includes("加为我的客户"));
  const rowFor = (el) => {
    const tableRow = el.closest("tr,[role='row']");
    if (tableRow) return tableRow;
    let current = el;
    let best = el;
    for (let i = 0; i < 10 && current && current.parentElement; i += 1) {
      current = current.parentElement;
      const rect = current.getBoundingClientRect();
      const text = norm(current.innerText || current.textContent);
      if (rect.width > window.innerWidth * 0.45 && rect.height >= 45 && rect.height <= 180 && text.length > 8) {
        best = current;
        break;
      }
    }
    return best;
  };
  const rows = addButtons.map((button, index) => {
    const row = rowFor(button);
    const rect = row.getBoundingClientRect();
    const text = norm(row.innerText || row.textContent);
    return {
      index,
      text,
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  });
  return {
    title: document.title,
    url: location.href,
    addButtonCount: addButtons.length,
    rows
  };
})()
"""


def start_smart_browser(root: Path, port: int = 9222) -> None:
    script = root / "start_smart_browser.bat"
    subprocess.Popen(["cmd", "/c", str(script)], cwd=root)


def capture_public_pool_rows(port: int = 9222) -> list[dict[str, str]]:
    pages = list_pages(port)
    page = select_alibaba_page(pages)
    client = CdpClient(page.websocket_url)
    try:
        payload = client.evaluate(PUBLIC_POOL_CAPTURE_JS)
    finally:
        client.close()

    if not payload or not payload.get("rows"):
        raise CdpError("智能浏览器已连接，但页面中没有找到“加为我的客户”。请确认当前页是公海客户列表。")
    return [parse_dom_row(row["text"]) for row in payload["rows"] if row.get("text")]


def select_alibaba_page(pages):
    candidates = [
        page
        for page in pages
        if "i.alibaba.com" in page.url or "alibaba" in page.url.lower() or "Alibaba" in page.title
    ]
    if not candidates:
        titles = "\n".join(f"- {page.title}: {page.url}" for page in pages[:8])
        raise CdpError(f"智能浏览器里没有找到阿里公海页面。当前页面：\n{titles}")
    return candidates[0]


def parse_dom_row(text: str) -> dict[str, str]:
    parts = [part.strip() for part in re.split(r"\s{2,}|\n", text) if part.strip()]
    compact = " ".join(parts)
    level_match = re.search(r"\bL[1-5]\b", compact)
    date_match = re.search(r"\b20\d{2}-\d{2}-\d{2}\b", compact)
    follow = first_contains(parts, ("TM沟通", "RFQ报价", "公海召回"))
    stage = first_contains(parts, ("未标记", "已标记"))
    amount = first_contains(parts, ("采购额",))
    email = first_regex(parts, r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
    name = first_customer_name(parts)
    return {
        "list_row_hash": stable_hash(text),
        "customer_name": name,
        "customer_level": level_match.group(0) if level_match else "",
        "email": email,
        "country": "",
        "customer_stage": stage,
        "follow_status": follow,
        "note_time": date_match.group(0) if date_match else "",
        "purchase_intention": "",
        "annual_purchase_amount": amount,
        "purchase_category": "",
        "customer_source": "",
        "raw_list_text": text,
    }


def first_customer_name(parts: list[str]) -> str:
    skip_keywords = ("加为我的客户", "未标记", "TM沟通", "RFQ报价", "无采购额", "采购")
    for part in parts:
        if any(keyword in part for keyword in skip_keywords):
            continue
        if re.fullmatch(r"L[1-5]", part):
            continue
        if re.fullmatch(r"20\d{2}-\d{2}-\d{2}", part):
            continue
        if len(part) >= 2:
            return part
    return parts[0] if parts else ""


def first_contains(parts: list[str], keywords: tuple[str, ...]) -> str:
    return next((part for part in parts if any(keyword in part for keyword in keywords)), "")


def first_regex(parts: list[str], pattern: str) -> str:
    for part in parts:
        match = re.search(pattern, part)
        if match:
            return match.group(0)
    return ""
