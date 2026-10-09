# Myzcode

> **本仓库是基于官方 ZCode 开源项目二次开发的定制分支（fork），不是官方发行版。**
>
> 本项目与智谱 Z.ai / ZCode 官方团队**没有隶属、合作、授权或背书关系**，仓库中出现的 "ZCode" 名称与图标仅用于说明继承自上游的代码来源。使用前请务必阅读文末的[二次开发声明](#二次开发声明)与[免责声明](#免责声明)。

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode" width="128" height="128" />
</div>

Myzcode 在官方 ZCode 的基础上做面向个人使用的二次开发，主要方向是**「让手机也能远程操控电脑上运行的 ZCode」**，并额外扩展了模型渠道、模型审查与若干交互能力。

| 项目 | 说明 |
| --- | --- |
| 上游项目 | [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0） |
| 本仓库 | [qianmeng406/Myzcode](https://github.com/qianmeng406/Myzcode) |
| 定制主线分支 | `custom/command-code-channel`（全部定制内容与修复所在分支） |
| 桌面端 | 基于官方 ZCode 桌面版二次构建（Preview 构建身份，产物名 `ZCode Preview`） |
| 移动端 | 「Myzcode」Android App，包名 `com.zcode.myzcode`，版本 `0.1.0` |
| 许可证 | Apache-2.0（继承上游，见 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md)） |

## 本定制版的新增与改动

以下内容均为本仓库相对上游 `origin/main` 的**新增**改动（已逐项与上游代码比对确认）。

### 一、手机远控（Companion）——本定制版的主要改动

让手机以**同一套 WebUI**（窄视口适配）附着到电脑上**已经打开并显式共享**的工作区，实时镜像任务、会话与执行结果；不在手机侧新开第二个执行者。

- **自托管接入与转发服务**：新增 `packages/companion`，含设备配对、节点登记、授权（grants）、attachment 注册与一次性 capability、控制面/数据面分离的 gateway（Hono + ws），数据面为字节透传，gateway 不解释、不缓存、不重排。
- **节点连接器**：新增 `packages/server/src/companion`，桌面端由 Electron Main 出站连接并附着本机已打开工作区；云端由 resident 守护进程出站连接。手机附着到**既有**运行时，不隐式启动新运行时。
- **频道收窄裁决**：`narrowingFacade` + `channelPolicy` 对手机暴露收窄后的 `IZCodeAgentService` 频道（T0 全拒 / T1 只读 / T2 受限），跨工作区只读任务列表与事件订阅按「已共享工作区集合」逐项放行，其余一律强制绑定或拒绝，fail-closed。
- **手机端只读任务索引**：跨共享工作区的任务摘要聚合；sessions-index 不可用时回退磁盘 tasks-index，gateway 只做临时聚合，不持有任务权威。
- **配对与设备授权**：6 位数字配对码 + 二维码/链接、一次性 capability、设备授权查看/收缩/撤销，凭证以哈希存储。
- **连接恢复**：心跳 + watchdog、指数退避重连、`ConnectionSession` 代次恢复、命令 ACK 丢失先对账（不盲目重发创建/输入/审批）。
- **移动端 App**：新增 `packages/mobile`（Capacitor Android），应用名 Myzcode，复用同一套 Web UI 资源，而非另写一套手机界面。
- **自托管部署文档**：见 [packages/companion/specs/companion-gateway.md](packages/companion/specs/companion-gateway.md) 与 [packages/companion/specs/DEPLOY.md](packages/companion/specs/DEPLOY.md)。

### 二、其余新增功能

- **自定义模型渠道（Command Code）**：内置渠道，模型由用户自行管理而非预置。渠道地址为上游官方地址（`https://api.commandcode.ai/provider/v1`），按 key 的额度也由**客户端直连上游**读取（`/alpha/billing/*`），**不经任何自建服务器**。
- **双模型审查（Oracle）**：回合结束后自动复审本轮 diff，也支持手动重审；含深度审查（派发只读子代理多轮取证）、审查进度展示、一键修复与审查结果持久化。
- **计划批准时选择执行模型与推理等级**：退出计划模式时可直接指定后续执行所用的模型与推理档位。
- **会话回合导航**：按回合在长会话中快速跳转，配套设置开关与全量历史加载协调。
- **权限/协作模式扩展**：新增 **资料查询（research）只读模式**（内置多个免密钥检索渠道）、`minimal`、`zcodeUpdate` 等模式。
- **提示词优化器**：输入区新增提示词优化入口，可指定优化所用模型。
- **远端资源自建发布管线与 SSH 常驻工作区**：可自建远端资源发布树（`packages/server/build-remote.ts` 等），并支持 SSH 远程工作区**断开不终止任务、重连接回同一运行时**。

### 三、与官方版的差异边界（明确不做的事）

- **不接入官方私有 relay**，不复用官方账号后端；远控链路完全自托管。
- **不复制官方压缩代码**，不声称与官方通信协议兼容、不声称获得官方认证。
- **执行权威唯一**：任务执行始终发生在原 Host/运行时，手机与 gateway 都不创建第二个执行者。
- 手机首版**不可**进行凭据管理、任意文件系统访问、终端、服务端配置等特权操作。

## 分支说明

- `custom/command-code-channel`：**定制主线分支**，包含上述全部定制内容与后续修复。
- `main`：保留了早期「项目开发模式（workflow）」相关提交作为历史线；该模式已在定制主线的后续提交中移除，不再属于当前定制版功能。

## 上游 ZCode 使用说明

以下初始化、开发、构建命令继承自上游 ZCode，命令本身未作改动；本定制版的新增能力（手机远控、自定义渠道等）按上文各章节的说明使用。

### 初始化

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。以下开发和打包命令均在仓库根目录执行。

```bash
pnpm bootstrap
```

`pnpm bootstrap` 安装 workspace 依赖、准备桌面本地运行资源，再执行 `build:bootstrap`。

Agent CLI 与运行时源码位于 [apps/zcode-cli/](apps/zcode-cli/)，作为普通目录随本仓库一起克隆，无需单独拉取或初始化 Git submodule。

根据需要选择其他初始化或构建入口：

| 命令                           | 用途                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `pnpm install`                 | 安装依赖                                                          |
| `pnpm prepare:desktop-runtime` | 准备桌面运行资源，默认包含远程资源准备                            |
| `pnpm prepare:remote-assets`   | 单独准备远程运行资源                                              |
| `pnpm bootstrap:with-remote`   | 初始化依赖、本地与远程资源，并串行构建相关包；跳过桌面应用 bundle |
| `pnpm build`                   | 递归执行各 workspace 包的构建脚本，包括包内的资源准备步骤         |

默认 `bootstrap` 跳过远程资源准备，适合本地桌面开发。使用远程工作区或验证远程发行资源时，再运行对应准备命令。

### 开发与运行

#### 桌面版

```bash
pnpm dev:desktop

# 使用测试环境
pnpm dev:desktop:test
```

`pnpm dev:desktop` 默认等同于 `pnpm dev:desktop:prod`，使用生产服务配置。启动脚本会准备本地运行资源、构建桌面 Agent，再启动 Electron 和源码监听。

需要独立开发数据目录时，可设置 `ZCODE_DATA_BASE_DIR`。例如在 macOS / Linux 中：

```bash
ZCODE_DATA_BASE_DIR="$HOME/.zcode-dev-home" pnpm dev:desktop:test
```

#### 移动端（Android，本定制版新增）

```bash
# 构建 Web UI → 同步到 Android 工程 → 产出 debug APK
pnpm --filter @zcode/mobile run apk:debug
```

需要 JDK 21 与 Android SDK；`JAVA_HOME` 指向 JDK 21（Android Studio 自带 JBR 即可）。产物位于 `packages/mobile/android/app/build/outputs/apk/debug/`。

配对页预填的网关地址取自构建期环境变量 `VITE_COMPANION_GATEWAY_URL`：仓库内**不内置任何具体地址**，自部署者在未跟踪的 `packages/mobile/.env.local` 中填写自己的网关；未配置时预填为空，需在配对页手动填写。

#### 远程功能（SSH/WSL）

先执行 `pnpm bootstrap:with-remote` 准备远程资源（mock-cdn），再 `pnpm dev:desktop`；连接远程项目时资源选择「本地下载后上传」。开发态资源取自本地 `packages/desktop/mock-cdn` 和本地构建产物，经 SFTP 上传到远程，不访问 CDN。

#### Web 开发

修改 Web 或后端源码时，使用开发模式：

```bash
pnpm dev:web

# 指定后端工作区（macOS / Linux）
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

该命令同时启动 Web 开发服务器（默认 `http://localhost:5173`）和后端（默认 `http://localhost:3030`）；浏览器访问前者。`/ws` 和一般 `/api` 请求代理到本地后端，`/api/v1/oauth/token` 单独代理到当前配置的产品服务。

Agent 源码修改后，执行 `pnpm --filter @zcode/cli... build` 并重启服务。需要验证完整发行包时，按下方“ZCode 命令行版”打包章节解压运行。

#### ZCode 命令行版

命令行发行包包含 TUI、Web 和 Agent，统一使用 `zcode` 启动：无参数进入 TUI；第一个参数为 `--web` 时启动 Web；其他参数交给现有 Agent CLI 处理。两种模式都在本机运行，无需 Electron。

```bash
# 默认进入终端交互界面
zcode

# 启动 Web 界面
zcode --web

# 指定项目和端口，不自动打开浏览器
zcode --web --workspace /path/to/project --port 3030 --no-open

# 查看 CLI 或 Web 参数
zcode --help
zcode --web --help
```

Web 模式默认工作目录为当前目录，监听 `127.0.0.1`，默认不启用访问令牌，自动选择空闲端口并打开浏览器。访问终端输出的地址，按 `Ctrl+C` 停止服务。局域网访问可使用 `--host 0.0.0.0`；监听非本机地址时默认生成访问令牌，使用终端输出的带令牌链接。可通过 `--token` 指定令牌或 `--no-token` 关闭令牌认证。

直接启动通用 Web 服务的 HTTP 入口时，通过 `ZCODE_SERVER_AUTH_TOKEN` 配置 API／WebSocket 认证；通过程序接口创建服务时，使用 `authToken` 选项。

构建方式见下方打包章节。`pnpm build:zcode` 只生成发行包，不会替换 `PATH` 中已有的 `zcode`。如果命令仍指向旧安装或其他源码目录，macOS / Linux 可用 `command -v zcode` 检查，Windows 可用 `where.exe zcode` 检查。

#### CLI 源码开发

直接开发 TUI 或 Agent 时，运行源码入口：

```bash
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli dev

# 构建 CLI 及其 workspace 依赖
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

这个入口直接运行 Agent CLI，不经过发行包的 `--web` 分流。开发 Web 用 `pnpm dev:web`；验证统一的 `zcode` 命令，用下方解压后的 `bin/zcode.mjs`。

### 配置

根目录 [.env.example](.env.example) 提供服务地址与构建配置示例，可按需复制到 `.env`，本地覆盖放入 `.env.local`。Desktop 的开发环境通过 `dev:desktop:test` / `dev:desktop:prod` 选择。

| 配置                                 | 用途                                             |
| ------------------------------------ | ------------------------------------------------ |
| `ZCODE_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.zcode/`         |
| `ZCODE_SERVER_WORKSPACE`             | Web 后端的工作区路径                             |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径；未设置时使用内置配置 |
| `ZCODE_DIST_BASE_URL`                | 命令行安装脚本使用的下载根地址                   |

运行时变量可在启动命令的环境中显式设置。随客户端发布的默认配置见 [config/README.md](config/README.md)。

> 注意：请勿把任何令牌、密钥或个人凭据提交到仓库；本定制版的远控部署涉及自建服务器凭据，请只放在本地未跟踪文件中。

### 打包

第三方声明生成、发行校验流程及声明在发行物中的位置见 [third-party/README.md](third-party/README.md)。

#### 桌面版

```bash
pnpm bundle:desktop

# 指定目标平台与 CPU 架构
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

默认目标为 macOS arm64，默认输出目录为 `packages/desktop/dist/`。`--os` 支持 `mac`、`win`、`linux`，`--arch` 支持 `x64`、`arm64`；实际打包与签名需要目标平台对应的工具和配置。

安装：双击打开产物 DMG，将 ZCode 拖入"应用程序"。本地构建未签名，首次打开若被 macOS 拦截，执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/ZCode.app
```

#### ZCode 命令行版

构建入口为 `pnpm build:zcode`。脚本会依次构建 CLI/TUI、后端和 Web，收集 TUI 的原生库、worker 与运行时依赖，再组装发行包；运行发行包仍需要 Node.js，版本以 `mise.toml` 为准。

打包前必须设置下载根地址 `ZCODE_DIST_BASE_URL`（可放在 `.env`、`.env.local` 或环境变量中），也可以通过 `--base-url` 传入。以下地址是占位示例，发布时替换为实际托管地址：

```bash
pnpm build:zcode --base-url https://downloads.example.com/zcode/

# 已配置 ZCODE_DIST_BASE_URL 时
pnpm build:zcode

# 仅重新组包，复用已有的 Agent、后端和 Web 构建产物
pnpm build:zcode --skip-build

# 查看版本、输出目录等可选参数
pnpm build:zcode --help
```

默认版本取根目录 `package.json`，输出目录为 `dist/zcode/`：

- `releases/<version>/zcode-<version>.tar.gz`：运行包。
- `releases/<version>/sha256.txt`：校验摘要。
- `latest.json`、`install.sh`：版本索引和安装脚本。

完整目录可上传到配置的下载根地址。安装脚本从该地址下载运行包，默认安装到 `~/.zcode/runtime`，并在 `~/.local/bin` 创建 `zcode` 命令。安装目录可通过 `ZCODE_DIST_HOME` 修改，命令目录可通过 `ZCODE_DIST_BIN_DIR` 修改。

旧 Lite 用户需要改用上述构建命令、环境变量和新的安装脚本。新安装不会删除旧 Lite 目录，也不会迁移或删除已有会话数据。

本地调试打包产物时，可直接解压运行，无需上传或安装：

```bash
zcode_version=$(node -p "require('./dist/zcode/latest.json').version")
mkdir -p dist/zcode/debug
tar -xzf "dist/zcode/releases/$zcode_version/zcode-$zcode_version.tar.gz" \
  -C dist/zcode/debug
# 默认启动 TUI
node dist/zcode/debug/zcode/bin/zcode.mjs

# 启动 Web
node dist/zcode/debug/zcode/bin/zcode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

浏览器打开 `http://127.0.0.1:3030`，即可验证同一后端服务托管 Web 页面和 Agent 的完整链路。该端口需要空闲；如正在运行 `pnpm dev:web`，可改用其他 `--port`。

## 仓库结构

上游结构如下，`本定制版新增` 列出的目录为本仓库新增。

| 目录                                                 | 职责                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| `packages/companion`                                 | **本定制版新增**：手机远控的 gateway、协议、配对与授权 |
| `packages/mobile`                                    | **本定制版新增**：Myzcode Android App（Capacitor） |
| `packages/desktop`                                   | Electron Main、Host、Renderer 与桌面打包   |
| `packages/web`                                       | Web 客户端                                 |
| `packages/server`                                    | HTTP / WebSocket 服务与远程连接（含 `src/companion` 节点连接器） |
| `packages/zcode-server-cli`                          | 独立 Server 启动与进程管理                 |
| `packages/ui`                                        | 共享 React 组件、hooks 与 Zustand 状态     |
| `packages/services`                                  | 业务服务与持久化                           |
| `packages/shared`、`packages/rpc`、`packages/client` | 共享协议和类型、RPC 框架、Agent 客户端 SDK |
| `packages/provider`、`packages/provider-node`        | Provider 公共能力与 Node 实现              |
| `apps/zcode-cli`                                     | Agent CLI、TUI、运行时与工具               |
| `scripts`、`config`、`third-party`                   | 构建维护脚本、内置配置与第三方声明材料     |

## 二次开发声明

1. **来源**：本项目是基于 [zai-org/ZCode](https://github.com/zai-org/ZCode) 开源代码的**二次开发（fork）**，遵循上游 Apache-2.0 许可证。上游原始代码、文档与资源的著作权归其原作者与 zai-org/ZCode 项目所有。
2. **非官方**：本项目由个人维护，**不是**官方产品，与 Z.ai、智谱、ZCode 官方团队**无任何隶属、赞助、合作或背书关系**。本项目产出的安装包、APK、bundle 均非官方发行物。
3. **改动范围**：本仓库在上游基础上新增了手机远控（Companion）、移动端 App、自定义模型渠道、双模型审查等功能，并修改了部分既有模块。改动清单见上文「本定制版的新增与改动」。
4. **协议与兼容**：本项目**不复制**官方压缩/混淆代码，**不接入**官方私有中继（relay）或账号后端，也**不声称**与官方协议兼容或通过官方认证。请勿将本项目描述为官方发行版或官方合作产品。
5. **名称与标识**：仓库中出现的 "ZCode" 名称、图标等仅用于说明代码来源与用途，不代表官方授权。

## 免责声明

1. **无担保**：本项目按「现状」（AS IS）提供，不附带任何明示或默示担保，包括但不限于适销性、特定用途适用性与不侵权担保。作者不对因使用或无法使用本项目而产生的任何直接或间接损失（含数据丢失、服务中断、设备损坏、收益损失）承担责任。
2. **自担风险**：本定制版包含**远程控制**能力，可让手机端对电脑上运行的 ZCode 发起有副作用的操作（创建任务、发送输入、停止执行、处理审批等）。使用前你应自行评估风险，务必只在**你自己的设备**与**你拥有合法授权**的环境上启用，并妥善保管配对码、令牌与服务器凭据。因误用、配置不当或凭据泄露造成的后果由使用者自行承担。
3. **不上传、不采集**：本项目不提供任何官方后端服务，作者不会收集你的数据。远控链路需你**自行搭建**服务器与网络环境，该环境中产生的日志、数据与流量由你自行管理并承担合规责任。
4. **合法使用**：使用者须自行确保其使用行为符合所在地区的法律法规、上游项目条款及第三方服务（模型供应商、云服务商等）的使用协议。**严禁**将本项目用于未经授权的入侵、监控、数据窃取或其他违法用途。
5. **模型与费用**：本项目可能调用第三方模型服务，相关账号、额度、费用与内容合规由使用者自行负责；本仓库不预置任何官方密钥或额度。
6. **与上游的关系**：本项目可能滞后于上游、包含上游尚未合并或已被移除的改动，也可能存在缺陷。请勿因本项目的问题向上游项目或官方团队追责。
7. **无维护承诺**：作者不承诺持续维护、及时修复或长期兼容任何上游版本。

> 若你不同意上述任一条款，请立即停止使用并删除本项目全部副本。

## 项目声明

功能与优惠范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)（继承自上游）。
