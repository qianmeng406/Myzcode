// companion relay 引导（手机壳/浏览器）：不连同源 /ws，改为
// CompanionClient（已配对 accessToken）→ catalog → attach → relay accessor。
// 配置来源（优先级）：URL 参数（开发联调）→ localStorage → sessionStorage
// （轻量 App 配对后的 sessionStorage 键，同 WebView 同源可直接交接）。
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
  for (const storage of [window.localStorage, window.sessionStorage]) {
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
  if (gateway && token) {
    // 开发联调用 URL 直传；持久化让刷新不丢（token 本就存于本机存储）。
    const config = { baseUrl: gateway, accessToken: token };
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    return config;
  }
  return readStoredConfig();
}

function renderCompanionTree(tree: React.ReactNode): void {
  createRoot(document.getElementById("root")!).render(tree);
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
  let workspace: { path: string; identity?: string } | null = null;
  try {
    const client = new CompanionClient({
      baseUrl: config.baseUrl,
      accessToken: config.accessToken,
    });
    await client.connect();
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
      </ZCodeIntlProvider>
    </AppErrorBoundary>,
  );
}
