// gateway 控制面客户端（connector 侧）：/companion/node 的鉴权、请求/响应关联
// 与 hub 请求接收。首帧 auth + 显式回执与 gateway wireFirstFrameAuth 对齐。
import { WebSocket } from "ws";

const CONTROL_AUTH_TIMEOUT_MS = 10_000;

export type HubRequestResult =
  | { ok: true; result?: unknown }
  | { ok: false; code: string; message: string };

export type HubRequestHandler = (frame: {
  id: string;
  op: string;
  params?: unknown;
}) => Promise<HubRequestResult>;

export interface ControlChannel {
  send(frame: unknown): void;
  onRequest(handler: HubRequestHandler): void;
  close(): void;
}

/** 连接 gateway 节点控制面；鉴权失败/超时 reject，建立后断开经 onDisconnected 通知。 */
export function connectControlChannel(
  gatewayUrl: string,
  nodeToken: string,
  onDisconnected: (reason: string) => void,
): Promise<ControlChannel> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${gatewayUrl}/companion/node`);
    const pending = new Map<string, (value: HubRequestResult) => void>();
    const requestHandlerRef: { current: HubRequestHandler | null } = { current: null };
    let established = false;

    ws.on("open", () => {
      ws.send(JSON.stringify({ v: 1, id: "auth", op: "auth", params: { nodeToken } }));
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let value: unknown;
      try {
        value = JSON.parse(String(data));
      } catch {
        return;
      }
      const record = value as { id?: unknown; ok?: unknown; op?: unknown };
      if (record.id === "auth") {
        if (record.ok === true) {
          established = true;
          resolve({
            send: (frame) => ws.send(JSON.stringify(frame)),
            onRequest: (handler) => {
              requestHandlerRef.current = handler;
            },
            close: () => ws.close(),
          });
        } else {
          ws.close();
          reject(new Error("gateway rejected node auth"));
        }
        return;
      }
      if (typeof record.id === "string" && typeof record.ok === "boolean") {
        const resolver = pending.get(record.id);
        if (!resolver) return;
        pending.delete(record.id);
        resolver(
          record.ok
            ? { ok: true, result: (value as { result?: unknown }).result }
            : {
                ok: false,
                code: (value as { error?: { code?: string } }).error?.code ?? "internal",
                message: (value as { error?: { message?: string } }).error?.message ?? "error",
              },
        );
        return;
      }
      if (typeof record.op === "string" && typeof record.id === "string") {
        // hub → connector 请求（attach/detach）。
        const id = record.id;
        const op = record.op;
        const params = (value as { params?: unknown }).params;
        void (async () => {
          const handler = requestHandlerRef.current;
          let result: HubRequestResult;
          if (!handler) {
            result = { ok: false, code: "internal", message: "connector not ready" };
          } else {
            try {
              result = await handler({ id, op, params });
            } catch (error) {
              result = {
                ok: false,
                code: "internal",
                message: error instanceof Error ? error.message : String(error),
              };
            }
          }
          ws.send(
            JSON.stringify(
              result.ok
                ? { v: 1, id, ok: true, ...(result.result !== undefined ? { result: result.result } : {}) }
                : { v: 1, id, ok: false, error: { code: result.code, message: result.message } },
            ),
          );
        })();
      }
    });
    // ws 库对异常断连保证 error 后必跟 close：不防抖会把 onDisconnected
    // 触发两次，监督层若据此各起一条重启链就会互相踢连接（振荡）。
    let disconnectReported = false;
    const reportDisconnected = (reason: string): void => {
      if (disconnectReported) return;
      disconnectReported = true;
      onDisconnected(reason);
    };
    ws.on("close", () => {
      if (established) {
        reportDisconnected("gateway control channel closed");
        return;
      }
      reject(new Error("gateway control channel closed before ready"));
    });
    ws.on("error", (error) => {
      if (established) {
        reportDisconnected(`gateway control channel error: ${error.message}`);
        return;
      }
      reject(new Error(`gateway control channel failed: ${error.message}`));
    });
    setTimeout(() => {
      if (!established) reject(new Error("gateway auth timeout"));
    }, CONTROL_AUTH_TIMEOUT_MS).unref?.();
  });
}
