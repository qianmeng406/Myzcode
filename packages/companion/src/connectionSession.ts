// 控制面连接会话所有者（app 层，框架无关）：UI 层（手机壳/浏览器完整 UI）
// 共用同一个连接；路由切换/组件重建不再各建一条互相清理的控制链路。
// 职责：单一 in-flight 连接、指数退避（full jitter）自动重连、access 过期
// 静默刷新（一次/掉线情节）、前台恢复即时探测（nudge）、authExpired 终态。
// 数据面（relay/attachment）不归本模块：掉线时网关已按链路身份拆除，
// UI 层以连接代次（epoch）驱动 re-attach 与订阅重建。
import type { CompanionEvent } from "@zcode/shared/companion-protocol";
import { CompanionClient } from "./client.js";

export type ConnectionSessionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "authExpired"
  | "stopped";

export interface CloseEventLike {
  code: number;
  reason: string;
}

export interface SessionClientLike {
  connect(): Promise<void>;
  close(): void;
  isOpen(): boolean;
  onEvent(listener: (event: CompanionEvent) => void): () => void;
}

export interface ConnectionSessionOptions {
  baseUrl: string;
  accessToken: string;
  /** 静默刷新（WebView 走 HttpOnly refresh Cookie）；缺省 = 不刷新，鉴权失败即 authExpired。 */
  refresh?: (baseUrl: string) => Promise<string>;
  onStateChange?: (state: ConnectionSessionState, context: { attempt: number }) => void;
  onEvent?: (event: CompanionEvent) => void;
  /** 测试注入；缺省用真实 CompanionClient（心跳默认开启）。 */
  clientFactory?: (
    accessToken: string,
    onClose: (event: CloseEventLike) => void,
  ) => SessionClientLike;
  backoff?: { baseMs?: number; maxMs?: number };
}

interface Waiter {
  resolve: (client: SessionClientLike) => void;
  reject: (error: Error) => void;
}

export class CompanionConnectionSession {
  private client: SessionClientLike | null = null;
  private accessToken: string;
  private state: ConnectionSessionState = "stopped";
  private attempt = 0;
  private refreshedThisEpisode = false;
  private connecting = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly waiters: Waiter[] = [];
  private readonly baseMs: number;
  private readonly maxMs: number;

  constructor(private readonly options: ConnectionSessionOptions) {
    this.accessToken = options.accessToken;
    this.baseMs = options.backoff?.baseMs ?? 1_000;
    this.maxMs = options.backoff?.maxMs ?? 30_000;
  }

  /** 幂等启动：首次连接与断线后的重连都走这里。 */
  start(): void {
    if (this.stopped) return;
    this.setState("connecting");
    void this.attemptConnect();
  }

  /** 需要已连接的 client 时调用；reconnecting 中则等待本轮重连结果。 */
  ensureConnected(): Promise<SessionClientLike> {
    if (this.state === "connected" && this.client !== null) return Promise.resolve(this.client);
    if (this.state === "authExpired" || this.state === "stopped") {
      return Promise.reject(new Error(`connection session ${this.state}`));
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  getState(): ConnectionSessionState {
    return this.state;
  }

  /**
   * 前台恢复/网络恢复时的即时探测：重连等待中则取消本轮延迟立即尝试
   * （单一 in-flight 由 connecting 标志保证，不产生平行重连循环）。
   */
  nudge(): void {
    if (this.stopped || this.state !== "reconnecting") return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.connecting) void this.attemptConnect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.client?.close();
    this.client = null;
    this.rejectWaiters(new Error("connection session stopped"));
    this.setState("stopped");
  }

  // ── 内部 ──

  private async attemptConnect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    const wasReconnect = this.attempt > 0;
    this.setState(wasReconnect ? "reconnecting" : "connecting");
    const client = this.buildClient();
    try {
      await client.connect();
    } catch (error) {
      this.connecting = false;
      client.close();
      await this.handleConnectFailure(error);
      return;
    }
    this.connecting = false;
    this.client = client;
    this.attempt = 0;
    this.refreshedThisEpisode = false;
    this.setState("connected");
    this.resolveWaiters(client);
  }

  private async handleConnectFailure(error: unknown): Promise<void> {
    if (this.stopped) return;
    // 鉴权被拒：每个掉线情节先静默刷新一次（refresh 失败或刷新后仍被拒 = authExpired）。
    if (CompanionClient.isAuthRejectedError(error)) {
      if (!this.refreshedThisEpisode && this.options.refresh) {
        this.refreshedThisEpisode = true;
        try {
          this.accessToken = await this.options.refresh(this.options.baseUrl);
        } catch {
          this.failAuthExpired();
          return;
        }
        void this.attemptConnect();
        return;
      }
      this.failAuthExpired();
      return;
    }
    // 普通失败：指数退避（full jitter）继续重连，不放弃。
    const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt += 1;
    const delay = Math.floor(Math.random() * ceiling);
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptConnect();
    }, delay);
  }

  /** 掉线（服务端关闭/心跳 watchdog/网络断）：进入重连状态机。
   * 只处理已建立连接的掉线——首连失败由 handleConnectFailure 统一调度，
   * 否则 close 事件与 connect() 拒绝会各排一个重连计时器。 */
  private handleClosed(_event: CloseEventLike): void {
    if (this.stopped || this.state !== "connected") return;
    this.client = null;
    this.connecting = false;
    this.rejectWaiters(new Error("companion control channel closed"));
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt += 1;
    const delay = Math.floor(Math.random() * ceiling);
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptConnect();
    }, delay);
  }

  private buildClient(): SessionClientLike {
    if (this.options.clientFactory) {
      return this.options.clientFactory(this.accessToken, (event) => this.handleClosed(event));
    }
    return new CompanionClient({
      baseUrl: this.options.baseUrl,
      accessToken: this.accessToken,
      onEvent: this.options.onEvent,
      onClose: (event) => this.handleClosed(event),
    });
  }

  private failAuthExpired(): void {
    this.client?.close();
    this.client = null;
    this.rejectWaiters(new Error("companion access expired; re-pairing required"));
    this.setState("authExpired");
  }

  private resolveWaiters(client: SessionClientLike): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const waiter of pending) waiter.resolve(client);
  }

  private rejectWaiters(error: Error): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const waiter of pending) waiter.reject(error);
  }

  private setState(state: ConnectionSessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state, { attempt: this.attempt });
  }
}
