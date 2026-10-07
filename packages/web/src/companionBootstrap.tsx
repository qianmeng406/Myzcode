// companion relay 引导（手机壳/浏览器）：不连同源 /ws，改为
// CompanionClient（已配对 accessToken）→ catalog → attach → relay accessor。
// 配置来源（优先级）：URL 参数（开发联调，仅本次会话且读取后清 URL）→
// sessionStorage（轻量 App 配对后的会话键，同 WebView 同源可直接交接）→
// localStorage（历史遗留回退）。session 必须先于持久存储，否则历史联调
// 遗留的旧配置会遮蔽轻量页刚写入的新配置。
import { CompanionClient, type CompanionRelayChannel } from "@zcode/companion/client";
import type { CompanionCatalogResult } from "@zcode/shared/companion-protocol";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import { createRoot } from "react-dom/client";
import { createWebPlatform } from "./webPlatform.js";
import { renderCompanionTargetPicker } from "./companionTargetPicker.js";
import "./companionMobile.css";

const CONFIG_KEY = "zcode-companion-config";

/**
 * 移动端适配（官方语义：远控移动端 = 同一 WebUI + 窄视口适配）。
 * ≤767px 时打 compact-remote 标记（侧栏抽屉化等样式见 companionMobile.css），
 * 并注入抽屉开关：左上按钮（开→关切换，图标随状态变化）+ 纯视觉遮罩。
 * 关闭判定统一走 document 捕获阶段（点抽屉外任意处关闭、点抽屉内条目收起），
 * 不依赖遮罩自身的 z-index 命中，避免被 WebUI 更高层级容器拦截。
 */
function mountMobileCompat(): void {
  const apply = (): void => {
    document.documentElement.classList.toggle("compact-remote", window.matchMedia("(max-width: 767px)").matches);
  };
  apply();
  window.matchMedia("(max-width: 767px)").addEventListener("change", apply);

  const MENU_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>';
  // 收起态 ☰（展开侧栏）、展开态 ×（关闭侧栏）——展开时按钮移到抽屉右侧，× 语义更明确。
  const CLOSE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  const scrim = document.createElement("div");
  scrim.id = "companion-scrim";
  const nav = document.createElement("button");
  nav.id = "companion-nav-btn";
  nav.type = "button";
  document.body.append(scrim, nav);

  const sidebar = (): HTMLElement | null => document.getElementById("sidebar");
  const isOpen = (): boolean => sidebar()?.classList.contains("companion-open") === true;
  const setDrawer = (open: boolean): void => {
    sidebar()?.classList.toggle("companion-open", open);
    scrim.classList.toggle("visible", open);
    // 打开时按钮即「关闭」控件（图标 ←，提示可收起）。
    nav.innerHTML = open ? CLOSE_ICON : MENU_ICON;
    nav.setAttribute("aria-label", open ? "收起侧栏" : "展开侧栏");
    nav.setAttribute("aria-expanded", open ? "true" : "false");
  };
  setDrawer(false);

  nav.addEventListener("click", () => setDrawer(!isOpen()));
  // 指针按下即判定（capture 阶段最早）：点抽屉外任意处关闭；点抽屉内条目
  // 延迟收起以让 WebUI 先处理导航。
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!isOpen()) return;
      const target = event.target as HTMLElement | null;
      if (target === null) return;
      if (target.closest("#sidebar") === null && target.closest("#companion-nav-btn") === null) {
        setDrawer(false);
      }
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      if (!isOpen()) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && target.closest("#sidebar") !== null) {
        window.setTimeout(() => setDrawer(false), 350);
      }
    },
    true,
  );
}

interface CompanionWebConfig {
  baseUrl: string;
  accessToken: string;
}

function readStoredConfig(): CompanionWebConfig | null {
  for (const storage of [window.sessionStorage, window.localStorage]) {
    const raw = storage.getItem(CONFIG_KEY);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<CompanionWebConfig>;
      if (typeof parsed.baseUrl === "string" && typeof parsed.accessToken === "string") {
        return { baseUrl: parsed.baseUrl, accessToken: parsed.accessToken };
      }
    } catch {
      // 坏数据按未配置处理。
    }
  }
  return null;
}

function resolveCompanionConfig(): CompanionWebConfig | null {
  const params = new URLSearchParams(window.location.search);
  const gateway = params.get("companionGateway");
  const token = params.get("companionToken");
  // 发布面禁用 URL 直传 token：URL 会进浏览器历史/同步/服务器日志，成为可
  // 重放的注入面。开发联调必须显式携带 ?companionDebug=1 才启用该入口；
  // 正常路径是轻量 App 配对后经 sessionStorage 同源交接。
  if (gateway && token && params.has("companionDebug")) {
    // 开发联调用 URL 直传：只写 sessionStorage（会话级）且立刻从地址栏清除
    // 参数——带 token 的 URL 进浏览器历史/同步会变成可长期重放的注入面，
    // 持久化进 localStorage 还会让后续访问被固定到该网关（网关注入）。
    const config = { baseUrl: gateway, accessToken: token };
    window.sessionStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    params.delete("companionGateway");
    params.delete("companionToken");
    const query = params.toString();
    const cleaned = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", cleaned);
    return config;
  }
  return readStoredConfig();
}

let companionRoot: ReturnType<typeof createRoot> | null = null;

function renderCompanionTree(tree: React.ReactNode): void {
  // 同一容器二次 createRoot 会泄漏旧树（effect/监听不清、React 报错）；
  // 状态屏与完整 UI 都复用同一个 root，render 前旧树会被正确卸载。
  if (!companionRoot) {
    companionRoot = createRoot(document.getElementById("root")!);
  }
  companionRoot.render(tree);
}

function isChineseLocale(): boolean {
  return /^zh\b/i.test(navigator.language);
}

function renderCompanionStatus(title: string, message: string, onRetry?: () => void): void {
  renderCompanionTree(
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <h1 className="text-ui-xs font-medium">{title}</h1>
          <p className="mt-2 break-all text-ui-xs/relaxed text-foreground-subtle">{message}</p>
          <button
            type="button"
            className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover"
            onClick={() => {
              if (onRetry) onRetry();
              else window.location.reload();
            }}
          >
            {isChineseLocale() ? "重试" : "Retry"}
          </button>
        </section>
      </div>
    </div>,
  );
}

export function isCompanionBootstrapRequested(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get("companion") === "1") return true;
  // 轻量 App 已配对（同源存储有配置）即进入 companion 引导；
  // ?standard=1 显式走普通 Web 引导（本机 dev server 模式）。
  return readStoredConfig() !== null && params.get("standard") !== "1";
}

interface BootErrorEntry {
  message: string;
  stack: string;
}

/** ?companionDebug=1：把启动期未捕获错误渲染成浮层（bring-up 诊断用）。 */
function mountCompanionDebugOverlay(): void {
  const errors: BootErrorEntry[] = [];
  const record = (message: string, stack: string): void => {
    errors.push({ message, stack: stack.slice(0, 4000) });
  };
  window.addEventListener("error", (event) => {
    record(String(event.message), event.error instanceof Error ? String(event.error.stack) : "");
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    record(`unhandledRejection: ${reason.message}`, String(reason.stack));
  });
  const overlayId = "__companion-debug-overlay";
  const paint = (): void => {
    const old = document.getElementById(overlayId);
    if (old) old.remove();
    const pre = document.createElement("pre");
    pre.id = overlayId;
    pre.style.cssText =
      "position:fixed;inset:auto 0 0 0;z-index:2147483647;max-height:45vh;overflow:auto;margin:0;background:#101010;color:#4ade80;font-size:11px;line-height:1.35;white-space:pre-wrap;border-top:2px solid #4ade80;";
    pre.textContent =
      errors.length > 0
        ? errors.map((e) => `${e.message}\n--- stack ---\n${e.stack}`).join("\n=====\n")
        : "(no boot errors captured)";
    document.body.appendChild(pre);
  };
  window.setInterval(paint, 1500);
}

/**
 * 建控制面连接；鉴权被拒（access 过期）时经 HttpOnly refresh Cookie 静默换新
 * 并重试一次。刷新成功回写 sessionStorage，轻量页与本次会话共用新 token。
 */
async function connectCompanionControl(
  config: CompanionWebConfig,
): Promise<{ client: CompanionClient; config: CompanionWebConfig }> {
  const build = (token: string): CompanionClient =>
    new CompanionClient({ baseUrl: config.baseUrl, accessToken: token });
  let client = build(config.accessToken);
  try {
    await client.connect();
    return { client, config };
  } catch (error) {
    if (!CompanionClient.isAuthRejectedError(error)) throw error;
    const refreshed = await CompanionClient.refresh({ baseUrl: config.baseUrl });
    const next: CompanionWebConfig = { baseUrl: config.baseUrl, accessToken: refreshed.accessToken };
    window.sessionStorage.setItem(CONFIG_KEY, JSON.stringify(next));
    client.close();
    client = build(refreshed.accessToken);
    await client.connect();
    return { client, config: next };
  }
}

/**
 * companion relay 引导：attach catalog 首个可用工作区，以 relay accessor
 * 启动完整 Root。目标工作区解析：记住的上次选择 > 唯一候选 > 选择屏
 * （不再静默取第一项）。attach/连接失败显示可重试状态屏（不做静默循环
 * 重连），重试保持原目标重新 attach。
 */
const TARGET_KEY = "zcode-companion-target";

interface BootTarget {
  nodeId: string;
  workspacePath: string;
  workspaceIdentity: string;
}

function loadStoredTarget(): BootTarget | null {
  try {
    const raw = window.sessionStorage.getItem(TARGET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BootTarget>;
    if (
      typeof parsed.nodeId === "string" &&
      typeof parsed.workspacePath === "string" &&
      typeof parsed.workspaceIdentity === "string"
    ) {
      return { nodeId: parsed.nodeId, workspacePath: parsed.workspacePath, workspaceIdentity: parsed.workspaceIdentity };
    }
  } catch {
    // 坏数据按未记录处理。
  }
  return null;
}

/** 目录中解析目标：记住的选择（仍在线可用）> 唯一候选 > null（弹选择屏）。 */
function resolveBootTarget(catalog: CompanionCatalogResult): BootTarget | null {
  const candidates: Array<{ nodeId: string; entry: (typeof catalog.nodes)[number]["workspaces"][number] }> = [];
  for (const node of catalog.nodes) {
    if (!node.online) continue;
    for (const entry of node.workspaces) {
      if (entry.available) candidates.push({ nodeId: node.nodeId, entry });
    }
  }
  const stored = loadStoredTarget();
  const remembered = stored
    ? candidates.find((candidate) => candidate.nodeId === stored.nodeId && candidate.entry.workspaceIdentity === stored.workspaceIdentity)
    : undefined;
  if (remembered) {
    return {
      nodeId: remembered.nodeId,
      workspacePath: remembered.entry.workspacePath,
      workspaceIdentity: remembered.entry.workspaceIdentity,
    };
  }
  if (candidates.length === 1) {
    return {
      nodeId: candidates[0]!.nodeId,
      workspacePath: candidates[0]!.entry.workspacePath,
      workspaceIdentity: candidates[0]!.entry.workspaceIdentity,
    };
  }
  return null;
}

export async function bootstrapCompanionApp(): Promise<void> {
  if (new URLSearchParams(window.location.search).has("companionDebug")) {
    mountCompanionDebugOverlay();
  }
  mountMobileCompat();
  const config = resolveCompanionConfig();
  if (!config) {
    renderCompanionStatus(
      isChineseLocale() ? "未配置接入服务" : "Companion not configured",
      isChineseLocale()
        ? "请先在 My zcode 轻量页完成配对，或在 URL 上携带 companionGateway/companionToken 参数。"
        : "Pair in the My zcode light page first, or pass companionGateway/companionToken URL params.",
    );
    return;
  }
  await runCompanionBoot(config);
}

async function runCompanionBoot(config: CompanionWebConfig): Promise<void> {
  let client: CompanionClient | null = null;
  try {
    const connected = await connectCompanionControl(config);
    client = connected.client;
    const catalog = await client.catalog();
    const target = resolveBootTarget(catalog);
    if (target === null) {
      // 多候选：先选目标再进入（选择即记住，重试/重进不再询问）。
      renderCompanionTargetPicker(catalog, (picked) => {
        window.sessionStorage.setItem(
          TARGET_KEY,
          JSON.stringify({ nodeId: picked.nodeId, workspacePath: picked.workspacePath, workspaceIdentity: picked.workspaceIdentity }),
        );
        void attachAndRender(client!, config, picked);
      }, renderCompanionTree);
      return;
    }
    await attachAndRender(client, config, target);
  } catch (error) {
    // 引导失败关闭控制面连接；状态屏重试整段重跑（保持记住的目标）。
    client?.close();
    renderCompanionStatus(
      isChineseLocale() ? "接入服务连接失败" : "Companion connection failed",
      error instanceof Error ? error.message : String(error),
      () => void runCompanionBoot(config),
    );
  }
}

async function attachAndRender(
  client: CompanionClient,
  config: CompanionWebConfig,
  target: BootTarget,
): Promise<void> {
  let relay: CompanionRelayChannel | null = null;
  let workspace: { path: string; identity?: string };
  try {
    const attach = await client.attach({
      nodeId: target.nodeId,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
    });
    relay = await client.openRelayChannel(attach);
    workspace = {
      path: target.workspacePath,
      // 云端工作区 identity === path：省略 identity，避免被侧栏按
      // “remoteSessionId 缺失的远程工作区”误判成断连（本地流走 path 语义）。
      identity:
        target.workspaceIdentity && target.workspaceIdentity !== target.workspacePath
          ? target.workspaceIdentity
          : undefined,
    };
    // relay 断开（网关重启/网络问题/attachment 拆除）→ 明确提示而非静默挂死；
    // 重试整段重跑（新 attach + 全新订阅），目标保持用户上次选择。
    relay.onClosed(() => {
      renderCompanionStatus(
        isChineseLocale() ? "与接入服务的连接已断开" : "Companion connection lost",
        isChineseLocale()
          ? "工作区任务不受影响仍在执行；点击重试将重新 attach 并恢复界面。"
          : "Workspace tasks keep running on the host. Retry to re-attach and restore the UI.",
        () => void runCompanionBoot(config),
      );
    });
  } catch (error) {
    renderCompanionStatus(
      isChineseLocale() ? "接入服务连接失败" : "Companion connection failed",
      error instanceof Error ? error.message : String(error),
      () => void runCompanionBoot(config),
    );
    return;
  }

  // RemoteServiceAccess 本身实现 IServiceAccessor，直接可用。
  const services = relay.accessor;
  const platform = createWebPlatform();
  document.title = "ZCode - My zcode";

  renderCompanionTree(
    <AppErrorBoundary>
      <ZCodeIntlProvider
        settingService={services.settingService}
        broadcastService={services.broadcastService}
      >
        <Root
          services={services}
          platform={platform}
          initialWorkspaceAbsPath={workspace.path}
          initialWorkspaceIdentity={workspace.identity}
          allowOpenWorkspace={false}
          preferDirectoryBrowser
          supportsEmbeddedBrowser={false}
          allowRemoteWorkspace={false}
        />
      </ZCodeIntlProvider>
    </AppErrorBoundary>,
  );
}
