# My zcode companion 自托管部署指南（宝塔 / Linux）

自托管接入栈的部署、运维与故障排查。栈组成：**gateway**（HTTPS 入口、配对、路由）+ **resident daemon**（云端执行运行时）+ **云端连接器**（出站连 gateway，附着 daemon）。

## 1. 前置条件

- Linux x86_64，**Node ≥ 24**（companion 使用 `node:sqlite`；面板「Node 版本管理」可装）。
- 公网入口的 TLS 证书（本部署用宝塔站点的 Let's Encrypt IP 证书，自动续期）。
- 服务器上已有 ZCode 共享登录凭据（`~/.zcode/v2/credentials.json`）；没有时用 agent CLI 执行一次 `login`。

## 2. 目录布局

```
/www/zcode-companion/
├── zcode-companion.cjs     # 栈入口（gateway + resident 守护 + 云端连接器）
├── zcode-server.cjs        # resident daemon bundle
├── serve-launcher.cjs      # PM2 启动器（环境集中注入；nodeToken 不进面板/进程列表）
├── build/Release/pty.node  # resident 的 pty 预编译（懒加载，缺失仅影响终端面）
├── prebuilds/linux-x64/pty.node
├── data/control.db         # 控制面 SQLite（设备/节点/配对码/凭证指纹）
├── data/node.token         # 节点令牌明文（0600；只在 register-node 时输出一次）
├── runtime/                # daemon.json / daemon.log
├── workspaces/acceptance/  # 云端工作区白名单目录
├── logs/serve.log
├── agents/glm/             # agent CLI runtime（zcode.cjs + packages/ + pty）
└── tools/{bfs,ripgrep,ugrep}  # agent 搜索工具（env 指定路径）
```

产物来源：本仓库 `packages/server` 下 `npm run build:remote` 产出两个 bundle；`agents/` 与 `tools/` 来自桌面端远端资源发布树（`packages/desktop/mock-cdn/releases/<版本>/` 的 `glm/linux-x64`、`tools/linux-x64`、`node-pty/linux-x64/pty.node`）。

## 3. 环境变量（serve-launcher.cjs 集中注入）

| 变量 | 作用 |
| --- | --- |
| `ZCODE_COMPANION_PORT` / `HOST` | gateway 监听（`127.0.0.1:18230`，公网由 nginx 反代） |
| `ZCODE_COMPANION_CONTROL_DB` | 控制面 SQLite 路径 |
| `ZCODE_COMPANION_NODE_TOKEN` | 节点令牌（`register-node` 产物；明文只存 0600 文件） |
| `ZCODE_COMPANION_ALLOWED_ORIGINS` | 浏览器 Origin 白名单（逗号分隔；`https://<服务器IP>`,Capacitor 壳 `https://localhost`） |
| `ZCODE_COMPANION_TRUST_FORWARDED_PROTO` | 反代后必须 `1`（refresh cookie 的 Secure 依据 X-Forwarded-Proto） |
| `ZCODE_COMPANION_WORKSPACES` | 云端工作区白名单，`路径=标题` 逗号分隔 |
| `ZCODE_RESIDENT_SCRIPT` | resident bundle 路径 |
| `ZCODE_SERVER_RUNTIME_ROOT` | daemon 运行根（daemon.json/log） |
| `ZCODE_AGENT_SERVER_COMMAND` / `ARGS_JSON` | agent CLI 启动命令（本部署：系统 node 跑 `agents/glm/zcode.cjs app-server --stdio`） |
| `ZCODE_BFS_BINARY` / `ZCODE_RG_BINARY` / `ZCODE_UGREP_BINARY` | agent 搜索工具路径 |

注意：环境值里不能出现第二个 `=`（面板 env 行按 `=` 切分），所以用 launcher 文件注入而不是面板 env 列表。

## 4. 初始化与托管

```sh
# 登记云端节点（nodeToken 明文只打印一次）
ZCODE_COMPANION_CONTROL_DB=/www/zcode-companion/data/control.db \
  node zcode-companion.cjs register-node --id cloud-main --name 本机云端

# nodeToken 存入 0600 文件（PM2 启动器读取）
echo '<nodeToken>' > /www/zcode-companion/data/node.token && chmod 600 /www/zcode-companion/data/node.token

# 铸一次性配对码（15 分钟有效，单次消费；与 serve 进程共享同一 DB，可随时执行）
ZCODE_COMPANION_CONTROL_DB=/www/zcode-companion/data/control.db \
  node zcode-companion.cjs pair-code

# 设备管理
node zcode-companion.cjs list-devices
node zcode-companion.cjs revoke-device --id dev-xxxx
node zcode-companion.cjs revoke-node --id cloud-main
```

宝塔「Node 项目」托管：类型 **pm2**，启动文件 `serve-launcher.cjs`，运行用户 **root**（agent 读取 `/root/.zcode` 凭据），开机自启。serve 断线自动退避重连（2s→30s）；PM2 只兜底进程崩溃。

## 5. nginx 反代（挂在已有 HTTPS 站点下）

`/www/server/panel/vhost/nginx/extension/<站点>/companion.conf`：

```nginx
location ^~ /companion/ {
    proxy_pass http://127.0.0.1:18230;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    # 限速来源键取 X-Real-IP（覆盖式）。XFF 用追加语义时第一跳客户端可伪造，
    # 会绕过 /companion/pair 限速——若改用 XFF 取源，网关侧必须取最后一跳。
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_buffering off;
}
```

`nginx -t && nginx -s reload` 后验证：`curl -s https://<服务器IP>/companion/health`。

防火墙只放行 443；gateway 的 18230 仅回环。

## 6. 客户端接入

- **手机**：App「配对码」输入 6 位一次性码（桌面弹窗生成，或服务器 CLI `pair-code`）。外网可用，不要求与服务器同网。
- **电脑（桌面连接器）**：先在服务器登记 desktop 节点并保存令牌（`node zcode-companion.cjs register-node --id desktop-main --name 家里电脑 --kind desktop`；`--kind` 缺省 cloud），桌面「Myzcode 桌面直连」高级设置填 `wss://<服务器IP>` + 令牌并保存启用；此后日常配对直接在弹窗点「生成配对码」（用已存令牌向网关索取，令牌无需再动）。

### 6.1 桌面测试构建（Preview 身份）

与已安装正式版并排运行的测试包必须以 Preview 身份构建：**`ZCODE_PREVIEW_IDENTITY=1` 在编译与打包两步都要设**——

```sh
cd packages/desktop
ZCODE_PREVIEW_IDENTITY=1 pnpm run build:no-runtime-assets   # tsup 把 flavor 编进 main bundle
ZCODE_PREVIEW_IDENTITY=1 pnpm exec electron-builder --config electron-builder.config.js --win --x64 --dir
```

只给 electron-builder 设是不够的：`__ZCODE_PRODUCT_FLAVOR__` 由 tsup 编译期注入（`tsup.config.ts`），漏设会烤成 production——`app.name="ZCode"`、userData 落到正式版目录，被正在运行的正式版持单实例锁后**打包态启动即静默退出**（无窗口、无错误日志、exit 0）。排查这类「打了包起不来」的问题时，先核对 `app.name` 与 `userData` 路径是否为 `ZCode Preview`。

### 6.2 反代保活（nginx）

节点控制通道与 relay 数据面都经 nginx 反代；空闲连接会被 `proxy_read_timeout`（默认 60s）静默摘除。网关与连接器已内置保活，无需 nginx 侧配置：

- 节点/手机控制面：应用层心跳（10s ping，30s watchdog 判半开并重连）。
- relay 数据面：网关对每条 relay ws 周期 10s 发协议层 ping，对端按 RFC 6455 自动回 pong。

若仍见 WS 频繁断开，确认站点配置未覆盖 `proxy_read_timeout` 为更小值，且 `proxy_http_version 1.1` + Upgrade 头齐全。

## 7. 安全边界（如实）

- 传输安全依赖站点 TLS；配对码 15 分钟单次有效，`/companion/pair` 有每来源限速（15 分钟 10 次）。
- 控制面只存秘密的 sha256 指纹；nodeToken / refreshToken 明文不可找回，丢失只能撤销重建。
- `data/control.db` 冷备即可（WAL 模式）；备份不含明文凭据。
- 手机当前为窄控制面（无终端、无凭据、无任意文件读取）；撤销设备立即断开在线连接。
- 证书自动续期由宝塔负责；续期失败手机会因证书不匹配拒连，注意检查到期时间。

## 8. 故障排查

| 症状 | 排查 |
| --- | --- |
| health 通但配对失败 | 配对码过期/已用（重新 `pair-code`）；设备数超 8 上限（`list-devices` 后撤销） |
| `gateway rejected node auth` | serve 环境里的 token 与 `register-node` 不一致；重启 serve 前确认 `data/node.token` |
| 手机「无法连接接入服务」 | 先开手机浏览器访问 `https://<IP>/companion/health`：不通是网络/证书，通则是 App 配置 |
| 会话列表失败「runtime is not running」 | 正常——订阅为 start-if-needed 会自动拉起 agent；持续失败看 `runtime/daemon.log` 的 spawn preflight |
| agent 启动失败 | `runtime/daemon.log`；确认 `ZCODE_AGENT_SERVER_COMMAND/ARGS_JSON` 与 `agents/glm/zcode.cjs` 存在可执行 |
| 手机 attach 报 `node_offline ... timed out` | 桌面 connector 掉线（半开连接）：新版本有心跳+自动重连，等待数秒重试即可；持续出现检查桌面端网络与网关 `logs/serve.log` |
| WS 频繁断开 | nginx 是否带 Upgrade 头与 24h read timeout；`logs/serve.log` 的断线重连日志 |
