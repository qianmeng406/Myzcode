// 浏览器安全的 companion 客户端传输（公开入口，禁止 import adapters）。
// 控制面：JSON 帧（首帧 auth + 显式回执）+ 请求/响应关联 + 事件订阅。
// 数据面：attach 返回的 relay WS 上跑既有 SocketProtocol/ChannelClient，
// 手机侧因此能直接复用 packages/ui 的 v4 会话数据层与恢复语义。
import { ChannelClient, SocketProtocol } from "@zcode/rpc";
import {
  companionAttachResultSchema,
  companionCatalogResultSchema,
  type CompanionAttachParams,
  type CompanionAttachResult,
  type CompanionCatalogResult,
  type CompanionDetachParams,
  type CompanionEvent,  COMPANION_CSRF_HEADERS,
} from "@zcode/shared/companion-protocol";
import { RemoteServiceAccess, wrapBrowserWebSocket } from "@zcode/client";
import type { IServiceAccessor } from "@zcode/services";

export interface CompanionClientOptions {
  /** gateway 基地址，如 https://companion.example.com */
  baseUrl: string;
  /** 短时 access token（内存持有）；由 /companion/pair 或 /companion/refresh 获得。 */
  accessToken: string;
  onEvent?: (event: CompanionEvent) => void;
  onClose?: (event: { code: number; reason: string }) => void;
  requestTimeoutMs?: number;
  /**
   * 控制面应用层心跳（默认开启）：间隔 10s 发 ping，30s 无回包判定半开连接，
   * 主动断开（触发 onClose → 上层自动重连）。显式传 null 关闭（测试用）。
   */
  heartbeat?: { intervalMs?: number; watchdogMs?: number } | null;
}

export interface CompanionRelayChannel {
  attachmentId: string;
  /** 既有 v4 会话数据层入口（IZCodeAgentService 代理所在 accessor）。 */
  accessor: IServiceAccessor;
  close(): void;
  /** relay WS 断开（网关重启/网络问题/attachment 拆除）时回调一次；宿主据此提示恢复。 */
  onClosed(listener: () => void): void;
}

interface PendingRequest {
  resolve: (value: { ok: true; result?: unknown } | { ok: false; code: string; message: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}


export interface CompanionPairResult {
  deviceId: string;
  deviceName: string;
  accessToken: string;
  accessExpiresAt: number;
}

export interface CompanionRefreshResult {
  deviceId: string;
  accessToken: string;
  accessExpiresAt: number;
}

export class CompanionClient {
  /** 手机配对：一次性配对码 + 设备名 → 设备凭证（静态方法，不要求已连接）。 */
  static async pair(options: {
    baseUrl: string;
    deviceName: string;
    code: string;
  }): Promise<CompanionPairResult> {
    const base = options.baseUrl.replace(/\/+$/, "");
    let response: Response;
    try {
      response = await fetch(`${base}/companion/pair`, {
        method: "POST",
        headers: { ...COMPANION_CSRF_HEADERS, "content-type": "application/json" },
        // 长期凭证走 HttpOnly refresh Cookie（WebView 持久化，JS 不可读），
        // 跨源必须显式带 credentials，否则 App 重启后无法无感恢复。
        credentials: "include",
        body: JSON.stringify({ deviceName: options.deviceName, code: options.code }),
      });
    } catch (networkError) {
      // fetch 网络层失败（DNS/拒连/超时/混合内容拦截）统一给出可操作提示。
      const hint = options.baseUrl.startsWith("http://")
        ? "检查：手机与电脑是否同一 Wi-Fi、电脑防火墙是否放行该端口、地址是否写对"
        : "检查：接入服务地址是否正确、HTTPS 证书是否有效";
      throw new Error(
        `无法连接接入服务（${networkError instanceof Error ? networkError.message : String(networkError)}）。${hint}`,
      );
    }
    const body = (await response.json().catch(() => null)) as
      | CompanionPairResult
      | { error?: { message?: string } }
      | null;
    if (!response.ok) {
      const message =
        body !== null && typeof body === "object" && "error" in body
          ? (body.error?.message ?? `pair failed (${response.status})`)
          : `pair failed (${response.status})`;
      throw new Error(message);
    }
    if (body === null || typeof body !== "object" || !("accessToken" in body)) {
      throw new Error("pair response malformed");
    }
    return body;
  }

  /** 刷新短时 access（浏览器走 HttpOnly refresh Cookie；非浏览器显式传 refreshToken）。 */
  static async refresh(options: {
    baseUrl: string;
    refreshToken?: string;
  }): Promise<CompanionRefreshResult> {
    const base = options.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}/companion/refresh`, {
      method: "POST",
      headers: { ...COMPANION_CSRF_HEADERS, "content-type": "application/json" },
      credentials: "include",
      ...(options.refreshToken !== undefined
        ? { body: JSON.stringify({ refreshToken: options.refreshToken }) }
        : {}),
    });
    const body = (await response.json().catch(() => null)) as
      | CompanionRefreshResult
      | { error?: { message?: string } }
      | null;
    if (!response.ok || body === null || typeof body !== "object" || !("accessToken" in body)) {
      throw new Error("refresh rejected");
    }
    return body;
  }

  private ws: WebSocket | null = null;
  private nextRequestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: CompanionEvent) => void>();
  private closedByServer = false;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInFlight = false;

  constructor(private readonly options: CompanionClientOptions) {}

  /** 建立控制面连接并等待 auth 回执；重复调用会先关闭旧连接。 */
  connect(): Promise<void> {
    this.close();
    // 实例复用 connect() 时复位断线语义（否则重连后 onClose 永不再触发）。
    this.closedByServer = false;
    const base = this.options.baseUrl.replace(/\/+$/, "");
    const wsUrl = `${base.replace(/^http/, "ws")}/companion/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      // auth 回执整体超时：网关半死（TCP 建连后不回包）时不能无限挂起。
      const authTimer = setTimeout(() => {
        fail(new Error("companion auth timeout"));
        try { ws.close(); } catch { /* no-op */ }
      }, 10_000);
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ v: 1, id: "auth", op: "auth", params: { accessToken: this.options.accessToken } }));
      });
      ws.addEventListener("message", (event) => {
        let value: unknown;
        try {
          value = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const record = value as { id?: unknown; ok?: unknown; event?: unknown };
        if (typeof record.event === "string") {
          const companionEvent = value as CompanionEvent;
          for (const listener of this.eventListeners) listener(companionEvent);
          this.options.onEvent?.(companionEvent);
          return;
        }
        if (record.id === "auth") {
          clearTimeout(authTimer);
          if (record.ok === true) {
            settled = true;
            this.startHeartbeat();
            resolve();
          } else {
            fail(new Error("companion auth rejected"));
            ws.close();
          }
          return;
        }
        if (typeof record.id !== "string" || typeof record.ok !== "boolean") return;
        const entry = this.pending.get(record.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(record.id);
        entry.resolve(
          record.ok
            ? { ok: true, result: (value as { result?: unknown }).result }
            : {
                ok: false,
                code: (value as { error?: { code?: string } }).error?.code ?? "internal",
                message: (value as { error?: { message?: string } }).error?.message ?? "request failed",
              },
        );
      });
      ws.addEventListener("close", (event) => {
        this.ws = null;
        // 在途请求必须结算：只清 timer 会让 Promise 永挂（调用方 await 卡死）。
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.resolve({ ok: false, code: "closed", message: "control channel closed" });
        }
        this.pending.clear();
        if (!this.closedByServer) {
          this.closedByServer = true;
          this.options.onClose?.({ code: event.code, reason: event.reason });
        }
        fail(new Error(`companion control channel closed before ready (${event.code})`));
      });
      ws.addEventListener("error", () => fail(new Error(`companion control channel failed: ${wsUrl}`)));
    });
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * 鉴权被拒特征（WS close 4401）：token 过期/撤销/设备吊销。
   * 调用方据此走静默刷新（HttpOnly refresh Cookie）而不是直接把用户踢回配对页。
   */
  static isAuthRejectedError(error: unknown): boolean {
    return error instanceof Error && error.message.includes("(4401)");
  }

  /** 心跳：单一在途 ping；watchdog 内无回包即主动断开（半开连接探测）。 */
  private startHeartbeat(): void {
    if (this.options.heartbeat === null) return;
    const intervalMs = this.options.heartbeat?.intervalMs ?? 10_000;
    const watchdogMs = this.options.heartbeat?.watchdogMs ?? 30_000;
    const schedule = (): void => {
      this.heartbeatTimer = setTimeout(() => {
        if (!this.isOpen() || this.pingInFlight) {
          schedule();
          return;
        }
        this.pingInFlight = true;
        void this.request("ping", undefined, watchdogMs).then((result) => {
          this.pingInFlight = false;
          if (!result.ok) {
            // 半开/已死链路：主动断开，走 onClose → 上层重连状态机。
            try {
              this.ws?.close();
            } catch {
              // no-op
            }
            return;
          }
          schedule();
        });
      }, intervalMs);
    };
    schedule();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.pingInFlight = false;
  }

  onEvent(listener: (event: CompanionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async catalog(): Promise<CompanionCatalogResult> {
    const result = await this.request("catalog", undefined);
    if (!result.ok) {
      throw new Error(`companion catalog failed: ${result.code}`);
    }
    const parsed = companionCatalogResultSchema.safeParse(result.result);
    if (!parsed.success) {
      throw new Error("companion catalog response malformed");
    }
    return parsed.data;
  }

  async attach(params: CompanionAttachParams): Promise<CompanionAttachResult> {
    const result = await this.request("attach", params);
    if (!result.ok) {
      throw new Error(`companion attach failed: ${result.code} ${result.message}`);
    }
    const parsed = companionAttachResultSchema.safeParse(result.result);
    if (!parsed.success) {
      throw new Error("companion attach response malformed");
    }
    return parsed.data;
  }

  async detach(params: CompanionDetachParams): Promise<void> {
    await this.request("detach", params);
  }

  /**
   * 打开数据面 relay 并返回 v4 会话数据层入口。
   * 首个文本帧 = relayCapability（一次性，网关消费后进入字节透传）。
   * channel 协议不期待服务端先发言，capability 发出即可组装客户端侧。
   */
  openRelayChannel(attachResult: CompanionAttachResult): Promise<CompanionRelayChannel> {
    const base = this.options.baseUrl.replace(/\/+$/, "");
    const relayUrl = `${base.replace(/^http/, "ws")}${attachResult.relayPath}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl);
      ws.binaryType = "arraybuffer";
      let settled = false;
      ws.addEventListener("open", () => {
        ws.send(attachResult.relayCapability);
        settled = true;
        const socket = wrapBrowserWebSocket(ws);
        const accessor = new RemoteServiceAccess(new ChannelClient(new SocketProtocol(socket)));
        resolve({
          attachmentId: attachResult.attachmentId,
          accessor,
          close: () => ws.close(),
          onClosed: (listener) => {
            ws.addEventListener("close", () => listener());
          },
        });
      });
      ws.addEventListener("close", (event) => {
        if (!settled) {
          settled = true;
          reject(new Error(`companion relay closed before ready (${event.code})`));
        }
      });
      ws.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          reject(new Error(`companion relay failed: ${relayUrl}`));
        }
      });
    });
  }

  close(): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.closedByServer = true; // 主动关闭不触发 onClose 语义
      this.ws.close();
      this.ws = null;
    }
  }

  private request(
    op: string,
    params?: unknown,
    timeoutMs = 15_000,
  ): Promise<{ ok: true; result?: unknown } | { ok: false; code: string; message: string }> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, code: "bad_request", message: "control channel not open" });
    }
    const id = `req-${++this.nextRequestId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ ok: false, code: "internal", message: `request timed out: ${op}` });
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      ws.send(JSON.stringify({ v: 1, id, op, ...(params !== undefined ? { params } : {}) }));
    });
  }
}
