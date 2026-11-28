# 蜂群共享记忆

记忆服务在本机运行，使用 SQLite 保存项目知识、来源、整理游标和候选草稿。桌面蜂群的聊天、派工账本和成果目录各自保存。安装 Python 3.11 或以上版本即可运行基础检索。

## 从空库启动

在仓库根目录用 PowerShell 执行。示例的独立数据目录和端口适合第一次验证，正式使用可以去掉前两行，改用默认的 `%LOCALAPPDATA%/SwarmMemory` 和本机端口 8781。

```powershell
$env:SWARM_MEMORY_DIR = Join-Path $env:LOCALAPPDATA 'SwarmMemory-Example'
$env:SWARM_MEMORY_PORT = '18781'
$env:SWARM_MEMORY_BRIDGE = (Resolve-Path './packages/swarm-memory/swarm_memory_bridge.py').Path
$SwarmWorkspace = (New-Item -ItemType Directory -Force (Join-Path $env:USERPROFILE 'SwarmMemoryDemo')).FullName

python packages/swarm-memory/memory_service.py start
python packages/swarm-memory/swarm_memory_bridge.py bind --workspace $SwarmWorkspace --project swarm-demo
python packages/swarm-memory/swarm_memory_bridge.py remember --workspace $SwarmWorkspace --project swarm-demo --title '示例约定' --body '验收结果写入 README-demo.md'
python packages/swarm-memory/swarm_memory_bridge.py context --workspace $SwarmWorkspace --project swarm-demo --query 'README-demo'
```

最后一条应返回刚写入的「示例约定」。绑定会在工作区创建 `.swarm/projects.json`。各客户端用相同的项目 ID 和服务数据目录即可读取同一份记忆。服务只监听回环地址，认证令牌保存在数据目录，不必复制到配置示例。用 `python packages/swarm-memory/memory_service.py status` 查看状态，用同一 PowerShell 环境下的 `stop` 停止该实例。

## 在蜂群成员和其他 MCP 客户端使用

保留上面的环境变量，从**同一 PowerShell**运行 `bun run start`。使用协作工具的 CodeBuddy、Antigravity 和 Qoder 回合会收到 `swarm` 派工工具和 `swarm_memory` 记忆工具。让成员调用 `get_project_context`，传 `project: "swarm-demo"` 或工作区绝对路径，以及要查的 `query`。只传查询词时，读取的是共享范围。其他宿主能否直接使用，要看该宿主是否支持配置 MCP。

支持 stdio MCP 的独立客户端可以添加下列配置。替换两个占位路径，使用前面启动服务时的目录和端口。也可省略 `env` 使用默认实例。

```json
{
  "mcpServers": {
    "swarm_memory": {
      "command": "C:/path/to/python.exe",
      "args": ["C:/path/to/swarm/packages/swarm-memory/swarm_memory_bridge.py", "serve"],
      "env": {
        "SWARM_MEMORY_DIR": "C:/path/to/memory-data",
        "SWARM_MEMORY_PORT": "18781"
      }
    }
  }
}
```

## 录入、采集和检索

- 用 `remember` 录入明确的项目事实，用 `get_project_context` 检索，用 `read_memory_source` 根据返回的来源 ID 回读原文。
- `sync_agent_sessions` 可手工收录已绑定工作区的本地记录。目前采集器读取受支持的 Codex、Qoder、CodeBuddy、WorkBuddy JSONL 和部分 Antigravity 会话格式。使用独立的 CodeBuddyCLI 数据目录时，可设 `SWARM_CODEBUDDY_PROJECTS` 指向其 `projects` 目录。宿主的 MCP 可连接性与其会话能否采集分别验证。
- `propose_project_memory` 提交候选草稿。整理时保留来源引用，只确认已连续处理的来源页。正式条目可用上面的 `remember` 命令写入，再通过查询核对。
- 默认提供本地关键词检索。若自行配置 BGE 小模型，把 `tokenizer.json` 和 `model.onnx` 或 `model_qint8.onnx` 放到本目录的 `assets/models/bge-small-zh-v1.5/`，并安装 `numpy`、`onnxruntime` 和 `tokenizers`。以服务状态里的模型可用性为准。仓库与启程流程均不自动下载模型权重。

默认发布从空库启动。运行数据、令牌、服务日志、个人会话和项目登记请保存在本机数据目录。需要按项目别名查询时，可在该目录提供 `projects.json`，格式为 `{"projects":[{"project_id":"swarm-demo","name":"演示","aliases":[]}]}`。
