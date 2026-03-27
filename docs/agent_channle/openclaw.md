# Openclaw 对接 agent_channel（TCP 桌面/远程控制）使用文档

本文档说明 Openclaw 如何通过 TCP（非 WebSocket）对接 `agent_channel`，实现：

- 远程启动的 `channel_daemon` + 本地运行的 Openclaw（或桌面 UI）控制端
- 请求-响应式控制（JSON-RPC 风格）
- 事件订阅（服务端推送事件流）
- MiniMemory 存储驱动的频道/消息数据访问

本仓库中的协议与字段定义以 [usage.md](file:///Users/acproject/workspace/cpp_projects/agent_channel/doc/usage.md) 为准；本文档聚焦 Openclaw 对接侧的落地步骤与约定。

## 1. 架构与连接方式

### 1.1 角色

- `channel_daemon`（服务器）：常驻进程，提供控制协议、事件流、频道/消息模型与 MiniMemory 桥接。
- Openclaw（客户端）：通过 TCP 连接远程 daemon，发起控制请求、订阅事件、拉取频道与消息数据，并可触发 agent/任务相关操作。

### 1.2 TCP 协议概览

协议采用“每行一个 JSON”的文本帧：

- 请求：`{"id":1,"method":"...","params":{...}}\n`
- 响应：`{"id":1,"ok":true,"result":...}\n` 或 `{"id":1,"ok":false,"error":"..."}\n`
- 事件：`{"type":"event","event":{...}}\n`

注意：

- 连接上同一个 TCP socket 上会同时出现“响应行”和“事件行”，客户端必须区分处理。
- `id` 用于请求-响应关联；事件行没有 `id`，而是 `type="event"`。

## 2. 服务器端（channel_daemon）配置与启动

### 2.1 配置文件（推荐）与覆盖优先级

`channel_daemon` 支持通过配置文件加载参数，同时保留环境变量覆盖：

- 默认值 < 配置文件 < 环境变量

支持的配置入口：

- `--config /path/to/config.json`
- 或环境变量 `AGENT_CHANNEL_CONFIG=/path/to/config.json`

示例参考：[config.json](file:///Users/acproject/workspace/cpp_projects/agent_channel/doc/config.json)

### 2.2 TCP 监听与安全建议

服务器端关键字段（配置文件 `daemon.tcp`）：

- `port`：TCP 监听端口（示例 9009）
- `token`：固定 token 校验（推荐）
- `signature_secret`：签名 secret（可选增强）
- `allowlist`：IP allowlist（CIDR 列表，逗号/分号/换行分隔）

重要提示：

- `allowlist="0.0.0.0/0"` 表示允许所有来源（调试可用，上线不建议）。
- 更安全做法是只放行 Openclaw 所在机器的公网出口 IP，例如 `203.0.113.45/32`。

### 2.3 MiniMemory 配置

服务器端通过 `daemon.minimemory` 指定 MiniMemory：

- `host`（默认 `127.0.0.1`）
- `port`（默认 `6379`）
- `password`（可选）

同名环境变量可覆盖：

- `MINIMEMORY_HOST` / `MINIMEMORY_PORT` / `MINIMEMORY_PASSWORD`

## 3. Openclaw 客户端配置

Openclaw 侧至少需要以下信息（配置文件 `ui.tcp`，或以 Openclaw 自身配置系统映射同义字段）：

- `host`：daemon 域名或 IP（示例 `owiseman.com`）
- `port`：daemon TCP 端口（示例 `9009`）
- `token`：与 `daemon.tcp.token` 一致
- `signature_secret`：与 `daemon.tcp.signature_secret` 一致（若启用）

如果 Openclaw 运行在内网且通过跳板/反向代理访问 daemon，需要保证：

- TCP 端口可达（防火墙/安全组放行）
- 若启用了 allowlist，则放行的是 Openclaw 看到的“来源 IP”（通常是出口网关 IP）

## 4. 鉴权（TCP）

当服务器端配置了 `daemon.tcp.token` 或 `daemon.tcp.signature_secret` 时，客户端必须先发起 `auth`。

### 4.1 auth 请求

```json
{ "id": 1, "method": "auth", "params": { "token": "...", "ts": 1710000000000, "sig": "..." } }
```

- `token`：固定 token（未配置 token 时可传空字符串）
- `ts`：时间戳（毫秒；若传秒服务端会兼容乘 1000）
- `sig`：签名（十六进制 sha1），仅当服务端启用了 `signature_secret` 时需要

### 4.2 TCP 签名算法

当设置了 `signature_secret` 时：

```
sig = sha1_hex( secret + "|" + ts + "|" + token )
```

时间偏差窗口：±60 秒。

## 5. 事件订阅（Openclaw 必做）

鉴权通过后（或服务端未启用鉴权且允许来源连接），Openclaw 需要订阅事件流：

```json
{ "id": 2, "method": "event.subscribe", "params": {} }
```

之后服务端会持续推送：

```json
{"type":"event","event":{...}}
```

建议 Openclaw 将事件处理拆为两条路径：

- 同步：处理带 `id` 的响应，唤醒等待该请求的协程/Promise
- 异步：处理 `type="event"` 的事件，写入本地事件总线/状态机

## 6. 常用控制方法（Openclaw 调用清单）

具体字段与语义以 [usage.md](file:///Users/acproject/workspace/cpp_projects/agent_channel/doc/usage.md) 为准；Openclaw 通常会用到：

### 6.1 连通性

- `ping`

```json
{ "id": 10, "method": "ping", "params": {} }
```

### 6.2 频道

- `channel.list`
- `channel.create`

```json
{"id":11,"method":"channel.list","params":{"since_seq":0,"limit":200}}
{"id":12,"method":"channel.create","params":{"name":"general","owner_agent_id":"agent://openclaw"}}
```

### 6.3 消息

- `message.post`
- `message.list`

```json
{"id":20,"method":"message.post","params":{"channel_id":"...","content":"hello","author":"user"}}
{"id":21,"method":"message.list","params":{"channel_id":"...","since_seq":0,"limit":50}}
```

### 6.4 Agent

- `agent.list`
- `agent.spawn`
- `agent.run`

```json
{"id":30,"method":"agent.list","params":{}}
{"id":31,"method":"agent.spawn","params":{"agent":"agent.echo","context":{"k":"v"}}}
{"id":32,"method":"agent.run","params":{"instance_id":"...","input":{"q":"hello"}}}
```

## 7. 断线重连与状态恢复建议

Openclaw 需要把 TCP 连接当作“可能随时断开”的通道来设计：

- 断线后重连：指数退避或固定间隔重连
- 重连后恢复：重新 `auth`（如需要）+ 重新 `event.subscribe`
- 业务状态补齐：通过 `channel.list`/`message.list` 拉取增量，或使用 `minimemory.events.since` 做事件补拉（见 usage.md 第 5.2 节）

## 8. 排错清单（最常见）

- UI/客户端提示 `read_until: Connection reset by peer`
  - allowlist 不匹配（例如误写成 `0.0.0.0/32`）；调试可先设 `0.0.0.0/0`
  - token 不一致或未先 `auth`
  - 服务器端口未放行/未监听

- macOS 控制台出现 `IMKCFRunLoopWakeUpReliable`
  - 通常是输入法系统日志，非业务错误；以 UI 内的连接状态与 daemon 日志为准
