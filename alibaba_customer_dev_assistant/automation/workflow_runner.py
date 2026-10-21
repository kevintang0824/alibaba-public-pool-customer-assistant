from __future__ import annotations

import time
from pathlib import Path
from typing import Callable

from alibaba_customer_dev_assistant.automation.screenshots import save_screenshot
from alibaba_customer_dev_assistant.automation.uia_driver import UiaDriver
from alibaba_customer_dev_assistant.core.database import Database
from alibaba_customer_dev_assistant.core.errors import AutomationStepFailed, DependencyMissing, NeedManualIntervention
from alibaba_customer_dev_assistant.core.models import AppPaths, RunConfig, TaskStatus
from alibaba_customer_dev_assistant.core.parsing import parse_customer_rows, parse_detail_fields
from alibaba_customer_dev_assistant.core.video_selector import select_video_path


ProgressCallback = Callable[[str], None]
ConfirmCallback = Callable[[str, str], bool]


class WorkflowRunner:
    def __init__(
        self,
        *,
        db: Database,
        paths: AppPaths,
        config: RunConfig,
        progress: ProgressCallback | None = None,
        confirm_send: ConfirmCallback | None = None,
    ):
        self.db = db
        self.paths = paths
        self.config = config
        self.progress = progress or (lambda message: None)
        self.confirm_send = confirm_send or (lambda customer, text: False)
        self.driver: UiaDriver | None = None

    def _driver(self) -> UiaDriver:
        if self.driver is None:
            try:
                self.driver = UiaDriver(
                    self.config.window_title_keywords,
                    action_timeout_seconds=self.config.action_timeout_seconds,
                    prefer_active_window=self.config.prefer_active_window,
                    selected_window_title=self.config.selected_window_title,
                )
            except ModuleNotFoundError as error:
                raise DependencyMissing("缺少 uiautomation，请先安装 requirements.txt。") from error
        return self.driver

    def capture_customer_list(self) -> list[int]:
        driver = self._driver()
        self.progress("正在识别阿里国际站客户端窗口...")
        driver.attach_main_window()
        driver.detect_blocking_state()
        self.ensure_public_pool_page()
        if self.config.auto_apply_l3_l4_filter:
            self.apply_buyer_level_filter()
        else:
            self.progress("已跳过自动筛选，请确认当前页面已手动筛选好客户。")
        driver.detect_blocking_state()
        visible_text = driver.get_visible_text()
        rows = parse_customer_rows(visible_text)
        if not rows:
            screenshot = self.capture("list_capture_empty")
            title = getattr(driver.active_window(), "Name", "") or ""
            raise NeedManualIntervention(
                "没有解析到客户列表。"
                f"当前窗口：{title}；可见文字长度：{len(visible_text)}。"
                "如果当前是 Chrome 页面，请用诊断功能确认页面内容是否能被 UIA 读取；"
                "若只能看到浏览器标题，需用可访问性模式打开浏览器或启用OCR。",
                screenshot_path=str(screenshot),
            )

        customer_ids = []
        for row in rows[: self.config.max_customers]:
            customer_pk = self.db.upsert_customer_from_list(row)
            customer_ids.append(customer_pk)
            self.db.log(action="capture_list_row", customer_pk=customer_pk, message=row.get("customer_name", ""))
        self.progress(f"已抓取 {len(customer_ids)} 个可见客户。")
        return customer_ids

    def run_mvp(self) -> None:
        customer_ids = self.capture_customer_list()
        for customer_pk in customer_ids:
            task_id = self.db.create_task(customer_pk)
            try:
                self.process_customer(customer_pk, task_id)
            except NeedManualIntervention as error:
                screenshot = error.screenshot_path or str(self.capture("need_manual"))
                self.db.set_task_status(
                    task_id,
                    TaskStatus.NEED_MANUAL,
                    failure_reason=error.reason,
                    screenshot_path=screenshot,
                )
                self.db.log(
                    action="need_manual",
                    level="WARN",
                    status=TaskStatus.NEED_MANUAL.value,
                    message=error.reason,
                    task_id=task_id,
                    customer_pk=customer_pk,
                    screenshot_path=screenshot,
                )
                self.progress(f"需要人工处理：{error.reason}")
                break
            except AutomationStepFailed as error:
                screenshot = error.screenshot_path or str(self.capture("failed"))
                self.db.set_task_status(
                    task_id,
                    TaskStatus.FAILED,
                    failure_reason=error.reason,
                    screenshot_path=screenshot,
                )
                self.db.log(
                    action=error.action,
                    level="ERROR",
                    status=TaskStatus.FAILED.value,
                    message=error.reason,
                    task_id=task_id,
                    customer_pk=customer_pk,
                    screenshot_path=screenshot,
                )
                self.progress(f"失败：{error.reason}")
                continue

    def process_customer(self, customer_pk: int, task_id: int) -> None:
        self.db.set_task_status(task_id, TaskStatus.LIST_CAPTURED)
        self.open_customer_detail(customer_pk, task_id)
        self.add_customer(task_id)
        self.open_chat(task_id)
        generated = self.open_okki_and_generate_reply(task_id)
        self.fill_reply(task_id)
        sent_text = generated or "OKKI生成回复，已填入输入框"
        if self.config.require_confirm_before_send and not self.confirm_send(str(customer_pk), sent_text):
            raise NeedManualIntervention("用户取消发送，任务暂停。")
        self.send_text(task_id)
        video_path = self.send_video(customer_pk, task_id)
        self.db.insert_message(
            customer_pk,
            task_id,
            generated_text=generated,
            sent_text=sent_text,
            video_path=video_path,
            text_sent=True,
            video_sent=bool(video_path),
        )
        self.db.set_task_status(task_id, TaskStatus.DONE)
        self.db.log(action="done", status=TaskStatus.DONE.value, task_id=task_id, customer_pk=customer_pk)

    def ensure_public_pool_page(self) -> None:
        driver = self._driver()
        text = driver.get_visible_text()
        if "公海客户" in text:
            return
        if len(text) > 30 and any(keyword in text for keyword in ("客户", "加为我的客户", "TM沟通", "采购")):
            self.progress("当前窗口看起来已是客户列表，继续抓取当前可见页面。")
            return
        self.progress("尝试进入 客户管理 -> 公海客户...")
        try:
            driver.click_text(("客户管理",), timeout=8)
            driver.click_text(("公海客户",), timeout=8)
            time.sleep(1)
            driver.detect_blocking_state()
        except AutomationStepFailed:
            self.progress("未自动进入公海客户页，将尝试抓取当前窗口。")
            return
        if "公海客户" not in driver.get_visible_text():
            self.progress("未确认公海客户页标题，将继续尝试抓取当前窗口。")

    def apply_buyer_level_filter(self) -> None:
        driver = self._driver()
        text = driver.get_visible_text()
        if "L3" in text and "L4" in text and "更多筛选项" in text:
            self.progress("当前页面已可见筛选项，继续确认买家分层。")
        self.progress("设置买家分层筛选：L3、L4。")
        try:
            driver.click_text(("更多筛选项",), timeout=6)
            time.sleep(0.5)
            driver.click_text(("买家分层",), timeout=6)
            driver.click_text(("L3",), timeout=6)
            driver.click_text(("L4",), timeout=6)
            driver.click_text(("确定", "应用", "筛选"), timeout=6)
            time.sleep(1.5)
        except AutomationStepFailed:
            raise NeedManualIntervention("无法自动设置 L3/L4 筛选，请人工筛选后重新点击开始。")

    def open_customer_detail(self, customer_pk: int, task_id: int) -> None:
        driver = self._driver()
        self.progress("打开客户详情...")
        driver.detect_blocking_state()
        # The list parser stores the visible first line as the customer name.
        # For MVP, click the first visible customer-like text if exact row matching is not available.
        text = driver.get_visible_text()
        rows = parse_customer_rows(text)
        if not rows:
            raise NeedManualIntervention("客户列表已变化，找不到可打开的客户。")
        target_name = rows[0]["customer_name"]
        driver.click_text((target_name,), timeout=8)
        time.sleep(1.2)
        driver.detect_blocking_state()
        detail = parse_detail_fields(driver.get_visible_text())
        self.db.update_customer_detail(customer_pk, detail)
        self.db.set_task_status(task_id, TaskStatus.DETAIL_OPENED)

    def add_customer(self, task_id: int) -> None:
        driver = self._driver()
        self.progress("点击加为我的客户...")
        driver.click_text(("加为我的客户",), timeout=10)
        time.sleep(1)
        driver.detect_blocking_state()
        self.db.set_task_status(task_id, TaskStatus.CUSTOMER_ADDED)

    def open_chat(self, task_id: int) -> None:
        driver = self._driver()
        self.progress("打开旺旺/TM沟通...")
        try:
            driver.click_text(("TM沟通", "旺旺", "联系", "聊天"), timeout=10)
        except AutomationStepFailed as error:
            raise NeedManualIntervention("未找到旺旺/TM沟通入口，请人工打开聊天窗口。") from error
        time.sleep(2)
        driver.detect_blocking_state()
        self.db.set_task_status(task_id, TaskStatus.CHAT_OPENED)

    def open_okki_and_generate_reply(self, task_id: int) -> str:
        driver = self._driver()
        self.progress("打开 OKKI 销售助手并触发辅助回复...")
        driver.click_text(("OKKI销售助手", "OKKI 销售助手"), timeout=20)
        self.db.set_task_status(task_id, TaskStatus.OKKI_OPENED)
        driver.detect_blocking_state()
        driver.click_text(("辅助回复",), timeout=20)
        deadline = time.time() + self.config.okki_timeout_seconds
        last_text = ""
        while time.time() < deadline:
            driver.detect_blocking_state()
            visible_text = driver.get_visible_text()
            if "填入输入框" in visible_text:
                self.db.set_task_status(task_id, TaskStatus.REPLY_GENERATED)
                return extract_generated_reply(visible_text)
            last_text = visible_text
            time.sleep(1)
        screenshot = self.capture("okki_timeout")
        raise NeedManualIntervention(
            "OKKI未在限定时间内生成回复，请人工处理。",
            screenshot_path=str(screenshot),
        )

    def fill_reply(self, task_id: int) -> None:
        driver = self._driver()
        self.progress("将 OKKI 回复填入输入框...")
        driver.click_text(("填入输入框",), timeout=10)
        time.sleep(0.5)
        self.db.set_task_status(task_id, TaskStatus.TEXT_FILLED)

    def send_text(self, task_id: int) -> None:
        driver = self._driver()
        self.progress("发送文本消息...")
        driver.click_text(("发送",), timeout=10)
        time.sleep(0.8)
        driver.detect_blocking_state()
        self.db.set_task_status(task_id, TaskStatus.TEXT_SENT)

    def send_video(self, customer_pk: int, task_id: int) -> str:
        video_path = self.lookup_video_path(customer_pk)
        if not video_path:
            self.progress("未配置视频素材，跳过视频发送。")
            return ""
        path = Path(video_path)
        if not path.exists():
            raise NeedManualIntervention(f"视频素材不存在：{video_path}")
        driver = self._driver()
        self.progress(f"上传并发送视频：{video_path}")
        driver.click_text(("文件", "上传", "视频"), timeout=10)
        time.sleep(0.8)
        paste_file_path(video_path)
        time.sleep(2)
        driver.click_text(("发送",), timeout=10)
        self.db.set_task_status(task_id, TaskStatus.VIDEO_SENT)
        return video_path

    def lookup_video_path(self, customer_pk: int) -> str:
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT customer_level FROM customers WHERE id = ?",
                (customer_pk,),
            ).fetchone()
        return select_video_path(dict(row or {}), self.config)

    def capture(self, prefix: str) -> Path:
        return save_screenshot(self.paths.screenshots, prefix)


def extract_generated_reply(visible_text: str) -> str:
    marker = "回复内容"
    if marker not in visible_text:
        return ""
    after = visible_text.split(marker, 1)[1]
    before_button = after.split("填入输入框", 1)[0]
    return before_button.strip()


def paste_file_path(path: str) -> None:
    import ctypes
    import time

    from alibaba_customer_dev_assistant.automation.win_clipboard import paste_text

    paste_text(path)
    time.sleep(0.2)
    user32 = ctypes.windll.user32
    user32.keybd_event(0x0D, 0, 0, 0)
    user32.keybd_event(0x0D, 0, 0x0002, 0)
