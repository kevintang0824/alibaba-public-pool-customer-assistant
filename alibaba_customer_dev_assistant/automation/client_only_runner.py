from __future__ import annotations

import time
from pathlib import Path
from typing import Callable

from alibaba_customer_dev_assistant.automation.screenshots import save_screenshot
from alibaba_customer_dev_assistant.automation.uia_driver import UiaDriver
from alibaba_customer_dev_assistant.automation.workflow_runner import extract_generated_reply, paste_file_path
from alibaba_customer_dev_assistant.core.database import Database
from alibaba_customer_dev_assistant.core.errors import AutomationStepFailed, DependencyMissing, NeedManualIntervention
from alibaba_customer_dev_assistant.core.models import AppPaths, RunConfig, TaskStatus
from alibaba_customer_dev_assistant.core.parsing import stable_hash


ProgressCallback = Callable[[str], None]
ConfirmCallback = Callable[[str, str], bool]


class ClientOnlyRunner:
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
                raise DependencyMissing("缺少 uiautomation，请先安装依赖。") from error
        return self.driver

    def run_current_chat_followup(self) -> None:
        driver = self._driver()
        ref = driver.attach_main_window()
        window_title = ref.name or "当前接待窗口"
        self.progress(f"已连接客户端窗口：{window_title}")

        customer_pk = self.ensure_current_customer(window_title)
        task_id = self.db.create_task(customer_pk)
        try:
            self.db.set_task_status(task_id, TaskStatus.CHAT_OPENED)
            generated_text = self.open_okki_and_fill_reply(task_id)
            sent_text = generated_text or "OKKI已生成并填入输入框"
            if self.config.require_confirm_before_send and not self.confirm_send(window_title, sent_text):
                raise NeedManualIntervention("用户取消发送，任务暂停。")
            self.send_text(task_id)
            video_path = self.send_video(task_id)
            self.db.insert_message(
                customer_pk,
                task_id,
                generated_text=generated_text,
                sent_text=sent_text,
                video_path=video_path,
                text_sent=True,
                video_sent=bool(video_path),
            )
            self.db.set_task_status(task_id, TaskStatus.DONE)
            self.db.log(action="client_only_done", status=TaskStatus.DONE.value, task_id=task_id, customer_pk=customer_pk)
            self.progress("客户端专用流程完成。")
        except NeedManualIntervention as error:
            screenshot = error.screenshot_path or str(self.capture("client_need_manual"))
            self.db.set_task_status(
                task_id,
                TaskStatus.NEED_MANUAL,
                failure_reason=error.reason,
                screenshot_path=screenshot,
            )
            self.db.log(
                action="client_need_manual",
                level="WARN",
                status=TaskStatus.NEED_MANUAL.value,
                message=error.reason,
                task_id=task_id,
                customer_pk=customer_pk,
                screenshot_path=screenshot,
            )
            raise
        except AutomationStepFailed as error:
            screenshot = error.screenshot_path or str(self.capture("client_failed"))
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
            raise

    def ensure_current_customer(self, window_title: str) -> int:
        visible_text = self._driver().get_visible_text()
        customer_name = guess_customer_name(window_title, visible_text)
        row = {
            "list_row_hash": stable_hash(f"client-only::{window_title}::{customer_name}"),
            "customer_name": customer_name,
            "customer_level": "",
            "email": "",
            "country": "",
            "customer_stage": "",
            "follow_status": "当前聊天",
            "note_time": "",
            "purchase_intention": "",
            "annual_purchase_amount": "",
            "purchase_category": "",
            "customer_source": "阿里卖家客户端/接待中心",
            "raw_list_text": visible_text[:3000],
        }
        return self.db.upsert_customer_from_list(row)

    def open_okki_and_fill_reply(self, task_id: int) -> str:
        driver = self._driver()
        driver.detect_blocking_state()
        self.progress("打开 OKKI/AI 接待助手...")
        clicked = driver.click_text_or_relative(
            ("OKKI销售助手", "OKKI 销售助手", "OKKI", "AI接待助手", "接待助手"),
            x_ratio=0.68,
            y_ratio=0.09,
            label="右侧助手页签",
            timeout=6,
            max_depth=5,
            max_nodes=500,
        )
        self.progress(f"已点击：{clicked}")
        self.db.set_task_status(task_id, TaskStatus.OKKI_OPENED)
        time.sleep(1.2)
        driver.detect_blocking_state()

        self.progress("点击辅助回复...")
        clicked = driver.click_text_or_relative(
            ("辅助回复",),
            x_ratio=0.675,
            y_ratio=0.93,
            label="底部辅助回复",
            timeout=6,
            max_depth=5,
            max_nodes=500,
        )
        self.progress(f"已点击：{clicked}")
        text_after_assistant_click = driver.get_visible_text()
        visual_only_window = self.is_visual_only_window(text_after_assistant_click)
        deadline = time.time() + self.config.okki_timeout_seconds
        last_text = ""
        if visual_only_window:
            wait_seconds = min(max(12, self.config.okki_timeout_seconds // 3), self.config.okki_timeout_seconds)
            self.progress(f"接待中心未暴露内部文字，等待 OKKI 生成约 {wait_seconds} 秒后用窗口内位置填入。")
            time.sleep(wait_seconds)
            self.db.set_task_status(task_id, TaskStatus.REPLY_GENERATED)
            for x_ratio, y_ratio in ((0.69, 0.70), (0.69, 0.75), (0.69, 0.64)):
                clicked = driver.click_relative(x_ratio, y_ratio, "填入输入框候选区域")
                self.progress(f"已点击：窗口位置：填入输入框候选区域 {clicked}")
                time.sleep(0.6)
            self.db.set_task_status(task_id, TaskStatus.TEXT_FILLED)
            return ""
        while time.time() < deadline:
            driver.detect_blocking_state()
            text = driver.get_visible_text()
            last_text = text
            if "填入输入框" in text:
                self.db.set_task_status(task_id, TaskStatus.REPLY_GENERATED)
                generated = extract_generated_reply(text)
                self.progress("OKKI 已生成回复，正在填入输入框...")
                clicked = driver.click_text_or_relative(
                    ("填入输入框",),
                    x_ratio=0.69,
                    y_ratio=0.70,
                    label="填入输入框",
                    timeout=6,
                    max_depth=5,
                    max_nodes=500,
                )
                self.progress(f"已点击：{clicked}")
                time.sleep(0.5)
                self.db.set_task_status(task_id, TaskStatus.TEXT_FILLED)
                return generated
            time.sleep(1)
        screenshot = self.capture("client_okki_timeout")
        raise NeedManualIntervention(
            f"OKKI未在限定时间内生成回复。当前窗口可见文字长度：{len(last_text)}",
            screenshot_path=str(screenshot),
        )

    def is_visual_only_window(self, visible_text: str) -> bool:
        lines = [line.strip() for line in visible_text.splitlines() if line.strip()]
        if len(lines) <= 1:
            return True
        non_window_lines = [line for line in lines if "接待中心" not in line and "阿里卖家工作台" not in line]
        return len(non_window_lines) <= 1

    def send_text(self, task_id: int) -> None:
        if self.config.dry_run:
            self.progress("试运行：跳过真实发送文字。")
            self.db.set_task_status(task_id, TaskStatus.TEXT_SENT)
            return
        self.progress("发送文字消息...")
        clicked = self._driver().click_text_or_relative(
            ("发送",),
            x_ratio=0.55,
            y_ratio=0.87,
            label="聊天发送按钮",
            timeout=6,
            max_depth=5,
            max_nodes=500,
        )
        self.progress(f"已点击：{clicked}")
        time.sleep(0.8)
        self.db.set_task_status(task_id, TaskStatus.TEXT_SENT)

    def send_video(self, task_id: int) -> str:
        video_path = self.config.video_default_path or self.config.video_l3_path or self.config.video_l4_path
        if not video_path:
            self.progress("未配置视频，跳过视频发送。")
            return ""
        path = Path(video_path)
        if not path.exists():
            raise NeedManualIntervention(f"视频文件不存在：{video_path}")
        if self.config.dry_run:
            self.progress(f"试运行：跳过真实发送视频 {video_path}")
            self.db.set_task_status(task_id, TaskStatus.VIDEO_SENT)
            return video_path

        self.progress("上传视频...")
        clicked = self._driver().click_text_or_relative(
            ("文件", "上传", "视频", "图片"),
            x_ratio=0.395,
            y_ratio=0.62,
            label="聊天工具栏文件按钮",
            timeout=6,
            max_depth=5,
            max_nodes=500,
        )
        self.progress(f"已点击：{clicked}")
        time.sleep(0.8)
        paste_file_path(str(path))
        time.sleep(2.0)
        clicked = self._driver().click_text_or_relative(
            ("发送",),
            x_ratio=0.55,
            y_ratio=0.87,
            label="聊天发送按钮",
            timeout=6,
            max_depth=5,
            max_nodes=500,
        )
        self.progress(f"已点击：{clicked}")
        self.db.set_task_status(task_id, TaskStatus.VIDEO_SENT)
        return str(path)

    def capture(self, prefix: str) -> Path:
        return save_screenshot(self.paths.screenshots, prefix)


def guess_customer_name(window_title: str, visible_text: str) -> str:
    if "-" in window_title:
        first = window_title.split("-", 1)[0].strip()
        if first:
            return first
    for line in visible_text.splitlines():
        text = line.strip()
        if len(text) >= 2 and not any(skip in text for skip in ("OKKI", "发送", "辅助回复", "输入")):
            return text[:80]
    return window_title or "当前客户"
