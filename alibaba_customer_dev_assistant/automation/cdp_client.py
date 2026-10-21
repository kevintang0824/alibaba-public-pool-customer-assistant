from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import struct
import time
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.error import URLError
from urllib.parse import urlparse


class CdpError(RuntimeError):
    pass


@dataclass(frozen=True)
class CdpPage:
    title: str
    url: str
    websocket_url: str


def list_pages(port: int = 9222) -> list[CdpPage]:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, TimeoutError, URLError) as error:
        raise CdpError(f"没有连接到智能浏览器端口 {port}。请先点击“启动智能浏览器”。") from error

    return [
        CdpPage(
            title=item.get("title", ""),
            url=item.get("url", ""),
            websocket_url=item.get("webSocketDebuggerUrl", ""),
        )
        for item in payload
        if item.get("type") == "page" and item.get("webSocketDebuggerUrl")
    ]


class _WebSocket:
    def __init__(self, websocket_url: str, timeout: float = 10.0):
        parsed = urlparse(websocket_url)
        if parsed.scheme != "ws":
            raise CdpError(f"不支持的 WebSocket 地址：{websocket_url}")
        self.sock = socket.create_connection((parsed.hostname, parsed.port or 80), timeout=timeout)
        self.sock.settimeout(timeout)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{parsed.port or 80}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode("ascii"))
        response = self._read_http_response()
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            raise CdpError("智能浏览器 WebSocket 握手失败。")
        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        if f"sec-websocket-accept: {accept}".encode("ascii").lower() not in response.lower():
            raise CdpError("智能浏览器 WebSocket 校验失败。")

    def _read_http_response(self) -> bytes:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            data += chunk
        return data

    def send_text(self, text: str) -> None:
        payload = text.encode("utf-8")
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length <= 0xFFFF:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(bytes(header) + mask + masked)

    def recv_text(self) -> str:
        while True:
            first = self.sock.recv(2)
            if len(first) < 2:
                raise CdpError("智能浏览器连接已关闭。")
            opcode = first[0] & 0x0F
            masked = bool(first[1] & 0x80)
            length = first[1] & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv_exact(8))[0]
            mask = self._recv_exact(4) if masked else b""
            payload = self._recv_exact(length)
            if masked:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            if opcode == 0x8:
                raise CdpError("智能浏览器连接已关闭。")
            if opcode == 0x9:
                continue
            if opcode in {0x1, 0x2}:
                return payload.decode("utf-8")

    def _recv_exact(self, length: int) -> bytes:
        chunks = []
        remaining = length
        while remaining:
            chunk = self.sock.recv(remaining)
            if not chunk:
                raise CdpError("读取智能浏览器数据失败。")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def close(self) -> None:
        self.sock.close()


class CdpClient:
    def __init__(self, websocket_url: str):
        self.ws = _WebSocket(websocket_url)
        self.next_id = 1

    def call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 15.0) -> dict[str, Any]:
        call_id = self.next_id
        self.next_id += 1
        self.ws.send_text(json.dumps({"id": call_id, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            message = json.loads(self.ws.recv_text())
            if message.get("id") != call_id:
                continue
            if "error" in message:
                raise CdpError(f"{method} 失败：{message['error']}")
            return message.get("result", {})
        raise CdpError(f"{method} 超时。")

    def evaluate(self, expression: str, timeout: float = 20.0) -> Any:
        result = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
                "userGesture": True,
            },
            timeout=timeout,
        )
        if result.get("exceptionDetails"):
            raise CdpError(str(result["exceptionDetails"]))
        remote = result.get("result", {})
        return remote.get("value", remote.get("description"))

    def close(self) -> None:
        self.ws.close()
