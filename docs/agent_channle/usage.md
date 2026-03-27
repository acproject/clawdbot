# agent_channel 使用文档

本文档面向 `agent_channel` 项目使用者，覆盖构建运行、控制协议、实时订阅、MiniMemory 集成、网关连接、以及 WebSocket 远程接入的鉴权与安全建议。

## 1. 组件概览

本项目主要包含两个可执行程序：

- `channel_daemon`：后台服务，负责：
  - 控制协议（Unix Domain Socket）
  - 可选 WebSocket 控制入口（用于远程 Web UI / 聚合层）
  - 事件发布（EventHub）与 MiniMemory 事件桥接（MemoryBridge）
  - 频道/消息模型（基于 MiniMemory KV）
  - Agent 运行（线程池）
  - ToolHost 文件系统工具（受沙箱限制）
  - 可选网关连接（GatewayConnector）
- `channel_ui`：本地 ImGui 控制界面，通过本地控制 socket 与 `channel_daemon` 通信，并展示频道、消息、事件流等。

## 2. 构建

项目使用 CMake（C++20）。仓库已内置 third 依赖（asio/imgui/glfw/spdlog/json/MiniMemory）。

### 2.1 生成构建目录

```bash
cmake -S . -B build
```

### 2.2 编译

```bash
cmake --build build -j
```

产物默认在 `build/` 下：

- `build/channel_daemon`
- `build/channel_ui`（当启用 UI 构建选项时）

### 2.3 常用 CMake 选项

- `AGENT_CHANNEL_BUILD_THIRD_DEPS=ON|OFF`：是否编译 third 依赖（默认 ON）
- `AGENT_CHANNEL_BUILD_MINIMEMORY=ON|OFF`：是否构建 bundled MiniMemory（默认 ON）
- `AGENT_CHANNEL_BUILD_UI=ON|OFF`：是否构建 ImGui UI（默认 ON）

示例：

```bash
cmake -S . -B build -DAGENT_CHANNEL_BUILD_UI=ON
cmake --build build -j
```

## 3. 运行

建议先启动 MiniMemory（你也可以使用已部署的 MiniMemory 服务），再启动 `channel_daemon`，最后启动 `channel_ui`。

### 3.1 环境变量

`channel_daemon` 支持以下环境变量：

#### 3.1.1 控制通道

- `AGENT_CHANNEL_SOCKET`：Unix Domain Socket 路径（默认 `/tmp/agent_channel.sock`）

#### 3.1.2 WebSocket 控制入口（可选）

- `AGENT_CHANNEL_WS_PORT`：WebSocket 监听端口；为 `0` 表示禁用（默认 0）

WebSocket 鉴权 / 访问控制（强烈建议在任何“非本机”场景启用）：

- `AGENT_CHANNEL_WS_TOKEN`：固定 token 校验（推荐）
- `AGENT_CHANNEL_WS_SIGNATURE_SECRET`：签名 secret（可选增强）
- `AGENT_CHANNEL_WS_ALLOWLIST`：IP allowlist（CIDR 列表，逗号/分号/换行分隔）
  - 示例：`127.0.0.1/32,10.0.0.0/8,192.168.0.0/16`

重要行为：

- 当三项鉴权配置都未设置时：仅允许 loopback（127.0.0.1 / ::1）连接，其他来源会被拒绝（HTTP 403）。
- 当设置了 allowlist 时：只有 allowlist 命中的来源 IP 才允许进入握手流程。
- 当设置了 token 时：必须提供正确 token，否则拒绝。
- 当设置了 signature secret 时：必须提供正确签名，否则拒绝。

#### 3.1.3 MiniMemory

- `MINIMEMORY_HOST`（默认 `127.0.0.1`）
- `MINIMEMORY_PORT`（默认 `6379`）
- `MINIMEMORY_PASSWORD`（可选）

#### 3.1.4 网关（可选）

- `GATEWAY_HOST`（可选）
- `GATEWAY_PORT`（可选）
- `GATEWAY_TOKEN`（可选）

### 3.2 启动 channel_daemon

例：本地 MiniMemory + 本地控制 socket + 开启 WebSocket 8080

```bash
export MINIMEMORY_HOST=127.0.0.1
export MINIMEMORY_PORT=6399
export MINIMEMORY_PASSWORD=password123

export AGENT_CHANNEL_SOCKET=/tmp/agent_channel.sock
export AGENT_CHANNEL_WS_PORT=8080
export AGENT_CHANNEL_WS_TOKEN=change_me
export AGENT_CHANNEL_WS_ALLOWLIST=127.0.0.1/32

./build/channel_daemon
```

启动后会在日志中打印：

- `control.socket=...`
- `ws.port=...`（如果启用 WS）

### 3.3 启动 channel_ui（本地）

```bash
export AGENT_CHANNEL_SOCKET=/tmp/agent_channel.sock
./build/channel_ui
```

UI 里支持中英切换，并会尝试加载中文字体；若提示中文字体缺失，中文可能显示为方块。

## 4. 控制协议（JSON-RPC 风格）

控制协议是“每行一个 JSON”的请求-响应模式：

- 请求：`{"id":1,"method":"...","params":{...}}`
- 响应：`{"id":1,"ok":true,"result":...}` 或 `{"id":1,"ok":false,"error":"..."}`

本地 UI 使用 Unix Domain Socket 连接该协议；WebSocket 控制入口也复用同样的 `method/params` 处理逻辑。

### 4.1 基础方法

#### ping

```json
{ "id": 1, "method": "ping", "params": {} }
```

#### shutdown

```json
{ "id": 1, "method": "shutdown", "params": {} }
```

说明：

- `shutdown` 会停止 daemon 事件循环并退出进程。
- 因为它可被远程触发，务必对 WebSocket 通道启用鉴权（见第 6 节）。

### 4.2 频道（Channel）

频道元数据会存储在 MiniMemory：

- `agent_channel:channel_seq`：频道自增序号
- `agent_channel:channel:<seq>`：seq -> channel_id
- `agent_channel:channel:meta:<channel_id>`：meta JSON

#### channel.create

Params：

- `name`：频道名（必填）
- `id`：可选，自定义 channel_id（不建议频繁使用）
- `owner_agent_id`：可选，频道归属字段（用于 Web UI/飞书汇总更稳定）

```json
{
  "id": 1,
  "method": "channel.create",
  "params": { "name": "general", "owner_agent_id": "agent://my-agent" }
}
```

事件：

- `channel.created`（事件流会广播）

#### channel.list

Params：

- `since_seq`：从哪个 seq 之后开始取
- `limit`：最多返回多少条（1~200）

```json
{ "id": 1, "method": "channel.list", "params": { "since_seq": 0, "limit": 200 } }
```

### 4.3 消息（Message）

消息存储在 MiniMemory：

- `agent_channel:msg_seq:<channel_id>`：消息自增序号
- `agent_channel:msg:<channel_id>:<seq>`：消息 JSON

#### message.post

Params：

- `channel_id`（必填）
- `content`（必填）
- `author`（可选，默认 `user`）

```json
{
  "id": 1,
  "method": "message.post",
  "params": { "channel_id": "...", "content": "hello", "author": "user" }
}
```

事件：

- `message.posted`

#### message.list

Params：

- `channel_id`
- `since_seq`
- `limit`（默认 50，最大 200）

```json
{
  "id": 1,
  "method": "message.list",
  "params": { "channel_id": "...", "since_seq": 0, "limit": 50 }
}
```

### 4.4 Agent

#### agent.list

返回可用 agent 名单。

```json
{ "id": 1, "method": "agent.list", "params": {} }
```

#### agent.spawn

创建一个 agent instance（支持父子结构）。

Params：

- `agent`：agent 名称
- `parent_id`：可选，父 instance id
- `context`：可选，上下文 JSON

```json
{ "id": 1, "method": "agent.spawn", "params": { "agent": "agent.echo", "context": { "k": "v" } } }
```

#### agent.run

运行指定 instance。

Params：

- `instance_id`
- `input`：输入 JSON

```json
{ "id": 1, "method": "agent.run", "params": { "instance_id": "...", "input": { "q": "hello" } } }
```

事件：

- `agent.run.result`
- `agent.run.error`

### 4.5 ToolHost（文件工具）

通过 `tool.call` 调用文件工具。ToolHost 使用“root 沙箱目录”（daemon 启动时的 `current_path()`），拒绝访问沙箱外路径。

#### tool.call

```json
{ "id": 1, "method": "tool.call", "params": { "name": "fs.list", "path": "." } }
```

当前支持：

- `fs.list`：列目录
- `file.read`：读文件（限制最大 1MB）
- `file.write`：写文件

安全提示：

- `tool.call` 属于高危能力，远程接入时必须启用 WebSocket 鉴权（见第 6 节）。

## 5. 事件流（M1：实时订阅）

daemon 内部有 EventHub，任何事件会被：

- 广播给订阅者（UI / WebSocket）
- 写入 MiniMemory 事件序列（用于断线后补拉）
- 如配置网关，则同步发往网关

### 5.1 WebSocket 事件订阅

在 WebSocket 连接建立后，可发送：

#### event.subscribe

```json
{ "id": 1, "method": "event.subscribe", "params": {} }
```

之后服务端会推送：

```json
{"type":"event","event":{...}}
```

#### event.unsubscribe

```json
{ "id": 2, "method": "event.unsubscribe", "params": {} }
```

### 5.2 MiniMemory 事件补拉

控制方法：

- `minimemory.last_event`
- `minimemory.events.since`

用于 UI 在非实时模式下拉取或断线补偿。

## 6. WebSocket 鉴权与安全建议

### 6.1 为什么必须做鉴权

WebSocket 控制入口复用了本地控制协议的能力，包含：

- `shutdown`：可直接让 daemon 退出
- `tool.call`：可读写沙箱内文件

因此任何远程场景都必须启用鉴权与访问控制。

### 6.2 推荐配置（最低成本）

- `AGENT_CHANNEL_WS_TOKEN`：设置一个随机长 token
- `AGENT_CHANNEL_WS_ALLOWLIST`：只放行可信网段或堡垒机出口 IP

并仅在需要远程时开启端口（`AGENT_CHANNEL_WS_PORT`）。

### 6.3 签名模式说明（可选增强）

当设置 `AGENT_CHANNEL_WS_SIGNATURE_SECRET` 后，握手 URL 需要携带：

- `ts`：时间戳（毫秒；如果传秒会自动乘 1000）
- `sig`：签名（十六进制 sha1）

签名计算：

```
sig = sha1_hex( secret + "|" + path + "|" + ts + "|" + token )
```

其中 `path` 是不含 query 的请求路径（例如 `/ws`），`token` 若未使用可传空字符串。

时间偏差窗口：±60 秒。

## 7. 网关连接（GatewayConnector）

如果设置了 `GATEWAY_HOST/GATEWAY_PORT`，daemon 会连接网关并：

- 启动时发送 `hello`（若设置 `GATEWAY_TOKEN`）
- 将事件发布给网关
- 接收网关下发的 inbound（当前示例支持 `task.submit` 透传给 daemon）

## 8. 常见使用流程

### 8.1 本地 UI 开发/调试

1. 启动 MiniMemory
2. 启动 `channel_daemon`（只开 Unix socket，不开 WS）
3. 启动 `channel_ui`，在 UI 中：
   - 拉取频道
   - 创建频道（可填写 owner_agent_id）
   - 发送消息
   - 查看事件流

### 8.2 远程 Web UI / 飞书汇总的推荐模式（路线 A）

1. daemon 开启 WebSocket：`AGENT_CHANNEL_WS_PORT`
2. 启用 `AGENT_CHANNEL_WS_TOKEN` + `AGENT_CHANNEL_WS_ALLOWLIST`（必要时加签名 secret）
3. Web UI 通过 WS 订阅事件流（`event.subscribe`），统一汇总到飞书（可文件模式）
4. 使用 `owner_agent_id` 将频道归属稳定绑定到对应 agent，方便统一聚合与展示
