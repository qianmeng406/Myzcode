// 桌面 companion 连接器：出站连接 gateway，把手机的 attachment 桥接到
// 本机**已打开**工作区的既有 Host attachment（local: 窗口 Host；remote: 既有远程连接）。
// 不为手机新建 Agent / Host / 远程连接（AGENTS.md 手机远控边界）。
// workspace 绑定由共享窄化 facade 注入（local scope 消息只含 {kind:"local"}，
// 路径/身份绑定必须发生在连接器侧，防手机越权访问同 Host 其他工作区）。
import { ChannelClient, MessagePortProtocol, type IChannel } from "@zcode/rpc";
import { companionAttachRequestParamsSchema } from "@zcode/shared/companion-protocol";
import { IZCodeAgentService } from "@zcode/services";
import {
  connectControlChannel,
  type ControlChannel,
} from "@zcode/server/companion-control";
import {
  openCompanionRelayAttachment,
  type CompanionLogger,
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

/** MessagePortMain 形状的端口（测试用普通对象即可）。 */
export interface CompanionPortLike {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown, transfer?: unknown[]): void;
  start?(): void;
  close(): void;
}

export interface DesktopCompanionConnectorDeps {
  listOpenWorkspaces(): OpenWorkspaceEntry[];
  resolveAttachmentPort(entry: OpenWorkspaceEntry, attachmentId: string): CompanionPortLike;
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

/** MessagePortMain → 窄化 facade 的 upstream channel（消息面 = 裸 Uint8Array + 流控对象）。 */
function createPortUpstream(port: CompanionPortLike): {
  channel: IChannel;
  dispose: () => void;
} {
  const protocol = new MessagePortProtocol(port as unknown as import("@zcode/rpc").MessagePortLike);
  const client = new ChannelClient(protocol);
  return {
    channel: client.getChannel(IZCodeAgentService.channelName),
    dispose: () => {
      client.dispose();
      port.close();
    },
  };
}
