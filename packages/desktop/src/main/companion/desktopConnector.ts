// 桌面 companion 连接器：出站连接 gateway，把手机的 attachment 桥接到
// 本机**已打开**工作区的既有 Host attachment（local: 窗口 Host；remote: 既有远程连接）。
// 不为手机新建 Agent / Host / 远程连接（AGENTS.md 手机远控边界）。
// workspace 绑定由共享窄化 facade 注入（local scope 消息只含 {kind:"local"}，
// 路径/身份绑定必须发生在连接器侧，防手机越权访问同 Host 其他工作区）。
import { ChannelClient, MessagePortProtocol, type IChannel } from "@zcode/rpc";
import { companionAttachRequestParamsSchema } from "@zcode/shared/companion-protocol";
import { randomUUID } from "node:crypto";
import {
  connectControlChannel,
  type ControlChannel,
} from "@zcode/server/companion-control";
import { readWorkspaceTaskSummary } from "@zcode/server/companion-task-index";
import {
  openCompanionRelayAttachment,
  type CompanionLogger,
  type RelayAttachmentUpstream,
} from "@zcode/server/companion-relay";

export interface OpenWorkspaceEntry {
  windowId: number;
  workspacePath: string;
  /** 远程工作区带既有 identity；本地 = 路径本身。 */
  workspaceIdentity: string;
  title: string;
  /** 带此字段 = 远程工作区（复用既有远程连接的 attachment）。 */
  remoteSessionId?: string;
}

/**
 * MessagePort 形状的端口（测试用普通对象即可）。
 * 注意：Electron 的 MessagePortMain 实为 Node EventEmitter（on/off），并不提供
 * DOM 风格的 addEventListener/removeEventListener——真实端口由
 * wrapCompanionPort 统一适配成 MessagePortLike 再交给 MessagePortProtocol。
 */
export interface CompanionPortLike {
  addEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  on?(type: "message", listener: (event: { data: unknown }) => void): unknown;
  off?(type: "message", listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: unknown, transfer?: unknown[]): void;
  start?(): void;
  close(): void;
}

export interface DesktopCompanionConnectorDeps {
  listOpenWorkspaces(): OpenWorkspaceEntry[];
  resolveAttachmentPort(entry: OpenWorkspaceEntry, attachmentId: string): CompanionPortLike;
  /**
   * 任务索引用的临时列表端口（specs §11.4）：与 attachment 端口同机制但
   * 短生命周期——读取器取到快照即 close，Host 侧 scope 随之释放。
   */
  resolveListPort(entry: OpenWorkspaceEntry, listId: string): CompanionPortLike;
  log: CompanionLogger;
}

export interface DesktopCompanionConnectorOptions {
  gatewayUrl: string;
  nodeToken: string;
  /** 显式开放的工作区身份白名单（用户在桌面 UI 勾选）。 */
  allowedWorkspaces: string[];
  deps: DesktopCompanionConnectorDeps;
  onDisconnected?: (reason: string) => void;
}

export interface DesktopCompanionConnectorHandle {
  setAllowedWorkspaces(workspaces: string[]): Promise<void>;
  handleWindowClosed(windowId: number): void;
  stop(): Promise<void>;
  isConnected(): boolean;
}

interface AttachmentRecord {
  entry: OpenWorkspaceEntry;
  teardown: () => Promise<void>;
}

function localWorkspaceIdentity(workspacePath: string): string {
  return workspacePath.trim();
}

export async function startDesktopCompanionConnector(
  options: DesktopCompanionConnectorOptions,
): Promise<DesktopCompanionConnectorHandle> {
  const log = options.deps.log;
  const gatewayUrl = options.gatewayUrl.replace(/\/+$/, "");
  let allowedWorkspaces = [...options.allowedWorkspaces];

  const control: ControlChannel = await connectControlChannel(
    gatewayUrl,
    options.nodeToken,
    (reason) => {
      log("control channel lost", { reason });
      options.onDisconnected?.(reason);
    },
  );
  log("control channel authenticated");

  const attachments = new Map<string, AttachmentRecord>();
  let stopped = false;

  const buildCatalogEntries = (): OpenWorkspaceEntry[] =>
    options.deps
      .listOpenWorkspaces()
      .filter((entry) => allowedWorkspaces.includes(entry.workspaceIdentity))
      .map((entry) => ({
        ...entry,
        workspaceIdentity: entry.remoteSessionId !== undefined
          ? entry.workspaceIdentity
          : localWorkspaceIdentity(entry.workspacePath),
      }));

  /** 上次发布的目录快照；未变化时不重复推送（轮询只是兜底，避免无谓控制面流量）。 */
  let lastPublishedWorkspaces = "";

  const publishWorkspaces = (): void => {
    const workspaces = buildCatalogEntries().map((entry) => ({
      nodeId: "",
      workspacePath: entry.workspacePath,
      workspaceIdentity: entry.workspaceIdentity,
      title: entry.title,
      // 远程工作区必须回传 remoteSessionId：手机 attach 靠它路由到既有远程
      // 连接的 attachment（协议字段 optional，漏传则恢复/交接断链）。
      ...(entry.remoteSessionId !== undefined ? { remoteSessionId: entry.remoteSessionId } : {}),
      available: true,
    }));
    const snapshot = JSON.stringify(workspaces);
    if (snapshot === lastPublishedWorkspaces) return;
    lastPublishedWorkspaces = snapshot;
    control.send({
      v: 1,
      event: "workspacesChanged",
      payload: {
        event: "workspacesChanged",
        workspaces,
      },
    });
  };
  publishWorkspaces();
  const catalogPoller = setInterval(() => publishWorkspaces(), 10_000);
  catalogPoller.unref?.();

  control.onRequest(async (frame) => {
    if (frame.op === "attach") {
      const parsed = companionAttachRequestParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        return { ok: false, code: "bad_request", message: "invalid attach params" };
      }
      const params = parsed.data;
      const entry = buildCatalogEntries().find(
        (candidate) => candidate.workspaceIdentity === params.workspaceIdentity,
      );
      if (!entry) {
        return { ok: false, code: "workspace_unavailable", message: "workspace not open or not shared" };
      }
      const teardown = await openCompanionRelayAttachment({
        gatewayUrl,
        params,
        scope: {
          workspacePath: entry.workspacePath,
          workspaceIdentity: entry.workspaceIdentity,
          // 共享集合：手机侧栏要为每个共享工作区读取只读任务列表（跨工作区摘要），
          // 但不得读取未共享工作区。这里是该集合的唯一权威点。
          sharedWorkspaces: buildCatalogEntries().map((candidate) => ({
            workspacePath: candidate.workspacePath,
            workspaceIdentity: candidate.workspaceIdentity,
          })),
        },
        createUpstream: async () => {
          const port = options.deps.resolveAttachmentPort(entry, params.attachmentId);
          return createPortUpstream(port);
        },
        log,
      });
      attachments.set(params.attachmentId, { entry, teardown });
      return { ok: true };
    }
    if (frame.op === "workspace-tasks") {
      const params = frame.params as { workspaceIdentity?: unknown } | null;
      const workspaceIdentity = typeof params?.workspaceIdentity === "string" ? params.workspaceIdentity : "";
      const entry = buildCatalogEntries().find(
        (candidate) => candidate.workspaceIdentity === workspaceIdentity,
      );
      if (!entry) {
        return { ok: false, code: "workspace_unavailable", message: "workspace not open or not shared" };
      }
      const result = await readWorkspaceTaskSummary({
        workspacePath: entry.workspacePath,
        workspaceIdentity: entry.workspaceIdentity,
        createUpstream: async () => {
          const port = options.deps.resolveListPort(entry, `task-index-${randomUUID()}`);
          return createPortUpstream(port);
        },
        log,
      });
      return { ok: true, result };
    }
    if (frame.op === "detach") {
      const params = frame.params as { attachmentId?: unknown } | null;
      const attachmentId = typeof params?.attachmentId === "string" ? params.attachmentId : "";
      const record = attachments.get(attachmentId);
      if (record) {
        attachments.delete(attachmentId);
        await record.teardown().catch(() => undefined);
      }
      return { ok: true };
    }
    return { ok: false, code: "bad_request", message: `unknown op: ${frame.op}` };
  });

  return {
    async setAllowedWorkspaces(next: string[]): Promise<void> {
      allowedWorkspaces = [...next];
      // 收缩白名单时立即拆除已不在名单内的 attachment。
      for (const [attachmentId, record] of Array.from(attachments.entries())) {
        if (!allowedWorkspaces.includes(record.entry.workspaceIdentity)) {
          attachments.delete(attachmentId);
          await record.teardown().catch(() => undefined);
        }
      }
      publishWorkspaces();
    },
    handleWindowClosed(windowId: number): void {
      for (const [attachmentId, record] of Array.from(attachments.entries())) {
        if (record.entry.windowId === windowId) {
          attachments.delete(attachmentId);
          void record.teardown().catch(() => undefined);
        }
      }
      publishWorkspaces();
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(catalogPoller);
      for (const [attachmentId, record] of Array.from(attachments.entries())) {
        attachments.delete(attachmentId);
        await record.teardown().catch(() => undefined);
      }
      control.close();
    },
    isConnected: () => !stopped,
  };
}

/**
 * CompanionPortLike → RPC MessagePortLike 适配：Electron MessagePortMain 走
 * Node EventEmitter 订阅（on/off），其 'message' 事件参数带 .data，与 DOM
 * MessageEvent 形状兼容，这里只做订阅 API 归一；测试对象若已提供 DOM 风格
 * addEventListener 则原样透传。
 */
function wrapCompanionPort(port: CompanionPortLike): import("@zcode/rpc").MessagePortLike {
  if (typeof port.addEventListener === "function") {
    return {
      addEventListener: (type, listener) => port.addEventListener?.(type, listener),
      removeEventListener: (type, listener) => port.removeEventListener?.(type, listener),
      postMessage: (message) => port.postMessage(message),
      start: () => port.start?.(),
      close: () => port.close(),
    };
  }
  return {
    addEventListener: (type, listener) => {
      port.on?.(type, listener);
    },
    removeEventListener: (type, listener) => {
      port.off?.(type, listener);
    },
    postMessage: (message) => port.postMessage(message),
    start: () => port.start?.(),
    close: () => port.close(),
  };
}

/** MessagePortMain → 窄化 facade 的 upstream channel（消息面 = 裸 Uint8Array + 流控对象）。 */
function createPortUpstream(port: CompanionPortLike): RelayAttachmentUpstream {
  const protocol = new MessagePortProtocol(wrapCompanionPort(port));
  const client = new ChannelClient(protocol);
  return {
    channelClient: client,
    dispose: () => {
      client.dispose();
      port.close();
    },
  };
}
