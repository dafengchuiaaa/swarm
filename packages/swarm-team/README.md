# swarm-team · 蜂群协作总线

这个包只做团队协作本身：频道、讨论串、私信、共享板、任务回执和成果登记。它不启动宿主、不碰 UI，界面和 Agent 工具面都调用同一份权威状态。

## 结构

| 文件 | 作用 |
| --- | --- |
| `src/collaborationBus.ts` | 从旧蜂群移植并扩展的总线：消息、回执、派工队列、共享板、任务、成果、幂等 |
| `src/service.ts` | 把总线绑到项目/会话和工作区，负责整份快照落库、界面视图和成员任务 |
| `mcp/server.mjs` | stdio MCP 服务，宿主按本次 run 的配置拉起；工具清单运行时从网关读取 |

## 消息语义

- `accept(sender, 文本)`：普通文字原样返回，不产生消息；只有 JSON 信封才会落消息。
- 收件人 `all` 落项目频道 `ch:<project>:main`；指定成员自动落双方私信 `dm:<a>|<b>`。
- `requires_action` 的消息进派工队列；`swarm_dispatch` 是唯一会自动让对方开跑的工具。
- 讨论串必须挂在同频道的根消息上；私信只对双方可见，第三人读不到。
- 同一 `eventId` 重试只落一条；内容变化直接报错。
- 共享板按版本号写入，版本对不上记冲突、不覆盖，并以系统消息告知作者。
- 成果路径必须在本轮工作区内；越界或不存在一律不登记。

## 身份与工具面

主进程为每次 run 发一个 token，绑定 `{projectId, memberId, runId}`。MCP 进程只拿得到 `SWARM_BUS_URL` 和 `SWARM_BUS_TOKEN`，不能通过参数冒充别人。工具清单从 `GET /tools` 取，避免两处定义漂移。

九个工具：`swarm_context`、`swarm_say`、`swarm_inbox`、`swarm_ack`、`swarm_board_read`、`swarm_board_write`、`swarm_report`、`swarm_artifact`、`swarm_dispatch`。

## 持久化

`swarm-shell` 的 `bus_state(project_id, channel_id, run_id, payload, updated_at)` 保存整份快照，一次事务写入。重启后恢复同一份消息（消息 ID 不变），再按当前会话补齐成员任务。

## 测试

```bash
bun test ./tests/unit/swarmTeam/collaborationBus.test.ts
```

覆盖：幂等重试、频道/私信隔离、讨论串归属、取信与确认、共享板冲突、任务越权与阻塞校验、成果路径越界、成员补绑、快照恢复。
