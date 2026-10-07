// ws ↔ hub 链路适配：控制面 JSON 帧解析、Mobile/Node 链路实现、relay socket 接入。
// 鉴权统一走「首帧」：mobile/access token、node/token、relay/capability，
// 避免 token 进入 URL 查询参数（specs/companion-gateway.md §6）。
import {
  companionEventSchema,
  companionNodeWorkspacesParamsSchema,
  companionRequestSchema,
  companionWorkspaceEventSchema,
  type CompanionEvent,
} from "@zcode/shared/companion-protocol";
import type { WebSocket } from "ws";
import type { CompanionHub } from "../app/hub.js";
import type {
  HubLogger,
  MobileLink,
  NodeLink,
  RelayJoin,
} from "../app/ports.js";

import { CONTROL_FRAME_MAX_BYTES } from "./httpGuards.js";

export { CONTROL_FRAME_MAX_BYTES };
export const RELAY_BUFFER_LIMIT = 64;
/** relay bind 前缓冲按字节限总量（帧数限制挡不住 64×大帧的内存堆积）。 */
export const RELAY_BUFFER_MAX_BYTES = 2 * 1024 * 1024;

type ControlFrame =
  | { kind: "request"; id: string; op: string; params?: unknown }
  | { kind: "response"; id: string; ok: boolean; result?: unknown; errorCode?: string; message?: string }
  | { kind: "event"; event: string; payload?: unknown };

export function parseControlFrame(raw: string): ControlFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const response = (value as { ok?: unknown })?.ok;
  if (typeof response === "boolean") {
    const obj = value as { id?: unknown; ok?: boolean; result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (typeof obj.id !== "string") return null;
    return {
      kind: "response",
      id: obj.id,
      ok: obj.ok === true,
      result: obj.result,
      errorCode: typeof obj.error?.code === "string" ? obj.error.code : undefined,
      message: typeof obj.error?.message === "string" ? obj.error.message : undefined,
    };
  }
  if (typeof (value as { event?: unknown })?.event === "string") {
    const parsed = companionEventSchema.safeParse(value);
    return parsed.success
      ? { kind: "event", event: parsed.data.event, payload: parsed.data.payload }
      : null;
  }
  const parsed = companionRequestSchema.safeParse(value);
  return parsed.success
    ? { kind: "request", id: parsed.data.id, op: parsed.data.op, params: parsed.data.params }
    : null;
}

interface MobileLinkOptions {
  ws: WebSocket;
  deviceId: string;
  hub: CompanionHub;
  logger: HubLogger;
}

export function createMobileLink(options: MobileLinkOptions): MobileLink {
  const { ws, deviceId, hub, logger } = options;
  const link: MobileLink = {
    deviceId,
    respond(id, result) {
      sendJson(ws, {
        v: 1,
        id,
        ...(result.ok
          ? { ok: true, ...(result.result !== undefined ? { result: result.result } : {}) }
          : { ok: false, error: { code: result.code, message: result.message } }),
      });
    },
    sendEvent(event: CompanionEvent) {
      sendJson(ws, event);
    },
    close() {
      try {
        ws.close(1000, "gateway closing");
      } catch {
        // 已关闭的 ws 再 close 是无害 no-op。
      }
    },
  };
  ws.on("message", (data, isBinary) => {
    if (isBinary) return; // 控制面只收文本帧
    // 帧上限在此兜底（ws 库默认 maxPayload 100MiB，过大帧直接断开，防未鉴权解析面）。
    if (frameByteLength(data) > CONTROL_FRAME_MAX_BYTES) {
      try { ws.close(1009, "frame too large"); } catch { /* no-op */ }
      return;
    }
    const frame = parseControlFrame(data.toString("utf8"));
    if (!frame || frame.kind !== "request") return;
    void hub.handleMobileRequest(link, frame.id, frame.op, frame.params);
  });
  ws.on("close", () => {
    hub.handleMobileClosed(link);
    logger.info("companion mobile link closed", { deviceId });
  });
  ws.on("error", (error) => {
    logger.warn("companion mobile link error", {
      deviceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return link;
}

interface NodeLinkOptions {
  ws: WebSocket;
  nodeId: string;
  hub: CompanionHub;
  logger: HubLogger;
}

/** hub → connector 请求经此适配；pending 表负责 id 关联与超时。 */
export function createNodeLink(options: NodeLinkOptions): NodeLink {
  const { ws, nodeId, hub, logger } = options;
  let nextRequestId = 0;
  const pending = new Map<
    string,
    { resolve: (result: { ok: true; result?: unknown } | { ok: false; code: string; message: string }) => void; timer: ReturnType<typeof setTimeout> }
  >();

  const link: NodeLink = {
    nodeId,
    request(op, params, timeoutMs) {
      return new Promise((resolve) => {
        const id = `hub-${++nextRequestId}`;
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            resolve({ ok: false, code: "node_offline", message: `node request timed out: ${op}` });
          }
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        sendJson(ws, { v: 1, id, op, params });
      });
    },
    close() {
      try {
        ws.close(1000, "gateway closing");
      } catch {
        // 同上：no-op 安全。
      }
    },
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    if (frameByteLength(data) > CONTROL_FRAME_MAX_BYTES) {
      try { ws.close(1009, "frame too large"); } catch { /* no-op */ }
      return;
    }
    const frame = parseControlFrame(data.toString("utf8"));
    if (!frame) return;
    if (frame.kind === "response") {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      clearTimeout(entry.timer);
      entry.resolve(
        frame.ok
          ? { ok: true, ...(frame.result !== undefined ? { result: frame.result } : {}) }
          : { ok: false, code: frame.errorCode ?? "internal", message: frame.message ?? "node error" },
      );
      return;
    }
    if (frame.kind === "event" && frame.event === "workspacesChanged") {
      const parsed = companionWorkspaceEventSchema.safeParse({
        event: frame.event,
        ...((frame.payload ?? {}) as object),
      });
      if (!parsed.success) return;
      const workspaces = companionNodeWorkspacesParamsSchema.safeParse({ workspaces: parsed.data.workspaces });
      if (workspaces.success) {
        hub.handleNodeWorkspaces(nodeId, workspaces.data.workspaces.map((entry) => ({ ...entry, nodeId })));
      }
    }
  });
  ws.on("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code: "node_offline", message: "node connection closed" });
    }
    pending.clear();
    hub.handleNodeClosed(nodeId, link);
  });
  ws.on("error", (error) => {
    logger.warn("companion node link error", {
      nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return link;
}

interface RelaySocketOptions {
  ws: WebSocket;
  attachmentId: string;
  hub: CompanionHub;
}

/**
 * relay ws 接入：首个文本帧 = 一次性 capability → hub 校验；随后 binary 帧进入透传。
 * 监听器注册前的入帧先缓冲（上限 RELAY_BUFFER_LIMIT），bindRelayPair 注册后flush。
 */
export function attachRelaySocket(options: RelaySocketOptions): void {
  const { ws, attachmentId, hub } = options;
  let authenticated = false;
  let bufferedBytes = 0;
  const buffered: Uint8Array[] = [];
  const binaryListeners = new Set<(data: Uint8Array) => void>();
  const closedListeners = new Set<() => void>();
  let closed = false;

  const join: RelayJoin = {
    attachmentId,
    capability: "",
    onBinary(listener) {
      binaryListeners.add(listener);
      while (buffered.length > 0) {
        const frame = buffered.shift();
        if (frame) listener(frame);
      }
    },
    onClosed(listener) {
      closedListeners.add(listener);
    },
    sendBinary(data) {
      if (closed || ws.readyState !== ws.OPEN) return;
      ws.send(data, { binary: true });
    },
    close(code, reason) {
      if (closed) return;
      closed = true;
      try {
        ws.close(code, reason);
      } catch {
        // no-op
      }
    },
  };

  ws.on("message", (data, isBinary) => {
    if (closed) return;
    if (!authenticated) {
      // 首帧：capability（文本）。
      authenticated = true;
      join.capability = isBinary ? "" : data.toString("utf8");
      const accepted = hub.handleRelayJoin(join);
      if (!accepted) {
        join.close(4001, "relay join rejected");
      }
      return;
    }
    if (isBinary) {
      const bytes = new Uint8Array(data as ArrayBuffer);
      if (binaryListeners.size === 0) {
        if (buffered.length < RELAY_BUFFER_LIMIT && bufferedBytes + bytes.byteLength <= RELAY_BUFFER_MAX_BYTES) {
          buffered.push(bytes);
          bufferedBytes += bytes.byteLength;
        } else {
          join.close(1008, "relay buffer overflow");
        }
        return;
      }
      for (const listener of binaryListeners) listener(bytes);
    }
    // 鉴权后的文本帧忽略（协议保留）。
  });
  ws.on("close", () => {
    if (closed) return;
    closed = true;
    for (const listener of closedListeners) listener();
  });
  ws.on("error", () => {
    if (closed) return;
    closed = true;
    for (const listener of closedListeners) listener();
  });
}

/** ws RawData = Buffer | Buffer[]；统一取字节长度。 */
function frameByteLength(data: unknown): number {
  if (Array.isArray(data)) {
    return data.reduce((sum, item) => sum + (typeof item.byteLength === "number" ? item.byteLength : 0), 0);
  }
  const buffer = data as { byteLength?: number };
  return typeof buffer.byteLength === "number" ? buffer.byteLength : 0;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}
