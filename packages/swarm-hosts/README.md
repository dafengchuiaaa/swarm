# 宿主桥

早期蜂群里属于我们自己的宿主接入代码，按原样搬进来，外面套一层
stdin/stdout 的 JSON 行协议，供独立的 Electron 主进程调用。没有改写各家 CLI 的协议解析。

## 文件

| 文件 | 来源 | 作用 |
| --- | --- | --- |
| `python/adapters.py` | 旧蜂群 `adapters.py` | CodeBuddy / Antigravity / ZCode / DSH 的启动、ACP/流式解析、思考捕获、工具事件 |
| `python/telemetry.py` `execution_review.py` `process_tree.py` | 旧蜂群同名文件 | 用量统计、文本脱敏、进程树清理 |
| `python/client_registry.py` `reasoning.py` `agent_prompts.py` | 旧蜂群同名文件 | 本机 CLI 定位、模型/思考强度映射、成员身份 |
| `python/bridge.py` | 本次新增 | JSON 行协议：`run` / `cancel` / `steer` / `models` / `inventory` / `ping` |
| `src/hostBridge.ts` | 本次新增 | Node 侧客户端：spawn Python、事件转发、按 runId 分发 |

## 协议

```jsonc
// 请求
{"id":"R-1","op":"run","host":"CodeBuddy","prompt":"...","model":"hy3","workspace":"D:/w","effort":""}
// 事件
{"id":"R-1","kind":"event","event":"reasoning","payload":"..."}
{"id":"R-1","kind":"event","event":"execution_event","payload":{...}}
// 结果
{"id":"R-1","kind":"result","reply":{"text":"...","sessionId":"...","model":"...","seconds":12.3}}
{"id":"R-1","kind":"error","type":"TransportError","error":"...","trace":"..."}
```

## 说明

- `data/preferences.json` 从旧蜂群带过来，保留"DeepSeek Harness 已关闭"的额度锁。
- `data/model-catalog.json`、`data/antigravity-models.json` 是本机客户端当前公布的模型清单。
- CodeBuddy 在 CodeBuddy 会话内会拒绝再起一个会话（旧蜂群原有的防嵌套保护）。
