from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from .models import TaskStatus


SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT UNIQUE,
    list_row_hash TEXT UNIQUE,
    customer_name TEXT,
    customer_level TEXT,
    email TEXT,
    country TEXT,
    customer_stage TEXT,
    follow_status TEXT,
    note_time TEXT,
    purchase_intention TEXT,
    annual_purchase_amount TEXT,
    purchase_category TEXT,
    customer_source TEXT,
    identity_level TEXT,
    registered_at TEXT,
    established_at TEXT,
    business_type TEXT,
    raw_list_text TEXT,
    raw_detail_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    status TEXT NOT NULL,
    failure_reason TEXT,
    screenshot_path TEXT,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    task_id INTEGER,
    generated_text TEXT,
    sent_text TEXT,
    video_path TEXT,
    text_sent_at TEXT,
    video_sent_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(customer_id) REFERENCES customers(id),
    FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    customer_id INTEGER,
    level TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT,
    message TEXT,
    screenshot_path TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id),
    FOREIGN KEY(customer_id) REFERENCES customers(id)
);
"""


def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


class Database:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.init_schema()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def init_schema(self) -> None:
        with self.connect() as connection:
            connection.executescript(SCHEMA)

    def upsert_customer_from_list(self, row: dict[str, Any]) -> int:
        timestamp = now_text()
        payload = {
            "customer_id": row.get("customer_id"),
            "list_row_hash": row["list_row_hash"],
            "customer_name": row.get("customer_name"),
            "customer_level": row.get("customer_level"),
            "email": row.get("email"),
            "country": row.get("country"),
            "customer_stage": row.get("customer_stage"),
            "follow_status": row.get("follow_status"),
            "note_time": row.get("note_time"),
            "purchase_intention": row.get("purchase_intention"),
            "annual_purchase_amount": row.get("annual_purchase_amount"),
            "purchase_category": row.get("purchase_category"),
            "customer_source": row.get("customer_source"),
            "raw_list_text": row.get("raw_list_text"),
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        columns = ", ".join(payload.keys())
        placeholders = ", ".join("?" for _ in payload)
        update_columns = ", ".join(
            f"{column}=excluded.{column}"
            for column in payload
            if column not in {"created_at", "list_row_hash"}
        )
        with self.connect() as connection:
            connection.execute(
                f"""
                INSERT INTO customers ({columns})
                VALUES ({placeholders})
                ON CONFLICT(list_row_hash) DO UPDATE SET {update_columns}
                """,
                tuple(payload.values()),
            )
            result = connection.execute(
                "SELECT id FROM customers WHERE list_row_hash = ?",
                (payload["list_row_hash"],),
            ).fetchone()
            return int(result["id"])

    def update_customer_detail(self, customer_pk: int, detail: dict[str, Any]) -> None:
        allowed = {
            "customer_id",
            "customer_name",
            "email",
            "country",
            "identity_level",
            "customer_source",
            "registered_at",
            "established_at",
            "annual_purchase_amount",
            "business_type",
            "raw_detail_text",
        }
        values = {key: value for key, value in detail.items() if key in allowed}
        if not values:
            return
        values["updated_at"] = now_text()
        assignments = ", ".join(f"{key} = ?" for key in values)
        with self.connect() as connection:
            connection.execute(
                f"UPDATE customers SET {assignments} WHERE id = ?",
                (*values.values(), customer_pk),
            )

    def create_task(self, customer_pk: int) -> int:
        timestamp = now_text()
        with self.connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO tasks (customer_id, status, started_at, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (customer_pk, TaskStatus.NEW.value, timestamp, timestamp),
            )
            return int(cursor.lastrowid)

    def set_task_status(
        self,
        task_id: int,
        status: TaskStatus,
        *,
        failure_reason: str | None = None,
        screenshot_path: str | None = None,
    ) -> None:
        timestamp = now_text()
        finished_at = timestamp if status in {TaskStatus.DONE, TaskStatus.FAILED, TaskStatus.NEED_MANUAL} else None
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE tasks
                SET status = ?,
                    failure_reason = COALESCE(?, failure_reason),
                    screenshot_path = COALESCE(?, screenshot_path),
                    finished_at = COALESCE(?, finished_at),
                    updated_at = ?
                WHERE id = ?
                """,
                (status.value, failure_reason, screenshot_path, finished_at, timestamp, task_id),
            )

    def insert_message(
        self,
        customer_pk: int,
        task_id: int,
        *,
        generated_text: str = "",
        sent_text: str = "",
        video_path: str = "",
        text_sent: bool = False,
        video_sent: bool = False,
    ) -> int:
        timestamp = now_text()
        with self.connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO messages (
                    customer_id, task_id, generated_text, sent_text, video_path,
                    text_sent_at, video_sent_at, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    customer_pk,
                    task_id,
                    generated_text,
                    sent_text,
                    video_path,
                    timestamp if text_sent else None,
                    timestamp if video_sent else None,
                    timestamp,
                ),
            )
            return int(cursor.lastrowid)

    def log(
        self,
        *,
        action: str,
        level: str = "INFO",
        status: str = "",
        message: str = "",
        task_id: int | None = None,
        customer_pk: int | None = None,
        screenshot_path: str | None = None,
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO operation_logs (
                    task_id, customer_id, level, action, status, message, screenshot_path, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (task_id, customer_pk, level, action, status, message, screenshot_path, now_text()),
            )

    def list_recent_tasks(self, limit: int = 100) -> list[sqlite3.Row]:
        with self.connect() as connection:
            return list(
                connection.execute(
                    """
                    SELECT t.id, t.status, t.failure_reason, t.updated_at, c.customer_name, c.country, c.customer_level
                    FROM tasks t
                    LEFT JOIN customers c ON c.id = t.customer_id
                    ORDER BY t.id DESC
                    LIMIT ?
                    """,
                    (limit,),
                )
            )
