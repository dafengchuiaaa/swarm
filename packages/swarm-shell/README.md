# 蜂群独立版（Electron 外壳）

宿主能力来自 `packages/swarm-hosts`（旧蜂群 `adapters.py` 这套我们自己的代码，走进程边界接入）。

## 从零启动

```powershell
cd D:/work/swarm
bun install --frozen-lockfile
bun run build
bun run start
```

依赖：Node/Electron 37（仓内 node_modules）、系统 Python（`py -3` 可用即可，宿主桥只用标准库）。
宿主先在自己的客户端里登录好：CodeBuddy / Antigravity（agy）/ ZCode / DSH。

## 数据

- `SWARM_DATA_DIR` 下的 `swarm-shell.sqlite3`：项目、成员、宿主会话 ID、主对话、事件、成果。
- 成果必须真实存在于项目工作区内，才会登记为"已核实"；回复声称但磁盘没有的文件会单独报出来。

## 开发期冒烟（会消耗一次真实模型回合）

```powershell
$env:SWARM_DATA_DIR="D:/work/swarm/.swarm-data/batch1"
$env:SWARM_SMOKE_DIR="D:/work/swarm/.swarm-data/smoke-ws"
$env:SWARM_SMOKE_HOST="CodeBuddy"
$env:SWARM_SMOKE_MODEL="hy3"
bun run start
# 跑完写 .swarm-data/batch1/smoke-report.json
```

## 已知边界

- 频道、讨论串和私信接入 `packages/swarm-team` 的协作服务。真实回合与验证范围见 [第 2 批交付回执](../../docs/swarm/交付回执-第2批.md)。
- 模型清单读的是 `packages/swarm-hosts/python/data` 的本地目录；宿主升级后需要同步。
- 打包（electron-builder）尚未配置，本批只验独立构建与启动。
