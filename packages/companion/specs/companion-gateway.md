# Companion Gateway（My zcode 接入与转发服务）规格

状态：已批准方案的实现规格（首版）。上游方案：`.zcode/plans/plan-sess_6a295cdd-c1b8-4f64-84c5-cdb719b83b92.md`。
本规格覆盖首版（个人自托管、Android App + 手机网页、双端控制闭环）。

## 1. 产品规则

- My zcode 是**个人**手机控制端：单所有者、多设备配对，不依赖官方账号后端，不提供多用户隔离。
- 手机控制两类执行目标：
  - **desktop 节点**：一台电脑上已打开工作区的 ZCode（含其已建立的远程工作区）。电脑窗口/工作区关闭后该入口即时不可用；不承诺电脑后台常驻。
  - **cloud 节点**：已登记的云端 resident 运行时。电脑不参与链路；resident 未运行时如实显示不可用，**不在接入过程中隐式启动新运行时**。
- 手机首版操作面：工作区目录、会话索引、会话订阅/恢复、创建会话、发送文本、停止、回答交互（含计划审批与模型选择）、模型/模式读取、结果与差异只读读取。
- 手机不可做：凭据管理、任意文件系统访问、终端、服务端配置、provider provisioning、未列出的任何特权操作。
- 不为手机另起第二个 Agent、Local Host 或云端执行服务；手机附着到**已有**运行时。

## 2. 拓扑与转发模型

```text
My zcode (浏览器 / Capacitor WebView)
   │  WSS /companion/ws   ← 设备凭证（Cookie 或 Bearer）
   ▼
Companion Gateway（自托管，Hono + ws）
   │  控制面：JSON 帧（attach/detach/catalog/heartbeat）
   │  数据面：attach 后 binary 帧一对一透传
   ▼  WSS /companion/node（节点连接器出站连接，node token）
Node Connector（desktop: Electron Main；cloud: server 包进程）
   │  本机附着（desktop: Host MessagePort；cloud: resident loopback TCP）
   ▼
既有运行时（window Host / resident daemon 的 ServiceCollection）
```

- **数据面是字节透传**：mobile 连接在 attach 成功后，其 binary 帧与该 attachment 的 relay WS 逐帧互转；两端各自跑既有 `SocketProtocol`/`ChannelServer`/`ChannelClient`。gateway 不解释、不缓存、不重排数据面帧。
- gateway 同时只把一个 mobile 连接绑定到一个 attachment；切换目标 = detach → 重新 attach。
- attachment 准入用**一次性 capability**：hub 在控制面发给 connector，connector 凭 capability 拨通 `/companion/relay/:id`；hub 校验消费。复用 server 包 hostCapability 的既有语义（单次、短时、绑定连接）。
- connector 侧对外暴露的是**收窄后的 IZCodeAgentService channel**（见 §5），不是完整 ServiceCollection。

## 3. 状态所有权

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| 设备登记、配对、授权、节点登记 | gateway `ControlStore`（node:sqlite） | 唯一权威；秘密（token 哈希）以哈希存储 |
| 节点在线状态、attachment 绑定 | gateway 内存 hub | 进程重启后由 connector 重连与手机重新 attach 恢复 |
| 任务、会话、审批请求、命令事实 | 既有 Agent runtime / CommandInbox | gateway/connector/手机均不复制 |
| 会话投影、恢复游标、草稿、待核对命令 | 手机 UI 数据层 | 复用 packages/ui v4 数据层语义 |
| attachment 生命周期与 workspace 绑定 | node connector | 每attachment 一个 connection scope |

## 4. 控制面协议（JSON 帧）

传输：`/companion/ws`（手机，文本帧）；`/companion/node`（connector，文本帧）。信封：

```jsonc
{ "v": 1, "id": "req-id", "op": "catalog", "params": {} }        // 请求
{ "v": 1, "id": "req-id", "ok": true, "result": {} }             // 响应
{ "v": 1, "id": "req-id", "ok": false, "error": { "code": "...", "message": "..." } }
{ "v": 1, "event": "nodeStatus", "payload": {} }                 // 服务端事件
```

手机 → gateway：`catalog`（节点+工作区目录+状态）、`attach`（nodeId+workspacePath+workspaceIdentity）、`detach`。
gateway → 手机事件：`nodeStatus`（在线/离线）、`attached`（attachmentId + relay 路径）、`error`。
gateway ↔ connector：`hello`（nodeId+capabilities）、`workspaces`（白名单目录）、`attachRequest`/`attachResult`、`heartbeat`。

错误码：`unauthorized`、`forbidden_workspace`、`node_offline`、`workspace_unavailable`、`attachment_limit`、`bad_request`、`internal`。所有 schema 定义于 `@zcode/shared` 的 companion-protocol（Zod 严格解析，未知字段拒绝）。

## 5. 数据面与收窄 facade

connector 对手机暴露单一 channel（`IZCodeAgentService.channelName`），方法白名单（首版）：

- 会话：`v4ConversationSubscribe/Unsubscribe/Resync`、`v4ConversationRowsRange`、`v4SessionIndexSubscribe/...`、`v4CommandsQuery`
- 命令：`v4Command`（payload 白名单：`createSession`、`sendText`、`stop`、`resolveInteraction`；其余类型拒绝）
- 只读面：`v4ConversationFileChanges`、`v4ConversationPlans`、模型/模式读取类方法
- 显式拒绝：provisioning、凭据、settings 写、terminal、file 通用读写、内部特权方法

实施约束：

- desktop 连接器复用 `attachRemoteWorkspaceSessionHost`（clientMode `web-remote-replayable`），沿用其窗口/身份/代次校验；不新建远程连接。
- cloud 连接器对 resident TCP 做既有 hello/ack 握手，得到 trusted-host-relay scope 的客户端代理；**在其外包一层收窄 facade** 再暴露给手机。手机侧连接在 facade 视角是 terminal-client 语义，绝不透传 trusted 载体；`connectionId`/role 由 connector 生成，不采信手机输入。
- 每个 attachment 一个 connection scope；detach/断开只 dispose 本 attachment 的订阅。
- `workspaceIdentity` 沿用 `workspaceIdentity?.trim() || workspacePath` 既有构造，不手写格式；attach 参数必须与 connector 侧登记的白名单条目精确匹配。

## 6. 配对与认证

- 初始化：gateway 首次启动生成 owner 设置码（服务器本机文件，0600）；管理操作（登记节点、生成配对码、撤销设备）要求 owner 凭据或本机管理端口。
- 配对：owner 生成一次性短时配对码 → 手机提交（扫码/手输）+ 设备名 → owner 或自动策略确认 → 签发设备凭证（长期 refresh + 短时 access）。配对码 15 分钟有效、单次使用。
- 手机凭证：浏览器 HttpOnly Cookie（`Path=/companion`，SameSite=Lax，Secure 生产强制）；Capacitor WebView 用 Bearer（access 短时轮换）。长期秘密存 Keystore（Android）/不做 localStorage 持久化（Web）。
- 校验顺序（每个连接与每个请求）：设备凭证有效性 → 设备未撤销 → 目标节点/工作区在该设备授权范围内 → attachment 代次匹配。
- 撤销：删除设备记录 + 使其 access/refresh 失效 + 主动关闭其在线连接；已接受的任务不受影响。
- 传输：生产强制 HTTPS/WSS 与正常证书校验；不做全局 TLS 豁免。Origin 校验（浏览器）；CSRF：控制面要求 `X-ZCode-Companion` 自定义头（跨站表单无法携带）。token 不进 URL 查询参数。
- 日志脱敏：凭证、配对码、会话正文不写日志；失败鉴权记事件与原因码，不记凭证内容。

## 7. 恢复与幂等语义

- 手机保存 `(logEpoch, seq)` 游标仅在完整应用投影后更新；重连 → 新订阅 → 请求 resume，缺口/换代 → resync 快照。复用 UI 数据层既有实现，gateway 不新增恢复状态。
- 命令幂等边界在 CommandInbox：手机对每条命令生成稳定 commandId，ACK 丢失后先 `queryCommands` 对账，不盲目重发；执行端换代后未确认命令显示"未确认"，不自动重放。
- gateway/connector 重启：节点重连重新 hello；手机收到 nodeStatus 离线→在线事件后重新 attach；数据面透传不跨重启保持。
- 迟到 stop 携带 `expectedForegroundExecutionId`；resolveInteraction 先到先得（proto.alreadyResolved）。

## 8. 失败语义

| 失败 | 行为 |
| --- | --- |
| 手机断开 | dispose attachment 订阅；任务继续（连接 scope 语义） |
| connector 断开 | 所有经其 attachment 立即对手机报 `node_offline` 并 detach；运行时不受影响（cloud） |
| gateway 重启 | 在线连接断开重连；控制库持久；不丢任务 |
| resident 未运行 | attach 返回 `workspace_unavailable`；不拉起 daemon |
| 配额 | 每 gateway 并发 attachment 上限（默认 8）、帧大小上限（默认 1 MiB）与 WS 消息上限由 hub 强制；超限断开连接 |

## 9. 验收场景（对应方案 §八）

1. 手机经 gateway 对 cloud 工作区创建会话、发任务、停止、回答审批。
2. 手机断网/锁屏期间任务继续；回来后 resume/快照恢复。
3. ACK 丢失 → queryCommands 对账不重复执行；换代后未确认命令不自动重发。
4. 撤销设备即时断开并拒绝新请求；过期/重放配对码被拒。
5. 越权 workspace、未白名单方法、trusted 载体注入被拒。
6. relay 帧上限与 attachment 配额生效且不误伤正常流。
7. 同路径不同节点不串会话；代次不匹配的 attach 被拒。
8. cloud 闭环在真实 resident 上验证（本地实测）；desktop 侧在阶段 2 验证。

### 9.1 自动化测试覆盖边界（阶段 1/2 交付时点）

机器可测、已有测试覆盖：
- 场景 4/5/6/7 的 gateway 侧逻辑（companion 包单测/集成测试）。
- 场景 8 的 cloud 闭环（真实 resident + gateway + connector + 手机端模拟，companion-smoke）。
- desktop 连接器侧子集：目录白名单过滤、attach 端口选择与消息路径、非白名单拒绝、
  detach/白名单收缩/窗口关闭拆除（desktop 包连接器集成测试；上游端口为测试假体）。

**未自动化、归阶段 4 真机验收**：
- 「手机与桌面共享同一会话」的一致性（两条 attachment 到达同一 window Host
  runtime 后的会话事实合流）——需要真实 Electron Host 与桌面 UI 参与。
- 「双端同时审批只生效一次」（依赖 runtime 先到先得语义在真实双链路上的表现）。
- 手机 UI 层的 createSession → 订阅 → 快照/增量渲染端到端（需真实手机/浏览器会话）。

以上未验证项在交付声明中必须如实标注，不得以连接器侧测试冒充一致性验证。

## 10. 模块边界

- `packages/shared`：companion-protocol（信封、DTO、错误码 Zod schema）。
- `packages/companion`（managed）：gateway hub、ControlStore、pairing、中继；`contract.ts` 为嵌入入口，`client.ts` 为浏览器安全客户端传输（不得引用 Node 适配层）。
- `packages/server`：cloud connector（复用 resident 协议与 daemon.json 发现），导出嵌入入口与轻量 CLI。
- `packages/desktop`（阶段 2）：desktop connector、配对/开放工作区 UI、本地 attachment broker。
- `packages/mobile`：手机 React 壳（Vite + Capacitor），只 import companion 公开入口与共享 UI 公开导出。
- 测试：domain/app 纯逻辑单测 + hub/connector 集成测试（内存 WS 对接）；验收必须连真实 resident。
