// ConnectionSession 状态机回归：首连/掉线重连退避/鉴权静默刷新/nudge/停止。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompanionEvent } from "@zcode/shared/companion-protocol";
import { CompanionConnectionSession, type SessionClientLike } from "../src/connectionSession.js";

class FakeClient implements SessionClientLike {
  private eventListeners = new Set<(event: CompanionEvent) => void>();
  onClose: ((event: { code: number; reason: string }) => void) | null = null;
  connectAttempts = 0;
  closed = false;

  constructor(
    private readonly shared: { connectAttempts: number; authFailures: number },
    private readonly onFirstConnect?: (client: FakeClient) => void,
  ) {}

  connect(): Promise<void> {
    this.connectAttempts += 1;
    this.shared.connectAttempts += 1;
    // 跨实例计数：authFailures 次鉴权拒绝之后，后续连接（含刷新后的重试）都成功。
    if (this.shared.connectAttempts <= this.shared.authFailures) {
      return Promise.reject(new Error("companion control channel closed before ready (4401)"));
    }
    this.onFirstConnect?.(this);
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
  }

  isOpen(): boolean {
    return !this.closed;
  }

  onEvent(listener: (event: CompanionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** 模拟已建立连接被服务端/网络断开。 */
  drop(): void {
    this.closed = true;
    this.onClose?.({ code: 1006, reason: "abnormal" });
  }
}

interface Harness {
  session: CompanionConnectionSession;
  states: Array<{ state: string; attempt: number }>;
  clients: FakeClient[];
  refreshCalls: number;
  refreshShouldFail: boolean;
  timers: Array<() => void>;
}

function makeHarness(options?: {
  authFailures?: number;
  refreshShouldFail?: boolean;
}): Harness {
  const states: Array<{ state: string; attempt: number }> = [];
  const clients: FakeClient[] = [];
  let refreshCalls = 0;
  const shared = { connectAttempts: 0, authFailures: options?.authFailures ?? 0 };
  const harness: Harness = {
    states,
    clients,
    refreshCalls: 0,
    refreshShouldFail: options?.refreshShouldFail === true,
    timers: [],
  };
  const session = new CompanionConnectionSession({
    baseUrl: "https://gateway.example.com",
    accessToken: "tok",
    backoff: { baseMs: 5, maxMs: 20 },
    refresh: async () => {
      refreshCalls += 1;
      harness.refreshCalls = refreshCalls;
      if (harness.refreshShouldFail) throw new Error("refresh rejected");
      return "tok-2";
    },
    onStateChange: (state, context) => states.push({ state, attempt: context.attempt }),
    clientFactory: (accessToken, onClose) => {
      const client = new FakeClient(shared, (self) => {
        self.onClose = onClose;
      });
      void accessToken;
      clients.push(client);
      return client;
    },
  });
  harness.session = session;
  return harness;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("首连成功 → connected，ensureConnected 解析同一 client", async () => {
  const { session, clients } = makeHarness();
  session.start();
  const client = await session.ensureConnected();
  assert.equal(clients.indexOf(client as FakeClient) >= 0, true);
  assert.equal(session.getState(), "connected");
  session.stop();
});

test("已建立连接掉线 → 自动重连恢复 connected（新 client 实例）", async () => {
  const { session, clients, states } = makeHarness();
  session.start();
  await session.ensureConnected();
  const first = clients[0]!;
  first.drop();
  assert.equal(session.getState(), "reconnecting");
  // 退避上限 20ms：等待后恢复。
  const second = await session.ensureConnected();
  assert.notEqual(second, first);
  assert.equal(session.getState(), "connected");
  assert.ok(states.some((entry) => entry.state === "reconnecting"));
  session.stop();
});

test("首连 4401 → 静默刷新一次后用新 token 连接成功", async () => {
  const harness = makeHarness({ authFailures: 1 });
  harness.session.start();
  await harness.session.ensureConnected();
  assert.equal(harness.refreshCalls, 1);
  assert.equal(harness.clients.length, 2); // 失败一次 + 刷新后重试
  assert.equal(harness.session.getState(), "connected");
  harness.session.stop();
});

test("刷新也失败 → authExpired 终态，ensureConnected 拒绝且不再重试", async () => {
  const { session, clients, states } = makeHarness({ authFailures: 1, refreshShouldFail: true });
  session.start();
  await assert.rejects(() => session.ensureConnected(), /re-pairing/);
  assert.equal(session.getState(), "authExpired");
  assert.equal(clients.length, 1);
  await wait(30);
  assert.ok(!states.slice(-1).some((entry) => entry.state === "reconnecting"));
  session.stop();
});

test("nudge：重连等待中立即探测（提前于退避计时器）", async () => {
  const { session, clients } = makeHarness();
  session.start();
  await session.ensureConnected();
  clients[0]!.drop();
  assert.equal(session.getState(), "reconnecting");
  session.nudge();
  await session.ensureConnected();
  assert.equal(session.getState(), "connected");
  session.stop();
});

test("stop：清理计时器与 client，后续 ensureConnected 拒绝", async () => {
  const { session } = makeHarness();
  session.start();
  await session.ensureConnected();
  session.stop();
  assert.equal(session.getState(), "stopped");
  await assert.rejects(() => session.ensureConnected(), /stopped/);
});
