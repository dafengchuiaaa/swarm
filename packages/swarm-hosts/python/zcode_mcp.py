"""ZCode 标准 MCP/API 入口（app-server 协议）。

与桌面端鸡蛋入口不同，这里直接启动 `zcode app-server --stdio`，按 ZCode
Protocol 创建/续接会话。模型与 API Key 使用 ZCode CLI 的 provider 配置，
适合明确要走标准 API、而不是桌面端体验套餐的场景。
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path


class McpTransportError(RuntimeError):
    pass


@dataclass
class McpReply:
    text: str
    session_id: str
    model: str


def _runtime_preferences() -> dict:
    return {
        "nativeSearchEnhancementsEnabled": True,
        "toolSearchMode": "off",
        "subagentRuntimeConfigEnabled": False,
        "appControlEnabled": False,
        "memoryEnabled": False,
        "askUserQuestionAutoResolutionEnabled": True,
        "modelContextBudgetStrategy": "preflight-v1",
        "additionalDirectories": [],
    }


class AppServer:
    def __init__(self, command: list[str], workspace: str, emit, cancel):
        self.emit = emit
        self.cancel = cancel
        self.proc = subprocess.Popen(
            [*command, "app-server", "--stdio"],
            cwd=workspace or None,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self._queue: queue.Queue = queue.Queue()
        self._seq = 0
        self._writer = threading.Lock()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self._queue.put(json.loads(line))
            except Exception:
                continue

    def write(self, payload: dict):
        with self._writer:
            self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()

    def next_message(self, timeout: float):
        try:
            return self._queue.get(timeout=max(0.1, timeout))
        except queue.Empty:
            return None

    def _answer_server_request(self, msg: dict):
        method = msg.get("method") or ""
        if method == "session/requestRuntimePreferences":
            self.write({"id": msg.get("id"), "result": _runtime_preferences()})
            return True
        return False

    def request(self, method: str, params: dict, timeout: float = 30):
        self._seq += 1
        request_id = self._seq
        self.write({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            if self.cancel is not None and self.cancel.is_set():
                raise McpTransportError("ZCode MCP 派工已取消")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise McpTransportError(f"ZCode app-server 请求超时：{method}")
            msg = self.next_message(min(remaining, 0.5))
            if msg is None:
                continue
            if msg.get("id") == request_id and ("result" in msg or "error" in msg):
                if "error" in msg:
                    error = msg.get("error") or {}
                    raise McpTransportError(f"ZCode app-server {method} 失败：{error.get('message') or error}")
                return msg.get("result") or {}
            self._answer_server_request(msg)

    def wait_turn(self, timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        terminal = None
        while True:
            if self.cancel is not None and self.cancel.is_set():
                raise McpTransportError("ZCode MCP 派工已取消")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise McpTransportError("ZCode MCP 回合超时，未收到完成事件")
            msg = self.next_message(min(remaining, 1.0))
            if msg is None:
                continue
            if self._answer_server_request(msg):
                continue
            method = msg.get("method") or ""
            params = msg.get("params") or {}
            if method == "v4/telemetry/event" and params.get("kind") == "turn.terminal":
                terminal = params
                break
        status = (terminal.get("status") or "").lower()
        if status not in ("completed", "success", "succeeded"):
            message = terminal.get("errorMessage") or terminal.get("errorCode") or "ZCode 回合未完成"
            raise McpTransportError(f"ZCode MCP 执行失败：{message}")
        return terminal

    def close(self):
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.kill()
        except Exception:
            pass


def _model_selection(model: str, effort: str):
    raw = (model or "").strip()
    if not raw or raw in {"ZCode 客户端默认", "默认"}:
        raw = os.environ.get("SWARM_ZCODE_API_MODEL", "zai-standard-api/GLM-5.3")
    if "/" in raw:
        provider, model_id = raw.split("/", 1)
    else:
        provider, model_id = "zai-standard-api", raw
    if not provider or not model_id:
        return None
    selection = {"providerId": provider, "modelId": model_id}
    level = (effort or "").strip() or "max"
    selection["options"] = {"reasoningLevel": level}
    return selection


def _assistant_text(messages) -> str:
    for message in reversed(messages or []):
        info = message.get("info") or {}
        if info.get("role") != "assistant":
            continue
        parts = message.get("parts") or []
        text = "".join(
            part.get("text") or ""
            for part in parts
            if part.get("type") == "text" and isinstance(part.get("text"), str)
        ).strip()
        if text:
            return text
    return ""


def run_zcode_mcp(*, command, prompt, session_id, model, emit, cancel, timeout=180,
                  workspace=None, access_mode=None, effort=""):
    command = list(command)
    workspace_path = str(Path(workspace).resolve()) if workspace else str(Path.cwd())
    valid_session = bool(session_id) and (session_id.startswith("sess_") or session_id.startswith("session_"))
    sid = session_id if valid_session else "sess_swarm" + uuid.uuid4().hex
    server = AppServer(command, workspace_path, emit, cancel)
    try:
        emit("notice", "正在通过 ZCode 标准 MCP/API 入口派工")
        workspace_ref = {"workspacePath": workspace_path, "workspaceKey": workspace_path}
        selection = _model_selection(model, effort)
        resumed = False
        if valid_session:
            try:
                server.request("session/resume", {"sessionId": sid, "workspace": workspace_ref}, timeout=30)
                resumed = True
            except McpTransportError as error:
                emit("notice", f"ZCode 会话无法续接（{error}），改为新建会话")
                sid = "sess_swarm" + uuid.uuid4().hex
        if not resumed:
            create = {
                "sessionId": sid,
                "workspace": workspace_ref,
                "mode": "yolo",
                "titleGenerationEnabled": False,
                "persistence": "immediate",
                "dynamicWorkflowEnabled": False,
            }
            if selection:
                create["model"] = selection
            server.request("session/create", create, timeout=45)
        send = {"sessionId": sid, "content": prompt}
        if selection:
            send["modelSelection"] = selection
        accepted = server.request("session/send", send, timeout=30)
        if not accepted.get("accepted"):
            raise McpTransportError("ZCode MCP 未接受任务")
        emit("notice", "ZCode 已接受任务，等待回复")
        server.wait_turn(timeout)
        read = server.request(
            "session/read",
            {"sessionId": sid, "messageLimit": 100, "contentProfile": "full"},
            timeout=30,
        )
        text = _assistant_text(read.get("messages") or [])
        if not text:
            raise McpTransportError("ZCode MCP 没有返回可确认的助手回复")
        model_label = f"{selection['providerId']}/{selection['modelId']}" if selection else "ZCode CLI 默认"
        emit("chunk", text)
        emit("session", sid)
        return McpReply(text, sid, model_label)
    finally:
        server.close()
