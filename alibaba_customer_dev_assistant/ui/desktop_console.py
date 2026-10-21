from __future__ import annotations

import queue
import subprocess
import sys
import threading
from tkinter import BooleanVar, IntVar, StringVar, Tk, filedialog, messagebox, ttk
from tkinter.scrolledtext import ScrolledText

from alibaba_customer_dev_assistant import __app_name__
from alibaba_customer_dev_assistant.automation.browser_public_pool import (
    capture_public_pool_rows,
    start_smart_browser,
)
from alibaba_customer_dev_assistant.automation.client_only_runner import ClientOnlyRunner
from alibaba_customer_dev_assistant.automation.uia_driver import UiaDriver
from alibaba_customer_dev_assistant.automation.workflow_runner import WorkflowRunner
from alibaba_customer_dev_assistant.core.database import Database
from alibaba_customer_dev_assistant.core.dependencies import check_dependencies
from alibaba_customer_dev_assistant.core.models import AppPaths, RunConfig, TaskStatus


class DesktopConsole:
    def __init__(self, root: Tk, paths: AppPaths):
        self.root = root
        self.paths = paths
        self.db = Database(paths.database)
        self.output: queue.Queue[str] = queue.Queue()
        self.running = False

        self.max_customers = IntVar(value=1)
        self.dry_run = BooleanVar(value=True)
        self.confirm_send = BooleanVar(value=True)
        self.prefer_active_window = BooleanVar(value=True)
        self.auto_apply_filter = BooleanVar(value=False)
        self.selected_window = StringVar(value="")
        self.video_default = StringVar(value="")
        self.video_l3 = StringVar(value="")
        self.video_l4 = StringVar(value="")
        self.dependency_text = StringVar(value="")

        self.root.title(__app_name__)
        self.root.geometry("980x700")
        self.root.minsize(920, 640)
        self.build()
        self.refresh_dependencies()
        self.refresh_recent_tasks()
        self.root.after(150, self.flush_output)

    def build(self) -> None:
        outer = ttk.Frame(self.root, padding=16)
        outer.pack(fill="both", expand=True)

        header = ttk.Frame(outer)
        header.pack(fill="x")
        ttk.Label(header, text=__app_name__, font=("Microsoft YaHei UI", 18, "bold")).pack(side="left")
        ttk.Button(header, text="检查依赖", command=self.refresh_dependencies).pack(side="right")

        ttk.Label(outer, textvariable=self.dependency_text, foreground="#555555").pack(anchor="w", pady=(8, 14))

        body = ttk.PanedWindow(outer, orient="horizontal")
        body.pack(fill="both", expand=True)

        config_frame = ttk.LabelFrame(body, text="执行设置", padding=12)
        body.add(config_frame, weight=1)

        ttk.Label(config_frame, text="每次处理客户数").grid(row=0, column=0, sticky="w", pady=6)
        ttk.Spinbox(config_frame, from_=1, to=20, textvariable=self.max_customers, width=8).grid(
            row=0, column=1, sticky="w", pady=6
        )
        ttk.Checkbutton(config_frame, text="试运行，不真实点击发送", variable=self.dry_run).grid(
            row=1, column=1, sticky="w", pady=6
        )
        ttk.Checkbutton(config_frame, text="发送文字前人工确认", variable=self.confirm_send).grid(
            row=2, column=1, sticky="w", pady=6
        )
        ttk.Checkbutton(config_frame, text="优先使用当前激活窗口", variable=self.prefer_active_window).grid(
            row=3, column=1, sticky="w", pady=6
        )
        ttk.Checkbutton(config_frame, text="自动筛选 L3/L4（默认不勾选）", variable=self.auto_apply_filter).grid(
            row=4, column=1, sticky="w", pady=6
        )

        ttk.Label(config_frame, text="目标窗口").grid(row=5, column=0, sticky="w", pady=6)
        self.window_combo = ttk.Combobox(config_frame, textvariable=self.selected_window, width=34)
        self.window_combo.grid(row=5, column=1, sticky="ew", pady=6)
        ttk.Button(config_frame, text="刷新", command=self.refresh_windows).grid(row=5, column=2, padx=(8, 0), pady=6)

        self.path_row(config_frame, 6, "默认视频", self.video_default)
        self.path_row(config_frame, 7, "L3视频", self.video_l3)
        self.path_row(config_frame, 8, "L4视频", self.video_l4)

        buttons = ttk.Frame(config_frame)
        buttons.grid(row=9, column=0, columnspan=3, sticky="ew", pady=(18, 8))
        ttk.Button(buttons, text="启动智能浏览器", command=self.open_smart_browser).pack(fill="x", pady=4)
        ttk.Button(buttons, text="智能抓取网页列表", command=self.start_smart_capture).pack(fill="x", pady=4)
        ttk.Button(buttons, text="客户端：跟进当前聊天", command=self.start_client_followup).pack(fill="x", pady=4)
        ttk.Button(buttons, text="诊断当前窗口", command=self.start_diagnostics).pack(fill="x", pady=4)
        ttk.Button(buttons, text="只抓取客户列表", command=self.start_capture).pack(fill="x", pady=4)
        ttk.Button(buttons, text="开始MVP流程", command=self.start_run).pack(fill="x", pady=4)
        ttk.Button(buttons, text="刷新任务状态", command=self.refresh_recent_tasks).pack(fill="x", pady=4)

        ttk.Label(
            config_frame,
            text=(
                "建议先点击目标阿里/OKKI窗口，再回到这里点诊断或执行。"
                "遇到验证码、安全验证、登录异常、OKKI未加载或发送失败时，工具会暂停并记录截图。"
            ),
            wraplength=340,
            foreground="#555555",
        ).grid(row=10, column=0, columnspan=3, sticky="w", pady=(16, 0))

        config_frame.columnconfigure(1, weight=1)

        right = ttk.Frame(body)
        body.add(right, weight=2)

        log_frame = ttk.LabelFrame(right, text="运行日志", padding=8)
        log_frame.pack(fill="both", expand=True)
        self.log = ScrolledText(log_frame, height=18, wrap="word")
        self.log.pack(fill="both", expand=True)

        tasks_frame = ttk.LabelFrame(right, text="最近任务", padding=8)
        tasks_frame.pack(fill="both", expand=True, pady=(12, 0))
        self.tasks = ttk.Treeview(
            tasks_frame,
            columns=("id", "status", "customer", "level", "country", "updated"),
            show="headings",
            height=8,
        )
        for column, label, width in (
            ("id", "ID", 60),
            ("status", "状态", 130),
            ("customer", "客户", 180),
            ("level", "等级", 70),
            ("country", "国家", 80),
            ("updated", "更新时间", 150),
        ):
            self.tasks.heading(column, text=label)
            self.tasks.column(column, width=width, anchor="w")
        self.tasks.pack(fill="both", expand=True)
        self.refresh_windows()

    def path_row(self, parent: ttk.Frame, row: int, label: str, variable: StringVar) -> None:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", pady=6)
        ttk.Entry(parent, textvariable=variable, width=34).grid(row=row, column=1, sticky="ew", pady=6)
        ttk.Button(parent, text="选择", command=lambda: self.choose_video(variable)).grid(
            row=row, column=2, padx=(8, 0), pady=6
        )

    def choose_video(self, variable: StringVar) -> None:
        path = filedialog.askopenfilename(
            title="选择视频素材",
            filetypes=[("Video files", "*.mp4 *.mov *.avi *.mkv *.wmv"), ("All files", "*.*")],
        )
        if path:
            variable.set(path)

    def refresh_dependencies(self) -> None:
        report = check_dependencies()
        missing = ", ".join(report.missing) if report.missing else "无"
        self.dependency_text.set(
            f"自动化依赖：{'可用' if report.automation_ready else '缺失'}；"
            f"OCR依赖：{'可用' if report.ocr_ready else '缺失'}；缺失：{missing}"
        )

    def make_config(self) -> RunConfig:
        return RunConfig(
            max_customers=int(self.max_customers.get()),
            require_confirm_before_send=bool(self.confirm_send.get()),
            dry_run=bool(self.dry_run.get()),
            video_default_path=self.video_default.get().strip(),
            video_l3_path=self.video_l3.get().strip(),
            video_l4_path=self.video_l4.get().strip(),
            prefer_active_window=bool(self.prefer_active_window.get()),
            auto_apply_l3_l4_filter=bool(self.auto_apply_filter.get()),
            selected_window_title=self.selected_window.get().strip(),
        )

    def make_runner(self) -> WorkflowRunner:
        return WorkflowRunner(
            db=self.db,
            paths=self.paths,
            config=self.make_config(),
            progress=lambda message: self.output.put(message + "\n"),
            confirm_send=self.confirm_before_sending,
        )

    def make_client_runner(self) -> ClientOnlyRunner:
        return ClientOnlyRunner(
            db=self.db,
            paths=self.paths,
            config=self.make_config(),
            progress=lambda message: self.output.put(message + "\n"),
            confirm_send=self.confirm_before_sending,
        )

    def start_diagnostics(self) -> None:
        self.start_background("diagnostics")

    def open_smart_browser(self) -> None:
        try:
            start_smart_browser(self.paths.root)
            self.output.put("已启动智能浏览器。请在新浏览器里登录并打开公海客户页面。\n")
        except Exception as error:
            self.output.put(f"启动智能浏览器失败：{error}\n")

    def start_smart_capture(self) -> None:
        self.start_background("smart_capture")

    def start_client_followup(self) -> None:
        self.start_background("client_followup")

    def refresh_windows(self) -> None:
        try:
            config = self.make_config()
            driver = UiaDriver(
                config.window_title_keywords,
                action_timeout_seconds=config.action_timeout_seconds,
                prefer_active_window=False,
            )
            windows = [name for name in driver.list_windows() if name and "公海客户开发助手" not in name]
            self.window_combo["values"] = windows
            if not self.selected_window.get() and windows:
                preferred = next(
                    (
                        name
                        for name in windows
                        if any(keyword in name for keyword in ("接待中心", "阿里卖家工作台", "OKKI", "工作台", "Alibaba"))
                    ),
                    windows[0],
                )
                self.selected_window.set(preferred)
            self.output.put(f"已刷新窗口列表：{len(windows)} 个\n")
        except Exception as error:
            self.output.put(f"刷新窗口失败：{error}\n")

    def start_capture(self) -> None:
        self.start_background("capture")

    def start_run(self) -> None:
        self.start_background("run")

    def start_background(self, mode: str) -> None:
        if self.running:
            messagebox.showwarning("正在运行", "当前已有任务在运行，请等它结束。")
            return
        self.running = True
        self.output.put(f"开始任务：{mode}\n")
        threading.Thread(target=self._run_background, args=(mode,), daemon=True).start()

    def _run_background(self, mode: str) -> None:
        try:
            if mode == "diagnostics":
                self.run_diagnostics_subprocess()
            elif mode == "smart_capture":
                self.run_smart_capture()
            elif mode == "client_followup":
                self.make_client_runner().run_current_chat_followup()
            elif mode == "capture":
                self.make_runner().capture_customer_list()
            else:
                self.make_runner().run_mvp()
            self.output.put("任务结束。\n")
        except Exception as error:
            self.output.put(f"任务停止：{error}\n")
        finally:
            self.running = False
            self.root.after(0, self.refresh_recent_tasks)

    def run_diagnostics_subprocess(self) -> None:
        config = self.make_config()
        command = [
            sys.executable,
            str(self.paths.root / "diagnose_window.py"),
            "--window-title",
            config.selected_window_title,
        ]
        if config.prefer_active_window and not config.selected_window_title:
            command.append("--prefer-active")
        try:
            completed = subprocess.run(
                command,
                cwd=self.paths.root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=20,
            )
        except subprocess.TimeoutExpired:
            self.output.put("诊断超时，已停止诊断进程。请换一个目标窗口或使用可访问性浏览器。\n")
            return
        if completed.stdout:
            self.output.put(completed.stdout)
        if completed.stderr:
            self.output.put(completed.stderr)
        if completed.returncode != 0:
            self.output.put(f"诊断失败，状态码：{completed.returncode}\n")

    def run_smart_capture(self) -> None:
        rows = capture_public_pool_rows()
        limit = max(1, int(self.max_customers.get()))
        count = 0
        for row in rows[:limit]:
            customer_pk = self.db.upsert_customer_from_list(row)
            task_id = self.db.create_task(customer_pk)
            self.db.set_task_status(task_id, TaskStatus.LIST_CAPTURED)
            self.db.log(
                action="smart_capture_list_row",
                customer_pk=customer_pk,
                task_id=task_id,
                status=TaskStatus.LIST_CAPTURED.value,
                message=row.get("customer_name", ""),
            )
            count += 1
            self.output.put(
                f"抓取客户：{row.get('customer_name', '')} "
                f"{row.get('customer_level', '')} {row.get('note_time', '')}\n"
            )
        self.output.put(f"智能抓取完成：{count} 个客户。\n")

    def confirm_before_sending(self, customer: str, text: str) -> bool:
        result: queue.Queue[bool] = queue.Queue(maxsize=1)

        def ask() -> None:
            answer = messagebox.askyesno(
                "确认发送",
                f"即将给客户 {customer} 发送 OKKI 生成内容：\n\n{text[:800]}\n\n是否发送？",
            )
            result.put(answer)

        self.root.after(0, ask)
        return result.get()

    def flush_output(self) -> None:
        while True:
            try:
                self.log.insert("end", self.output.get_nowait())
                self.log.see("end")
            except queue.Empty:
                break
        self.root.after(150, self.flush_output)

    def refresh_recent_tasks(self) -> None:
        for item in self.tasks.get_children():
            self.tasks.delete(item)
        for row in self.db.list_recent_tasks():
            self.tasks.insert(
                "",
                "end",
                values=(
                    row["id"],
                    row["status"],
                    row["customer_name"] or "",
                    row["customer_level"] or "",
                    row["country"] or "",
                    row["updated_at"],
                ),
            )
