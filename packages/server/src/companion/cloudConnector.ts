// 云端 companion 连接器：附着既有 resident daemon，出站连接 gateway，
// 把手机 attachment 透传为「daemon 每连接一个 scope」的既有语义。
// 生命周期（specs/companion-gateway.md §2/§5）：
//   control WS（auth → workspacesChanged）→ hub attachRequest →
//   本机 TCP 连 daemon（客户端 hello/ack）→ 拨 relay WS（一次性 capability）→
//   relay 上跑 ChannelServer(窄化 facade)；detach/断开同时关闭该 attachment 的 TCP，
//   让 daemon 侧 scope.dispose 退订本连接订阅（任务继续由 daemon 持有）。
import * as net from "node:net";
import { ChannelClient, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import { ZCODE_VERSION } from "@zcode/shared";
import {
  companionAttachRequestParamsSchema,
  type CompanionWorkspaceEntry,
} from "@zcode/shared/companion-protocol";
import { IZCodeAgentService } from "@zcode/services";
import { WebSocket } from "ws";
import { connectLoopbackPort } from "../remote/resident-bridge.js";
import {
  readResidentDaemonStatus,
  residentDaemonStatusPath,
} from "../remote/resident-protocol.js";
import { openCompanionRelayAttachment, type CompanionLogger } from "./relayAttachment.js";
import { readWorkspaceTaskSummary } from "./ephemeralTaskIndex.js";
import { connectControlChannel } from "./controlChannel.js";

export interface CloudCompanionWorkspace {
  workspacePath: string;
  title: string;
}

export interface CloudCompanionConnectorOptions {
  /** gateway 基地址，如 ws://127.0.0.1:8090 或 wss://companion.example.com */
  gatewayUrl: string;
  nodeToken: string;
  /** resident runtime root（含 daemon.json）。 */
  runtimeRoot: string;
  /** 显式工作区白名单：手机只能 attach 这些目录。 */
  workspaces: CloudCompanionWorkspace[];
  /** 控制链路在鉴权建立后断开（gateway 重启/网络问题）；宿主可借此进程退出重建。 */
  onDisconnected?: (reason: string) => void;
  logger?: (message: string, details?: Record<string, unknown>) => void;
}

export interface CloudCompanionConnectorHandle {
  stop(): Promise<void>;
}

/** 云端工作区身份 = 路径本身（与 workspaceIdentity?.trim() || workspacePath 一致）。 */
function cloudWorkspaceIdentity(workspacePath: string): string {
  return workspacePath.trim();
}

function workspaceEntries(options: CloudCompanionConnectorOptions, daemonAlive: boolean): CompanionWorkspaceEntry[] {
  return options.workspaces.map((workspace) => ({
    nodeId: "",
    workspacePath: workspace.workspacePath,
    workspaceIdentity: cloudWorkspaceIdentity(workspace.workspacePath),
    title: workspace.title,
    available: daemonAlive,
  }));
}

export async function startCloudCompanionConnector(
  options: CloudCompanionConnectorOptions,
): Promise<CloudCompanionConnectorHandle> {
  const log = options.logger ?? ((message: string, details?: Record<string, unknown>) => {
    console.log(`[companion-cloud] ${message}`, details ?? "");
  });
  if (options.workspaces.length === 0) {
    throw new Error("cloud connector requires at least one workspace");
  }
  const gatewayUrl = options.gatewayUrl.replace(/\/+$/, "");

  const control = await connectControlChannel(gatewayUrl, options.nodeToken, (reason) => {
    log("control channel lost", { reason });
    options.onDisconnected?.(reason);
  });
  log("control channel authenticated");

  const attachments = new Map<string, () => Promise<void>>();
  let stopped = false;

  const publishWorkspaces = async (): Promise<void> => {
    const daemonAlive = await isDaemonAlive(options.runtimeRoot);
    control.send({
      v: 1,
      event: "workspacesChanged",
      payload: { event: "workspacesChanged", workspaces: workspaceEntries(options, daemonAlive) },
    });
  };
  await publishWorkspaces();

  const daemonPoller = setInterval(() => {
    void publishWorkspaces().catch(() => undefined);
  }, 10_000);
  daemonPoller.unref?.();

  control.onRequest(async (frame) => {
    if (frame.op === "attach") {
      const parsed = companionAttachRequestParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        return { ok: false, code: "bad_request", message: "invalid attach params" };
      }
      const params = parsed.data;
      const teardown = await openRelayAttachment(gatewayUrl, options, params, log);
      attachments.set(params.attachmentId, teardown);
      return { ok: true };
    }
    if (frame.op === "workspace-tasks") {
      const params = frame.params as
        | { workspaceIdentity?: unknown; workspacePath?: unknown }
        | null;
      const workspaceIdentity = typeof params?.workspaceIdentity === "string" ? params.workspaceIdentity : "";
      const workspacePath = typeof params?.workspacePath === "string" ? params.workspacePath : workspaceIdentity;
      const result = await readWorkspaceTaskSummary({
        workspacePath,
        workspaceIdentity,
        createUpstream: async () => {
          const status = await readResidentDaemonStatus(residentDaemonStatusPath(options.runtimeRoot));
          if (!status) {
            throw Object.assign(new Error("resident daemon not running"), { code: "workspace_unavailable" });
          }
          const tcp = await connectLoopbackPort(status.port);
          const upstreamSocket = await performClientHandshake(tcp);
          const client = new ChannelClient(new SocketProtocol(upstreamSocket));
          return { channelClient: client, dispose: () => tcp.destroy() };
        },
        log,
      });
      return { ok: true, result };
    }
    if (frame.op === "detach") {
      const params = frame.params as { attachmentId?: unknown } | null;
      const attachmentId = typeof params?.attachmentId === "string" ? params.attachmentId : "";
      const teardown = attachments.get(attachmentId);
      if (teardown) {
        attachments.delete(attachmentId);
        await teardown();
      }
      return { ok: true };
    }
    return { ok: false, code: "bad_request", message: `unknown op: ${frame.op}` };
  });

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(daemonPoller);
      for (const [attachmentId, teardown] of attachments.entries()) {
        attachments.delete(attachmentId);
        await teardown().catch(() => undefined);
      }
      control.close();
    },
  };
}

// ── 控制面客户端 ──

async function isDaemonAlive(runtimeRoot: string): Promise<boolean> {
  const status = await readResidentDaemonStatus(residentDaemonStatusPath(runtimeRoot));
  if (!status) return false;
  try {
    process.kill(status.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function openRelayAttachment(
  gatewayUrl: string,
  options: CloudCompanionConnectorOptions,
  params: { attachmentId: string; workspacePath: string; workspaceIdentity: string; relayCapability: string },
  log: CompanionLogger,
): Promise<() => Promise<void>> {
  const whitelisted = options.workspaces.find(
    (workspace) =>
      workspace.workspacePath === params.workspacePath &&
      cloudWorkspaceIdentity(workspace.workspacePath) === params.workspaceIdentity,
  );
  if (!whitelisted) {
    throw Object.assign(new Error("workspace not whitelisted"), { code: "forbidden_workspace" });
  }
  const status = await readResidentDaemonStatus(residentDaemonStatusPath(options.runtimeRoot));
  if (!status) {
    throw Object.assign(new Error("resident daemon not running"), { code: "workspace_unavailable" });
  }

  // 本机 TCP 连 daemon（每 attachment 独立连接：断开 → daemon scope 退订）。
  return await openCompanionRelayAttachment({
    gatewayUrl,
    params,
    scope: {
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    },
    createUpstream: async () => {
      const tcp = await connectLoopbackPort(status.port);
      const upstreamSocket = await performClientHandshake(tcp);
      const client = new ChannelClient(new SocketProtocol(upstreamSocket));
      return {
        channelClient: client,
        dispose: () => tcp.destroy(),
      };
    },
    log,
  });
}

/** 客户端侧 resident 握手：读 daemon 的 zcode-hello 行，回 zcode-hello-ack，
 * 声明 web-remote-replayable 投递档（daemon 据此建 scope，匹配手机数据层语义），
 * 返回已消费握手残留字节的 ISocket（残留先于 channel 数据回流）。 */
async function performClientHandshake(tcp: net.Socket): Promise<ISocket> {
  const ack = JSON.stringify({
    type: "zcode-hello-ack",
    version: ZCODE_VERSION,
    clientId: `companion-${Date.now()}`,
    clientMode: "web-remote-replayable",
  });
  return await new Promise<ISocket>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const prefix: Buffer[] = [];
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      tcp.off("data", onData);
      if (error) {
        tcp.destroy();
        reject(error);
        return;
      }
      resolve(wrapNetSocketWithPrefix(tcp, prefix));
    };
    const timeout = setTimeout(() => finish(new Error("resident client handshake timeout")), 10_000);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf-8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;
      const helloLine = buffer.slice(0, newlineIdx).trim();
      const remaining = buffer.slice(newlineIdx + 1);
      try {
        const hello = JSON.parse(helloLine) as { type?: unknown };
        if (hello.type !== "zcode-hello") {
          finish(new Error("unexpected resident hello"));
          return;
        }
      } catch {
        finish(new Error("invalid resident hello"));
        return;
      }
      tcp.write(`${ack}\n`);
      if (remaining.length > 0) {
        prefix.push(Buffer.from(remaining, "utf-8"));
      }
      finish();
    };
    tcp.on("data", onData);
    tcp.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

/**
 * 握手完成即接管 socket 数据流（含 hello 残留前缀回放）。
 * 关键不变量：接管到「ChannelClient 完全就绪」之间到达的帧一律缓冲，再按序回放。
 * 回放延迟到 setImmediate：SocketProtocol 在构造期订阅 onData，而 ChannelClient
 * 的 onMessage 订阅晚一拍——同步回放会让最早的帧（daemon 的 Initialize）落进
 * 无订阅者的 Emitter 被丢弃，客户端将永远等不到初始化。
 */
function wrapNetSocketWithPrefix(tcp: net.Socket, prefix: Buffer[]): ISocket {
  const dataListeners = new Set<(buffer: VSBuffer) => void>();
  const closeListeners = new Set<() => void>();
  const pending: VSBuffer[] = [];
  let deliveringDirectly = false;
  for (const buffered of prefix) {
    pending.push(VSBuffer.wrap(new Uint8Array(buffered)));
  }
  const deliver = (buffer: VSBuffer): void => {
    if (!deliveringDirectly) {
      pending.push(buffer);
      return;
    }
    for (const listener of dataListeners) listener(buffer);
  };
  tcp.on("data", (chunk: Buffer) => {
    deliver(VSBuffer.wrap(new Uint8Array(chunk)));
  });
  const fireClose = (): void => {
    for (const listener of closeListeners) listener();
  };
  tcp.once("close", fireClose);
  tcp.once("error", fireClose);
  return {
    onData: (listener: (buffer: VSBuffer) => void) => {
      dataListeners.add(listener);
      if (!deliveringDirectly) {
        // 订阅方链（SocketProtocol → ChannelClient）在同一同步块内完成装配，
        // setImmediate 回放时全部就绪；期间新帧继续入 pending，顺序不乱。
        setImmediate(() => {
          while (pending.length > 0) {
            const buffer = pending.shift();
            if (!buffer) break;
            for (const registered of dataListeners) registered(buffer);
          }
          deliveringDirectly = true;
        });
      }
      return { dispose: () => dataListeners.delete(listener) };
    },
    onClose: (listener: () => void) => {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    onEnd: (listener: () => void) => {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    write(buffer: VSBuffer) {
      tcp.write(Buffer.from(buffer.buffer));
    },
    end() {
      tcp.end();
    },
    drain() {
      return new Promise<void>((resolve) => {
        if (tcp.writableNeedDrain) {
          tcp.once("drain", resolve);
        } else {
          resolve();
        }
      });
    },
    dispose() {
      tcp.destroy();
    },
  };
}
