# My zcode（@zcode/mobile）

手机控制端：通过自托管接入服务（`@zcode/companion` gateway）操控电脑上已打开
工作区的 ZCode 与云端常驻工作区的 Agent。首版能力边界见
`packages/companion/specs/companion-gateway.md`。

## 组成

- `src/`：手机 React 应用（Vite 构建，产物 `dist/`）。
- `android/`：Capacitor Android 壳（加载本地 `dist`，不依赖远程页面）。
- `capacitor.config.ts`：壳配置（appId `com.zcode.myzcode`）。

## 前置条件

- 接入服务已部署并可访问（自托管 gateway，见 `packages/companion`）。
- 电脑端：ZCode 桌面版的「移动端远程控制 → 配置桌面直连」完成节点登记
  （gateway URL + 节点令牌）并勾选要开放的工作区。
- 云端：服务器上运行 `entry-cloud-connector`（节点令牌经环境变量注入）。

## 手机端接入步骤

1. 在接入服务所在主机生成一次性配对码（gateway owner 面板）。
2. 打开 My zcode → 接入设置：填接入服务地址、设备名、配对码 → 「配对并连接」。
3. 配对成功后进入工作区目录；电脑/云端节点分组展示，仅显示对方显式开放的工作区。

## 日常使用

- 工作区 → 会话列表（实时）：点开既有会话继续，或「新任务」创建。
- 会话内：发送/停止/回答审批（工具权限、提问）；模式切换（构建/编辑/计划/自动）；
  草稿按工作区自动暂存。
- 待处理项带黄点提示；手机和电脑同时处理时先到先得，另一端显示已处理。

## 构建与安装

```bash
# 一键同步（构建 web 完整 UI + 轻量页 → cap copy → 拷 webui 进 assets）
pnpm sync:android
# 打 debug APK（需 JAVA_HOME 指向 JDK 21+，如 Android Studio 自带 JBR）
export JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
pnpm apk:debug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

发布链顺序约束：`cap copy` 会重建 assets/public，`copy-webui.mjs`（完整 UI →
`assets/public/webui/`）必须在其后执行——`sync:android` 已按此顺序串联，
不要单独手动跑 `cap copy` 后直接打包（会丢失完整 UI 资源）。

正式签名（release）需要签名密钥；未配置签名前的调试包即可完成配对与功能验收。

## 真机验收清单（阶段一 A6，待执行）

自动化（companion/desktop/mobile 单测 + companion-smoke）之外，以下场景必须在
真实 Electron 桌面包 + Android 真机 APK 上验收并留证（录屏/截图 + 脱敏日志）：

1. 配对：桌面弹窗取码（含共享范围绑定）→ 真机扫码/手输 → 目录只见授权工作区。
2. 导航：多工作区选择、完整 UI 选择屏记住目标、轻量/完整往返、Android 返回键。
3. 任务闭环：手机创建任务 → 桌面执行 → 手机连续流式渲染；跟进/停止/模式切换。
4. 交互：permission（含伴随反馈文本）、纯 freeText、AskUserQuestion 多题、
   计划批准/拒绝；双端同时处理只生效一次，迟到端显示已处理。
5. 文件：turnHeader 文件变更卡展开 unified diff；reverted 标注；无任何写入口。
6. 断线恢复：Wi-Fi↔移动网络切换、锁屏/后台恢复、force-stop 重启、网关重启、
   桌面暂离线——自动重连 → re-attach → 会话恢复原位；12h access 过期静默刷新。
7. 安全：撤销设备/收缩共享即时失效；未授权工作区不可见不可 attach；越权请求
   被拒（负向用例）；凭据不出现在 URL/日志/备份。
8. 体验：360–430px 布局、深浅主题、横竖屏、安全区、中文输入法、长文本/大 diff。

## 安全边界（如实说明）

- 浏览器端 access token 存 sessionStorage（会话级）；Android 壳当前同样使用
  WebView 会话存储，**尚未接入 Keystore 硬件级安全存储**——阶段 4 真机验收项。
- 长期 refresh token 走 HttpOnly Cookie（浏览器）；壳内 WebView 同源策略下由
  gateway 下发，不在 JS 层暴露。
- 后台推送未实现：App 退到后台/被系统终止后不保证收到提醒，重新进入后状态恢复。
- 二维码扫描未实现：首版用一次性配对码手动输入完成配对。

## 测试覆盖边界

自动化覆盖见 `packages/companion/specs/companion-gateway.md` §9.1；
手机 UI 层的端到端（createSession → 订阅 → 快照/增量渲染）与双端一致性
（共享会话、同时审批单次生效）归阶段 4 真机验收。
