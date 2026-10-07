// companion relay 引导（手机壳/浏览器）：不连同源 /ws，改为
// CompanionClient（已配对 accessToken）→ catalog → attach → relay accessor。
// 配置来源（优先级）：URL 参数（开发联调，仅本次会话且读取后清 URL）→
// sessionStorage（轻量 App 配对后的会话键，同 WebView 同源可直接交接）→
// localStorage（历史遗留回退）。session 必须先于持久存储，否则历史联调
// 遗留的旧配置会遮蔽轻量页刚写入的新配置。
import { CompanionClient, type CompanionRelayChannel } from "@zcode/companion/client";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import { createRoot } from "react-dom/client";
import { createWebPlatform } from "./webPlatform.js";

const CONFIG_KEY = "zcode-companion-config";

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

function renderCompanionStatus(title: string, message: string): void {
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
              window.location.reload();
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
 * 启动完整 Root。attach/连接失败显示可重试状态屏（不做静默循环重连）。
 */
export async function bootstrapCompanionApp(): Promise<void> {
  if (new URLSearchParams(window.location.search).has("companionDebug")) {
    mountCompanionDebugOverlay();
  }
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

  let relay: CompanionRelayChannel | null = null;
  let bootClient: CompanionClient | null = null;
  let workspace: { path: string; identity?: string } | null = null;
  try {
    const { client } = await connectCompanionControl(config);
    bootClient = client;
    const catalog = await client.catalog();
    const node = catalog.nodes.find((entry) => entry.online && entry.workspaces[0]?.available);
    const workspaceEntry = node?.workspaces[0];
    if (!node || !workspaceEntry) {
      throw new Error(isChineseLocale() ? "目录中没有在线且可用的工作区" : "no online workspace in catalog");
    }
    workspace = {
      path: workspaceEntry.workspacePath,
      // 云端工作区 identity === path：省略 identity，避免被侧栏按
      // “remoteSessionId 缺失的远程工作区”误判成断连（本地流走 path 语义）。
      identity:
        workspaceEntry.workspaceIdentity &&
        workspaceEntry.workspaceIdentity !== workspaceEntry.workspacePath
          ? workspaceEntry.workspaceIdentity
          : undefined,
    };

    const attach = await client.attach({
      nodeId: node.nodeId,
      workspacePath: workspaceEntry.workspacePath,
      workspaceIdentity: workspaceEntry.workspaceIdentity,
    });
    relay = await client.openRelayChannel(attach);
    // relay 断开（网关重启/网络问题/attachment 拆除）→ 明确提示而非静默挂死。
    relay.onClosed(() => {
      renderCompanionStatus(
        isChineseLocale() ? "与接入服务的连接已断开" : "Companion connection lost",
        isChineseLocale()
          ? "工作区任务不受影响仍在执行；点击重试将重新 attach 并恢复界面。"
          : "Workspace tasks keep running on the host. Retry to re-attach and restore the UI.",
      );
    });
  } catch (error) {
    // 引导失败时关闭控制面连接（relay 若已建立会自行触发 onClosed 状态屏）。
    if (!relay) bootClient?.close();
    renderCompanionStatus(
      isChineseLocale() ? "接入服务连接失败" : "Companion connection failed",
      error instanceof Error ? error.message : String(error),
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
        {/* 手机壳内的退出浮钮：回轻量目录页（不拆 attachment，凭据仍在会话内）。 */}
        {new URLSearchParams(window.location.search).get("lightExit") !== "0" && (
          <button
            type="button"
            onClick={() => {
              window.localStorage.setItem("zcode-companion-prefer-light", "1");
              window.location.href = "../index.html";
            }}
            style={{
              position: "fixed",
              left: 10,
              bottom: "calc(env(safe-area-inset-bottom, 0px) + 10px)",
              zIndex: 2147483000,
              padding: "6px 12px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(20,20,24,0.72)",
              color: "#cfcfd8",
              fontSize: 12,
              backdropFilter: "blur(6px)",
              cursor: "pointer",
            }}
          >
            {isChineseLocale() ? "轻量界面" : "Light UI"}
          </button>
        )}
      </ZCodeIntlProvider>
    </AppErrorBoundary>,
  );
}
