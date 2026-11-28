"""Swarm project-memory bridge: host packet CLI, passive MCP tools, and stdio MCP server.

The bridge only uses MemoryStore's public API. It never edits the storage schema,
never accepts a caller-provided source/entry allow-list, never auto-accepts a
proposal, and never silently falls back to the global memory database.

常驻服务化之后（memory_service.py）本模块有两种运行形态：
- **转发（默认）**：`context` / `propose` / `serve` 都把请求交给本机常驻服务。桥自己
  不打开数据库、不选库路径、不加载向量模型——客户端起多少个桥，全机也只有服务进程那
  一份模型。
- **本地（仅测试/离线排查）**：显式 `--db` 或 `--local` 时按老路径在本进程内开库。
  这条路径仅供单测与隔离库验收使用，日常运行不允许它成为默认。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import memory_service
import settings
from memory_store import KINDS, MemoryStore

BRIDGE_VERSION = "1.0.0"
MCP_PROTOCOL_VERSION = "2025-06-18"
DEFAULT_ORGANIZER = "CodeBuddy / MCP"


def _validate_workspace(workspace: str) -> Path:
    """Require an existing absolute workspace; never accept settings.py fallback."""
    text = str(workspace or "").strip()
    path = Path(text).expanduser()
    if not text or not path.is_absolute() or not path.is_dir():
        raise ValueError("workspace 必须是已存在的绝对路径目录")
    return path


AUTO_PROJECT = "auto"
BINDING_FILE = "projects.json"


def _validate_project(project: str) -> str:
    if not isinstance(project, str) or not project.strip():
        raise ValueError("project 不能为空，必须由宿主显式传入项目 ID")
    return project.strip()


def binding_path(workspace: str) -> Path:
    """工作区级项目身份绑定：`<workspace>/.swarm/projects.json`。

    为什么不是"猜一个"：一个工作区库里可能同时存在多个历史项目 ID，凭最近条目或第一个
    ID 猜都会把别人的经验注入进来。绑定是显式事实，写一次，后续只读。
    """
    return _validate_workspace(workspace) / ".swarm" / BINDING_FILE


def read_binding(workspace: str) -> str | None:
    path = binding_path(workspace)  # 工作区非法要立刻报错，不能被下面的 except 吞成"未绑定"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    project = str((data or {}).get("project") or "").strip()
    return project or None


def bind_workspace(workspace: str, project: str) -> dict[str, Any]:
    """显式写入工作区 <-> 项目身份绑定（幂等：同值重写不改变语义）。"""
    project = _validate_project(project)
    path = binding_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"project": project, "bound_at": _utc_now()}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"workspace": str(workspace), "project": project, "binding": str(path)}


def resolve_project(workspace: str, project: str | None) -> str:
    """解析项目身份：显式 ID 原样用；空/auto 走工作区绑定；都没有就报错。

    桌面端不再把团队 ID 当项目身份（团队是"谁在干"，不是"经验挂在哪个库"），
    所以同一工作区的两个团队都会落到同一条旧经验上。
    """
    text = str(project or "").strip()
    if text and text.lower() != AUTO_PROJECT:
        return _validate_project(text)
    bound = read_binding(workspace)
    if not bound:
        raise ValueError(
            "该工作区尚未绑定项目身份：先在 <workspace>/.swarm/projects.json 写入 project，"
            "或执行 swarm_memory_bridge.py bind --workspace <dir> --project <id>"
        )
    return bound


def _utc_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _validate_source_limit(source_limit: int) -> int:
    try:
        limit = int(source_limit)
    except (TypeError, ValueError) as error:
        raise ValueError("source_limit 必须是整数") from error
    if not 1 <= limit <= 100:
        raise ValueError("source_limit 必须在 1..100 之间")
    return limit


def resolve_database(workspace: str, db_path: str | None = None) -> Path:
    """Resolve an existing workspace memory database without creating one."""
    folder = _validate_workspace(workspace)
    path = Path(db_path).expanduser().resolve() if db_path else settings.memory_path(str(folder)).resolve()
    if not path.is_file():
        raise FileNotFoundError(f"项目记忆库不存在：{path}")
    return path


def _open_store(workspace: str, db_path: str | None = None) -> MemoryStore:
    return MemoryStore(str(resolve_database(workspace, db_path)))


def get_project_context(
    workspace: str | None = None,
    project: str = AUTO_PROJECT,
    query: str = "",
    task_id: str | None = None,
    budget: int = 6000,
    source_limit: int = 12,
    db_path: str | None = None,
    retrieval: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Return MemoryStore.packet() unchanged for a validated workspace/project."""
    project_id = (resolve_project(workspace, project) if workspace is not None
                  else memory_service.resolve_read_scope(None, project)[0])
    limit = _validate_source_limit(source_limit)
    store = _open_read_store(workspace, db_path)
    try:
        return store.packet(
            project_id,
            query=query or "",
            task_id=task_id,
            budget=budget,
            dialogue=False,
            source_limit=limit,
            retrieval=retrieval,
        )
    finally:
        store.close()


def _open_read_store(workspace: str | None, db_path: str | None = None) -> MemoryStore:
    if workspace is not None:
        return _open_store(workspace, db_path)
    path = Path(db_path).resolve() if db_path else memory_service.database_path()
    if not path.is_file():
        raise FileNotFoundError(f"共享记忆库不存在：{path}")
    return MemoryStore(str(path))


def read_memory_source(workspace: str | None = None, source_id: str = '', project: str = AUTO_PROJECT,
                       offset: int = 0, max_chars: int = 4000) -> dict[str, Any]:
    scope = (resolve_project(workspace, project) if workspace is not None
             else memory_service.resolve_read_scope(None, project)[0])
    store = _open_read_store(workspace)
    try:
        return store.source_page(scope, source_id, offset, max_chars)
    finally:
        store.close()


def propose_project_memory(
    workspace: str,
    project: str,
    proposals: list[dict[str, Any]],
    query: str = "",
    task_id: str | None = None,
    source_limit: int = 12,
    db_path: str | None = None,
    organizer: str = DEFAULT_ORGANIZER,
) -> dict[str, Any]:
    """Stage reviewed-memory proposals using only sources/revisions from a fresh packet.

    The caller cannot supply allowed_sources or allowed_entries. Every draft stays
    pending; acceptance remains a separate human/authorized workflow.
    """
    project_id = resolve_project(workspace, project)
    limit = _validate_source_limit(source_limit)
    if not isinstance(proposals, list) or not 1 <= len(proposals) <= 16:
        raise ValueError("proposals 必须是 1..16 项的对象数组")
    if any(not isinstance(item, dict) for item in proposals):
        raise ValueError("proposals 中每一项都必须是对象")
    if not isinstance(organizer, str) or not organizer.strip():
        raise ValueError("organizer 不能为空")

    store = _open_store(workspace, db_path)
    try:
        packet = store.packet(
            project_id,
            query=query or "",
            task_id=task_id,
            budget=10000,
            dialogue=False,
            source_limit=limit,
        )
        errors: list[dict[str, Any]] = []
        draft_ids = store.stage(
            project_id,
            json.dumps({"proposals": proposals}, ensure_ascii=False),
            organizer.strip(),
            set(packet["source_ids"]),
            packet["entries"],
            errors=errors,
        )
        return {"draft_ids": draft_ids, "errors": errors}
    finally:
        store.close()


# ---------------------------------------------------------------- 转发给常驻服务

# 桥在转发形态下只允许这几个参数；`db_path` 这类"另选数据库"的入参在这里被显式拒绝，
# 否则任何客户端都能把全机唯一的记忆指向另一份文件，共库就名存实亡。
SERVICE_ARGUMENTS = {
    'get_project_context': frozenset({'workspace', 'project', 'query', 'task_id', 'budget',
                                      'source_limit', 'retrieval'}),
    'read_memory_source': frozenset({'workspace', 'project', 'source_id', 'offset', 'max_chars'}),
    'sync_agent_sessions': frozenset({'workspace', 'project', 'days', 'limit', 'collect', 'reviewed_through'}),
    'propose_project_memory': frozenset({'workspace', 'project', 'proposals', 'query', 'task_id',
                                         'source_limit', 'organizer'}),
    'remember_project_memory': frozenset({'workspace', 'project', 'title', 'body', 'kind', 'task_id'}),
}

# 服务没起来时，桥愿意为一次调用等多久。AionCore 侧的超时是 8 秒，这里留出余量，
# 宁可这一轮如实报"未就绪"，也不要让团队回合卡住。
SERVICE_START_TIMEOUT = float(os.environ.get('SWARM_MEMORY_START_TIMEOUT') or 6)


def service_arguments(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    allowed = SERVICE_ARGUMENTS.get(name)
    if allowed is None:
        raise ValueError(f'未知工具：{name}')
    unknown = sorted(set(arguments) - allowed)
    if unknown:
        raise ValueError(f'{name} 不接受参数：{unknown}（桥只转发，不能另选数据库或来源）')
    return dict(arguments)


def call_service(name: str, arguments: dict[str, Any], timeout: float = 30.0) -> Any:
    """把一次工具调用交给本机常驻服务；服务不可用时如实抛错，不退回本地开库。"""
    endpoint = memory_service.ensure_running(timeout=SERVICE_START_TIMEOUT)
    return memory_service.call_tool(name, service_arguments(name, arguments), target=endpoint, timeout=timeout)


@dataclass(frozen=True)
class McpTool:
    name: str
    description: str
    inputSchema: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class McpTextContent:
    text: str
    type: str = "text"


TOOL_DEFINITIONS = (
    McpTool(
        name="get_project_context",
        description="检索项目历史、架构决策和来源。空白会话直接传 query，不需要 workspace 或 project，会检索全机共享记忆；按登记的项目名称或 ID 可进一步查询项目。",
        inputSchema={
            "type": "object",
            "properties": {
                "workspace": {"type": "string", "description": "已存在的绝对项目目录"},
                "project": {"type": "string", "default": "auto", "description": "稳定项目 ID；没有 workspace 时也接受项目登记中的名称或别名"},
                "query": {"type": "string", "default": "", "description": "当前任务标题或检索词"},
                "task_id": {"type": ["string", "null"], "default": None},
                "budget": {"type": "integer", "default": 6000, "minimum": 500, "maximum": 20000},
                "source_limit": {"type": "integer", "default": 12, "minimum": 1, "maximum": 100},
            },
            "required": [],
            "additionalProperties": False,
        },
    ),
    McpTool(
        name="read_memory_source",
        description="按 get_project_context 返回的来源 ID 回读原文。共享来源只需 source_id；项目来源沿用原查询的项目或工作区。next_offset 非空时可继续读取。",
        inputSchema={
            "type": "object",
            "properties": {
                "workspace": {"type": "string", "description": "已存在的绝对项目目录"},
                "project": {"type": "string", "default": "auto"},
                "source_id": {"type": "string"},
                "offset": {"type": "integer", "minimum": 0, "default": 0},
                "max_chars": {"type": "integer", "minimum": 1, "maximum": 12000, "default": 4000},
            },
            "required": ["source_id"],
            "additionalProperties": False,
        },
    ),
    McpTool(
        name="sync_agent_sessions",
        description="手动同步本机宿主会话到项目记忆的待整理队列。传项目名或已绑定工作区；返回原文来源 ID、会话 ID、工作目录和预览。用 read_memory_source 查原文。整理完成后才传 reviewed_through 确认；collect=false 可只读队列或确认。",
        inputSchema={
            "type": "object",
            "properties": {
                "workspace": {"type": "string"},
                "project": {"type": "string"},
                "days": {"type": "integer", "minimum": 1, "maximum": 90, "default": 7},
                "limit": {"type": "integer", "minimum": 1, "maximum": 40, "default": 12},
                "collect": {"type": "boolean", "default": True},
                "reviewed_through": {"type": "integer", "minimum": 1},
            },
            "additionalProperties": False,
        },
    ),
    McpTool(
        name="propose_project_memory",
        description="提交待审项目记忆草稿；服务端重新组包限定来源与版本，不直接写入正式记忆。",
        inputSchema={
            "type": "object",
            "properties": {
                "workspace": {"type": "string", "description": "已存在的绝对项目目录"},
                "project": {"type": "string", "description": "宿主传入的稳定项目 ID"},
                "proposals": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 16,
                    "items": {
                        "type": "object",
                        "properties": {
                            "entry_id": {"type": ["string", "null"]},
                            "expected_revision": {"type": "integer", "minimum": 0},
                            "kind": {
                                "type": "string",
                                "enum": ["constraint", "decision", "fact", "lesson", "open_question"],
                            },
                            "title": {"type": "string", "maxLength": 160},
                            "body": {"type": "string", "maxLength": 8000},
                            "task_id": {"type": ["string", "null"]},
                            "source_ids": {"type": "array", "items": {"type": "string"}},
                        },
                    },
                },
                "query": {"type": "string", "default": ""},
                "task_id": {"type": ["string", "null"], "default": None},
                "source_limit": {"type": "integer", "default": 12, "minimum": 1, "maximum": 100},
                "organizer": {"type": "string", "default": DEFAULT_ORGANIZER},
            },
            "required": ["workspace", "project", "proposals"],
            "additionalProperties": False,
        },
    ),
)


class SwarmMemoryMcpServer:
    """Dependency-free MCP stdio server with FastMCP-like tool methods for tests.

    `caller` 决定这次调用的去向：转发形态传 `call_service`（交给常驻服务），本地形态
    留空即在本进程内开库。工具清单两种形态一致，客户端配置不用改。
    """

    def __init__(self, caller: Any = None):
        self._caller = caller

    async def list_tools(self) -> list[McpTool]:
        return list(TOOL_DEFINITIONS)

    @staticmethod
    def _local_call(name: str, arguments: dict[str, Any]) -> Any:
        if name == "get_project_context":
            return get_project_context(**arguments)
        if name == "read_memory_source":
            return read_memory_source(**arguments)
        if name == "sync_agent_sessions":
            raise ValueError("会话同步需使用本机常驻记忆服务")
        if name == "propose_project_memory":
            return propose_project_memory(**arguments)
        raise ValueError(f"未知工具：{name}")

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> list[McpTextContent]:
        if not isinstance(arguments, dict):
            raise ValueError("tools/call arguments 必须是对象")
        result = (self._caller or self._local_call)(name, arguments)
        return [McpTextContent(json.dumps(result, ensure_ascii=False))]

    @staticmethod
    def _response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    @staticmethod
    def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}

    async def handle_message(self, message: dict[str, Any]) -> dict[str, Any] | None:
        """Handle one JSON-RPC message; notifications intentionally have no response."""
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return self._error(message.get("id") if isinstance(message, dict) else None, -32600, "Invalid Request")
        method = message.get("method")
        request_id = message.get("id")
        if method is None or (isinstance(method, str) and method.startswith("notifications/")):
            return None

        params = message.get("params") or {}
        if not isinstance(params, dict):
            return self._error(request_id, -32602, "Invalid params")
        try:
            if method == "initialize":
                requested = params.get("protocolVersion")
                version = requested if isinstance(requested, str) and requested else MCP_PROTOCOL_VERSION
                return self._response(
                    request_id,
                    {
                        "protocolVersion": version,
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {"name": "swarm-memory", "version": BRIDGE_VERSION},
                    },
                )
            if method == "ping":
                return self._response(request_id, {})
            if method == "tools/list":
                return self._response(request_id, {"tools": [tool.to_dict() for tool in await self.list_tools()]})
            if method == "tools/call":
                name = params.get("name")
                arguments = params.get("arguments") or {}
                try:
                    blocks = await self.call_tool(str(name), arguments)
                    return self._response(
                        request_id,
                        {
                            "content": [{"type": block.type, "text": block.text} for block in blocks],
                            "isError": False,
                        },
                    )
                except Exception as error:  # tool errors remain MCP results, not protocol errors
                    return self._response(
                        request_id,
                        {
                            "content": [{"type": "text", "text": str(error)}],
                            "isError": True,
                        },
                    )
            return self._error(request_id, -32601, f"Method not found: {method}")
        except Exception as error:
            return self._error(request_id, -32603, str(error))

    def serve(self) -> None:
        """Serve newline-delimited JSON-RPC over stdin/stdout."""
        for stream in (sys.stdin, sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8")
        server = self
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except ValueError:
                response = self._error(None, -32700, "Parse error")
            else:
                response = asyncio.run(server.handle_message(message))
            if response is not None:
                sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                sys.stdout.flush()


def create_mcp_server(caller: Any = None) -> SwarmMemoryMcpServer:
    return SwarmMemoryMcpServer(caller)


mcp = create_mcp_server()


def _add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--workspace",
        default=os.environ.get("SWARM_MEMORY_WORKSPACE") or str(Path.cwd()),
        help="Existing absolute project directory (default: SWARM_MEMORY_WORKSPACE or cwd)",
    )
    parser.add_argument("--db", dest="db_path", default=None, help="Explicit existing memory.sqlite3 path (for tests)")
    parser.add_argument(
        "--local",
        action="store_true",
        help="在本进程内开库（仅测试/离线排查）；默认转发给本机常驻记忆服务",
    )


def _read_proposals(args: argparse.Namespace) -> list[dict[str, Any]]:
    if args.proposals_file:
        text = Path(args.proposals_file).read_text(encoding="utf-8-sig")
    elif args.proposals_json:
        text = args.proposals_json
    else:
        text = sys.stdin.read()
    value = json.loads(text)
    if isinstance(value, dict) and "proposals" in value:
        value = value["proposals"]
    if not isinstance(value, list):
        raise ValueError("提案 JSON 必须是数组或 {\"proposals\": [...]} 对象")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Swarm project memory bridge")
    subparsers = parser.add_subparsers(dest="command", required=True)

    context = subparsers.add_parser("context", aliases=["get", "packet"], help="Print a project packet as JSON")
    _add_common_arguments(context)
    context.add_argument("--project", default=AUTO_PROJECT,
                         help="项目身份；留空/auto 时按工作区绑定解析")
    context.add_argument("--query", default="")
    context.add_argument("--task-id", default=None)
    context.add_argument("--budget", type=int, default=6000)
    context.add_argument("--source-limit", type=int, default=12)

    propose = subparsers.add_parser("propose", help="Stage pending memory proposals from JSON file/stdin")
    _add_common_arguments(propose)
    propose.add_argument("--project", default=AUTO_PROJECT,
                         help="项目身份；留空/auto 时按工作区绑定解析")
    propose.add_argument("--proposals-file", default=None)
    propose.add_argument("--proposals-json", default=None)
    propose.add_argument("--query", default="")
    propose.add_argument("--task-id", default=None)
    propose.add_argument("--source-limit", type=int, default=12)
    propose.add_argument("--organizer", default=DEFAULT_ORGANIZER)

    bind = subparsers.add_parser("bind", help="Bind a workspace to a project identity (explicit, idempotent)")
    _add_common_arguments(bind)
    bind.add_argument("--project", required=True, help="该项目工作区的稳定项目 ID，例如 AI团队")

    remember = subparsers.add_parser(
        "remember",
        help="已授权的直接写入（用户明确要求记住的事实/纠错/复盘）；走常驻服务",
    )
    _add_common_arguments(remember)
    remember.add_argument("--project", default=AUTO_PROJECT)
    remember.add_argument("--title", required=True)
    remember.add_argument("--body", required=True)
    remember.add_argument("--kind", default="lesson", choices=list(KINDS))
    remember.add_argument("--task-id", default=None)

    status = subparsers.add_parser("status", help="打印本机记忆服务状态")
    status.add_argument("--json", dest="as_json", action="store_true")

    serve = subparsers.add_parser("serve", help="Run the MCP stdio server（默认转发给常驻服务）")
    _add_common_arguments(serve)
    return parser


def _local_mode(args: argparse.Namespace) -> bool:
    """显式 --db / --local / SWARM_MEMORY_LOCAL=1 才走本进程开库；其余一律转发常驻服务。

    这样"客户端配错一个参数就变成两套库同时写"这条退路在结构上不存在——想开第二份库
    必须自己写上 --db（或显式声明本地模式）。三种开关都只该出现在单测和隔离验收里。
    """
    if (os.environ.get("SWARM_MEMORY_LOCAL") or "").strip() in ("1", "true", "yes"):
        return True
    return bool(getattr(args, "db_path", None)) or bool(getattr(args, "local", False))


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)
    try:
        if args.command in ("context", "get", "packet"):
            retrieval = (
                {"keyword_candidates": 0, "vector_candidates": 0}
                if os.environ.get("SWARM_MEMORY_REPORT_RETRIEVAL") == "1" else None
            )
            if _local_mode(args):
                result = get_project_context(
                    args.workspace,
                    args.project,
                    query=args.query,
                    task_id=args.task_id,
                    budget=args.budget,
                    source_limit=args.source_limit,
                    db_path=args.db_path,
                    retrieval=retrieval,
                )
            else:
                arguments = {
                    "workspace": args.workspace,
                    "project": args.project,
                    "query": args.query,
                    "task_id": args.task_id,
                    "budget": args.budget,
                    "source_limit": args.source_limit,
                }
                if retrieval is not None:
                    arguments["retrieval"] = retrieval
                result = call_service("get_project_context", arguments)
            if retrieval is not None:
                result["retrieval"] = retrieval
        elif args.command == "propose":
            proposals = _read_proposals(args)
            if _local_mode(args):
                result = propose_project_memory(
                    args.workspace,
                    args.project,
                    proposals,
                    query=args.query,
                    task_id=args.task_id,
                    source_limit=args.source_limit,
                    db_path=args.db_path,
                    organizer=args.organizer,
                )
            else:
                result = call_service("propose_project_memory", {
                    "workspace": args.workspace,
                    "project": args.project,
                    "proposals": proposals,
                    "query": args.query,
                    "task_id": args.task_id,
                    "source_limit": args.source_limit,
                    "organizer": args.organizer,
                })
            if not result["draft_ids"]:
                print(json.dumps(result, ensure_ascii=False))
                return 2
        elif args.command == "bind":
            result = bind_workspace(args.workspace, args.project)
        elif args.command == "remember":
            result = call_service("remember_project_memory", {
                "workspace": args.workspace,
                "project": args.project,
                "title": args.title,
                "body": args.body,
                "kind": args.kind,
                "task_id": args.task_id,
            })
        elif args.command == "status":
            result = memory_service.status()
            print(json.dumps(result, ensure_ascii=False))
            return 0 if result.get("ok") else 2
        elif args.command == "serve":
            # 转发形态：桥只做协议翻译，不碰数据库、不加载模型。
            caller = None if _local_mode(args) else call_service
            create_mcp_server(caller).serve()
            return 0
        else:  # pragma: no cover - argparse enforces the command set
            raise ValueError(f"未知命令：{args.command}")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except memory_service.ServiceUnavailable as error:
        print(f"[swarm-memory-bridge] {error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"[swarm-memory-bridge] {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
