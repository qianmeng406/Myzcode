// relay attachment 通用装配：拨 gateway relay WS + ChannelServer(窄化 facade)。
// 云端 connector（upstream=resident TCP）与桌面 connector（upstream=Host MessagePort）
// 共用此模块，保证「窄化 + workspace 绑定注入」只有一处实现（specs §5）。
import { ChannelServer, SocketProtocol, VSBuffer, type IChannel, type ISocket } from "@zcode/rpc";
import type { WebSocket } from "ws";
import { WebSocket as NodeWebSocket } from "ws";
import { IZCodeAgentService } from "@zcode/services";
import { ServiceChannels } from "@zcode/shared";
import { createNarrowingAgentFacade } from "./narrowingFacade.js";
import { createPolicyChannel, policyForChannel } from "./channelPolicy.js";

export interface RelayAttachmentParams {
  attachmentId: string;
  workspacePath: string;
  workspaceIdentity: string;
  relayCapability: string;
}

export interface RelayAttachmentUpstream {
  channel: IChannel;
  /** attachment 拆除时释放上游（TCP socket / MessagePort）。 */
  dispose(): void;
}

export interface CompanionLogger {
  (message: string, details?: Record<string, unknown>): void;
}

/**
 * 建立一个 relay attachment：本进程作为 relay WS 的 ChannelServer 一端，
 * 手机请求经窄化 facade（绑定 workspace 注入）转发到 upstream channel。
 * 返回 teardown；relay 对端断开时自动触发。
 */
export async function openCompanionRelayAttachment(options: {
  gatewayUrl: string;
  params: RelayAttachmentParams;
  scope: { workspacePath: string; workspaceIdentity: string };
  createUpstream: () => Promise<RelayAttachmentUpstream>;
  log: CompanionLogger;
}): Promise<() => Promise<void>> {
  const { gatewayUrl, params, scope, createUpstream, log } = options;
  const upstream = await createUpstream();

  const relay = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new NodeWebSocket(`${gatewayUrl}/companion/relay/${params.attachmentId}`);
    ws.binaryType = "nodebuffer";
    ws.on("open", () => {
      ws.send(params.relayCapability);
      resolve(ws);
    });
    ws.on("close", (code) => reject(new Error(`relay closed before ready (${code})`)));
    ws.on("error", (error) => reject(new Error(`relay failed: ${error.message}`)));
  });

  const channelServer = new ChannelServer(
    new SocketProtocol(wrapNodeWebSocket(relay)),
    `companion-${params.attachmentId}`,
  );
  // zcode-agent：既有窄 facade（v4 白名单 + workspace 注入，specs §5）。
  channelServer.registerChannel(
    IZCodeAgentService.channelName,
    createNarrowingAgentFacade({ upstream: upstream.channel, scope }),
  );
  // 其余全部 ServiceChannels 按三分名单裁决（specs §11）：表内 T2/T1，表外 T0。
  // 全量注册保证 RemoteServiceAccess 对每个频道的请求都快速失败而不是挂起。
  for (const channelName of Object.values(ServiceChannels)) {
    if (channelName === IZCodeAgentService.channelName) continue;
    channelServer.registerChannel(
      channelName,
      createPolicyChannel({
        channelName,
        upstream: upstream.channel,
        policy: policyForChannel(channelName),
      }),
    );
  }
  log("relay attachment established", { attachmentId: params.attachmentId });

  const teardown = async (): Promise<void> => {
    channelServer.dispose();
    try {
      relay.close();
    } catch {
      // no-op
    }
    upstream.dispose();
  };
  relay.on("close", () => {
    // 手机/网关侧断开：释放本 attachment 的上游连接（订阅随之退订）。
    void teardown();
  });
  return teardown;
}

/** ws 包客户端 socket → ISocket（与浏览器 wrapBrowserWebSocket 同构）。 */
export function wrapNodeWebSocket(ws: WebSocket): ISocket {
  const dataListeners = new Set<(buffer: VSBuffer) => void>();
  const closeListeners = new Set<() => void>();
  ws.on("message", (data) => {
    const chunk = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
    const buffer = VSBuffer.wrap(new Uint8Array(chunk));
    for (const listener of dataListeners) listener(buffer);
  });
  const fireClose = () => {
    for (const listener of closeListeners) listener();
  };
  ws.on("close", fireClose);
  ws.on("error", fireClose);
  return {
    onData: (listener: (buffer: VSBuffer) => void) => {
      dataListeners.add(listener);
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
      if (ws.readyState === NodeWebSocket.OPEN) {
        ws.send(Buffer.from(buffer.buffer));
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}
