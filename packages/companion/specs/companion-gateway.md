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

- 管理边界（如实）：管理操作（登记节点、生成配对码、撤销设备/节点）以 control.db 所在主机的文件系统访问权为信任边界——通过捆绑 CLI（与 serve 共库）执行；无独立 owner 凭据/管理端口。
- 配对码签发（三条途径）：① 服务器 CLI `pair-code`；② serve 进程内 owner port；③ `POST /companion/nodes/pair-code`（Bearer 节点令牌鉴权 + CSRF 头）——桌面连接器用已登记令牌为本机索取配对码，**持有节点令牌即拥有该节点的配对码签发权，撤销节点即收回**。
- 配对码签发绑定（grants 落成依据）：码在存储层携带签发者绑定——①②（owner 在 gateway 主机签发）授予**全部已登记且未撤销节点**（工作区空白名单 = 该节点全部共享工作区）；③（节点令牌签发）**只授予该节点**，body 可声明 `workspaceIdentities`（桌面 UI 传当前勾选共享的工作区）进一步收窄。桌面节点令牌不能给云节点发邀请。
- 目录可见性：`catalog` 与 `nodeStatus` 事件按设备 grants 过滤——未授权节点/工作区对设备不可见（存在性不泄露）；attach 时刻另有独立裁决。
- grants 收缩：attach 时刻即时裁决；存量 attachment 由吊销复查 sweep（≤60s）按 `decideDeviceWorkspaceAccess` 复查，越权即以 `grants_shrunk` 拆除。
- 桌面节点令牌落盘：优先 OS 凭证保护（electron safeStorage：DPAPI/Keychain/libsecret，`enc:v1:` 前缀密文）；不可用时保持 0600 明文 JSON，不阻塞功能。启动时对明文令牌做一次性升级迁移。
- 配对：一次性短时配对码 → 手机手输 6 位码 + 设备名 → 签发设备凭证（长期 refresh + 短时 access）。配对码 15 分钟有效、单次使用；`/companion/pair` 每来源限速（15 分钟 10 次），来源键取覆盖式 `X-Real-IP`（nginx 必须以 `$remote_addr` 覆盖写入，禁止 `$proxy_add_x_forwarded_for` 追加语义——XFF 第一跳客户端可伪造）。
- 手机凭证：浏览器 HttpOnly Cookie（`Path=/companion`，SameSite=Lax，Secure 生产强制）；Capacitor WebView 用 Bearer（access 短时轮换）。长期 refresh 不落 JS 可读存储（Cookie 承载）；Capacitor 端 12h access token 允许落 localStorage 作恢复回退（已接受的折中，服务端可即时撤销）。
- 校验顺序（每个连接与每个请求）：设备凭证有效性 → 设备未撤销 → 目标节点/工作区在该设备授权范围内 → attachment 代次匹配。
- 撤销：删除设备记录 + 使其 access/refresh 失效 + 主动关闭其在线连接；已接受的任务不受影响。
- 传输：生产强制 HTTPS/WSS 与正常证书校验；不做全局 TLS 豁免。Origin 校验（浏览器）；CSRF：控制面要求 `X-ZCode-Companion` 自定义头（跨站表单无法携带）。token 不进 URL 查询参数。
- 日志脱敏：凭证、配对码、会话正文不写日志；失败鉴权记事件与原因码，不记凭证内容。

## 7. 恢复与幂等语义

- 控制面心跳（spec §6 扩展）：手机 client 默认每 10s 发应用层 `ping` op，30s watchdog 内无回包判定半开连接并主动断开 → 进入重连。`CompanionConnectionSession` 是手机端唯一连接所有者：指数退避（full jitter，1s 起 30s 封顶）自动重连；鉴权被拒（WS 4401）每掉线情节先静默刷新一次，刷新失败进入 `authExpired` 终态（回配对页）；前台恢复/`online` 事件触发 `nudge()` 即时探测。UI 以连接代次（epoch）驱动 re-attach 与订阅重建——掉线时网关已按链路身份拆除 attachment，恢复 = 全新 attach + 全新订阅（不跨连接复用 capability/subscriptionId）。
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
- `packages/companion`（managed）：gateway hub、ControlStore、pairing、中继；`contract.ts` 为嵌入入口，`admin.ts` 为控制面运维入口（pair-code/register-node 等短命 CLI 与 serve 进程共享同一 control SQLite），`client.ts` 为浏览器安全客户端传输（不得引用 Node 适配层）。
- `packages/server`：cloud connector（复用 resident 协议与 daemon.json 发现），导出嵌入入口与轻量 CLI。
- `packages/desktop`（阶段 2）：desktop connector、配对/开放工作区 UI、本地 attachment broker。
- `packages/mobile`：手机 React 壳（Vite + Capacitor），只 import companion 公开入口与共享 UI 公开导出。
- 测试：domain/app 纯逻辑单测 + hub/connector 集成测试（内存 WS 对接）；验收必须连真实 resident。

## 11. 完整 UI 服务面三分名单（阶段 B）

手机壳装载完整 Web UI 后，relay 必须为 `RemoteServiceAccess` 请求的每个频道给出明确裁决。
原则：**默认拒绝**；三档分级；每档可被回归单测覆盖；提档必须写明理由。

### 11.1 分档

- **T2 直通**：原样转发（zcode-agent 仍走既有窄 facade，保持 workspace 注入与 v4 白名单）。
- **T1 方法白名单**：白名单内的调用转发，其余拒绝（`companion facade: method not allowed: <channel>.<method>`）。
- **T0 拒绝**：任何 call/listen 一律拒绝。relay 对未登记频道自动注册 T0 facade——
  保证 `RemoteServiceAccess` 的 `getChannel` 快速失败而不是挂起。

### 11.2 频道裁决表

| 频道 | 档 | 说明 |
| --- | --- | --- |
| `zcode-agent` | T2 | 既有窄 facade（v4 面 + workspace 注入） |
| `zcode-task` / `zcode-session` | T2 | 会话/任务事实与控制（停止等）——完整 UI 会话页依赖 |
| `model-selection` | T2 | 接口仅 `getView`/`onDidChange`，天然只读 |
| `broadcast` | T1（仅监听） | 跨面板刷新事件总线：事件放行；publish 是注入面（手机可向同 daemon 其他会话 UI 伪造事件），调用侧全拒 |
| `file-watcher` | T2 | 监听事件（文件树新鲜度） |
| `media-preview` | T2 | 预览渲染支撑 |
| `file` | T1 | 允许：readdir/stat/checkFilesExist/searchWorkspaceFiles/readTextFile/readMediaPreview/readFileRange/readBinaryPreview/listWorkspaceFilesLength/listWorkspaceFilesRange/resolvePath；拒绝：任何写入/建目录（ensureConversationWorkspace/createDefaultWorkspace/createScratchWorkspace/writeWorkspaceFileSearchIgnore 等） |
| `git` | T1 | 允许：getRepositorySummary/getWorkspaceRepositoryInfo/getLocalBranches/getCommitGraph/getChanges/getIgnoredPaths/getDiff/getBranchComparison/getIdentity/refresh；拒绝：switchBranch/createBranchAndSwitch/stagePaths/unstagePaths/discardPaths/commit/push/generateCommitMessage |
| `git-checkpoint` | T1 | 允许 diffCheckpoints；拒绝 createCheckpoint/restoreBetweenCheckpoints |
| `setting` | T1 | 允许 `get`；拒绝 update/updateDataBaseDir/ensureDefaultProject |
| `system` | T1 | 允许 `info`；拒绝 probeIntranet/listIntegratedTerminalShells |
| `provider-settings` | T1 | 允许 getView/refresh/resolveModelConfig（模型选择器只读）；拒绝任何 Personal Provider 写入与 testModelConnectivity |
| `coding-plan-subscription` | T1 | 启动提档（Root 动态工作流加载器）：仅配置/预览 getter（batchPreview/getStaticProducts/getStaticTeamProducts/getStartPlanPreview/getOffPeakClientConfig/getDynamicWorkflowClientConfig/getModelContextBudgetStrategy/getForceUpdateConfig）；购买/签约/支付/绑卡永 T0 |
| `bots` | T1 | 启动提档（状态读取）：getStatus/getConfig/listWorkspaceRefs/getUserConfigOptions/listBots/getBotStates；syncAppRuntimePreferences 是写方法且作用面为全部 Bot 远端 runtime，永 T0；注册/保存/删除/测试/绑定/自动化处置永 T0 |
| `onboarding-record` | T1 | 启动提档（被拒会让 Root 引导判定回退成“需要引导”拦住主界面）：仅只读判定面 shouldOnboard/getLatestEntry/getRecords/syncSettingsFromRecord；append/record/dismiss/clear 等写方法永 T0 |
| `oauth` | T0→按启动实测提档 | 登录态读取若为启动必需，提 T1 只读并在此登记；登录/登出写操作永 T0 |
| `terminal` / `credential` / `cua-permission` / `cua-pip-session` / `provider-provisioning-target` | T0 | 高权限面，永不下发 |
| `window-controller` | T1（`controller-readonly`） | 只读任务列表 + 任务索引帧流（手机侧栏跨工作区活度的实时源，详见 §11.4.1）；写方法永 T0 |
| `settings-sync` | T1 | 启动提档（被拒会让首启提示每次启动循环出现）：仅 getFirstRunPromptState（读）与 markFirstRunPromptHandled（“提示已读”UI 簿记写，写入内容不含用户数据）；其余同步写方法永 T0 |
| `skills` / `skill-sync` / `mcp-sync` / `plugin-sync` / `plugins` / `plugin-management` / `subagents` / `commands` / `hooks` / `memory` / `off-peak-task` | T0 | 写宿主用户目录/插件/自动化面，首版不下发 |
| `conversation-share` / `prompt-attachment-transfer` / `feedback` / `usage-stats` / `client-config` / `client-scenes` | T0→按启动实测提档 | 完整 UI 启动链若硬依赖其中只读面，逐个提 T1 只读并在此表登记 |

### 11.3 提档规则

1. T0 → T1 只需给出方法白名单，禁止整频道直通。
2. 任何**写方法**（产生宿主副作用：落盘、网络提交、凭据、自动化）不进手机白名单；
   写需求走 v4 命令通道（createSession/sendText/stop/resolveInteraction）。
3. 每次提档在本表登记理由；`未登记频道 → T0` 是永久不变量。
4. 回归覆盖：每档至少一条单测（T1 白名单内放行 + 白名单外拒绝；T0 全拒）。

### 11.4 workspace 绑定（全频道强制）

- T1/T2 频道的**每个入参**都按 attachment 绑定塑形（`shapeArgsWithScope`）：
  顶层 `workspacePath`/`workspaceIdentity` 默认强制覆写为绑定值（客户端声明一律覆盖）；
  顶层 `path`/`rootPath`/`paths[]` 必须落在绑定工作区之内，越界即拒绝
  （`companion facade: path escapes workspace`），路径归一（反斜杠/大小写/尾斜杠）后比较。
- 没有这层，file/git 等只读白名单会退化成宿主任意路径读取原语（审查发现并已封堵）。
- zcode-agent 由既有窄 facade 注入，语义相同。

#### 11.4.1 共享工作区集合（跨工作区只读列举的唯一放宽口）

手机侧栏要为**每个已共享工作区**各读一次只读任务摘要；把目标一律坍缩到 attachment
绑定工作区，会让除已 attach 工作区外的所有共享工作区永远显示「暂无任务」（真机复现并修复）。
因此 attachment 的 scope 携带 `sharedWorkspaces`——**connector 是"哪些工作区已共享"的权威**
（桌面 = 已打开且在共享白名单内；云端 = 已登记云工作区）——并只在这两处受控放宽：

| 位置 | 规则 |
| --- | --- |
| `workspaceScopes[]`（zcode-task 列表/分组、`window-controller.listTaskList`） | 逐项收窄：命中共享集合则原样保留，未命中整项丢弃并留痕 |
| zcode-task 只读列表方法的**顶层** `workspacePath`（`listTasks`/`listPinnedTasks`/`listArchivedTasks`/`listDeletedTaskIds`） | 命中共享集合则原样放行，未命中仍改写成绑定工作区 |
| zcode-task 事件订阅（`onDynamicWorkspaceEvent`）的顶层目标 | 同上：命中共享集合则原样订阅，未命中仍改写成绑定工作区。侧栏跨工作区活度（归档/置顶/未读的 `workspace_task_list_changed`→bump→重读左表）依赖它，改写会让手机永远收不到其它共享工作区的变化（真机复现） |
| window-controller（`controller-readonly`） | 只读方法 `listTaskList` + 订阅/续订/退订；帧（`onDynamicControllerFrame`）经 `filterControllerFrameToShared` 逐帧按共享集合过滤后才下发，帧封套（subscriptionId/logEpoch/fromSeq/toSeq）原样保留（seq 连续性是 gap 检测与 resync 的依据），全滤空的增量仍以空增量转发；无共享集合时拒绝订阅；`mutateTask`/`deleteArchivedTask(s)` 与其它事件永 T0；刻意不从帧学习 taskId 允许集（跨工作区操作仍须先 attach） |
| 其余全部（file/git/agent 的顶层目标、一切写方法与按 taskId 的操作） | 不变：强制绑定值 / 拒绝 |

- `allowSharedTopLevelWorkspace` 默认关闭，且**只允许** zcode-task 的只读列表方法
  与事件订阅开启（file/git/agent 等读写内容面绝不开启——它们的读内容必须留在所选
  attachment 内）。
- 写方法与按 taskId 的操作**不得**借只读索引跨工作区：`TaskScopedChannel` 的允许集仍然
  只学习绑定工作区内的 taskId，跨工作区操作必须先 attach 到该工作区（fail-closed）。
- 集合未知（scope 未带 `sharedWorkspaces`）时全部退回旧行为，不放宽任何范围。
- 未命中的 scope 留痕 `[companion-facade] scope outside shared set: <path>`——
  静默丢弃会让"某工作区一直空列表"无从定位。

### 11.4a 只读任务索引（目录层跨工作区聚合）

- op：手机 `workspace-tasks {nodeId, workspaceIdentity}` → hub（grants 裁决与 attach 同一
  函数 + 30s TTL 缓存）→ 节点 `workspace-tasks` → connector。
- connector 执行 `readWorkspaceTaskSummary`，**两条读面**（单靠第一条会让"本会话尚未启动
  运行时"的共享工作区连目录层也读不到历史）：
  1. sessions-index（优先，含实时 `sessionEnded`/`pendingInteractionSummary`）：对既有运行时开
     **临时上游**（云端 = daemon loopback TCP；桌面 = 窗口 Host 临时 attachment 端口），v4 握手后以
     `runtimePolicy: "existing-only"` 订阅，取首个权威快照即退订并释放；
  2. 磁盘任务读面（兜底）：同一临时端口上 `IZCodeTaskService.listTasks` 直读 tasks-index 持久化。
- **两条都是只读、都不新建执行者。** 注意 `existing-only` 在"该工作区 agent 运行时未启动"时
  必然不可用（Host 端 `getReadOnlyClient` 语义，抛 `ZCode Agent runtime is not running.`）——
  这不是错误，此时必须走磁盘读面，否则一律 `available:false`（start-if-needed 只属于手机显式
  进入工作区路径）。sessions-index 尝试只拿预算上限内的一段，剩余时间留给磁盘兜底。
- 摘要只含目录展示最小字段（sessionId/title/ended/pendingCount/lastActivityAt，≤20 条，
  title 截断 200 字）；不携带正文/命令/答案。全程硬超时，失败返回 `available:false`。
- 任务权威永远在执行端；gateway 缓存只是展示摘要，随 grants 收缩由裁决路径即时拒绝。

### 11.5 桌面与云端差异

- 桌面附着工作区：上游 Host 已暴露完整 remote ServiceCollection，relay 按本表逐频道裁决。
- 云端 resident：`createStdioServices` 注册同一完整集合，处理方式相同。
- 上游本就没有的频道：T0 facade 同样快速失败，行为一致。
