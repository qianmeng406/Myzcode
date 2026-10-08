// wsLinks 适配层测试：节点链路 request 帧（ping 应答/未知 op 快速失败）与
// relay 协议层保活 ping。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompanionHub } from "../src/app/hub.js";
import type { HubLogger, RelayJoin } from "../src/app/ports.js";
import { attachRelaySocket, createNodeLink } from "../src/adapters/wsLinks.js";

const noopLogger: HubLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface Frame {
  kind: "request" | "response" | "event";
  raw: Record<string, unknown>;
}

/** 最小 ws 桩：EventEmitter 风格 on/send/close/ping，记录出站帧。 */
class FakeWebSocket {
  /** ws 库的常量（sendJson 等以 ws.OPEN 判定就绪，桩必须提供）。 */
  static readonly OPEN = 1;
  readonly OPEN = FakeWebSocket.OPEN;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  pingCount = 0;
  closed = false;
  private listeners = new Map<string, Array<(data?: unknown, isBinary?: boolean) => void>>();

  on(event: string, listener: (data?: unknown, isBinary?: boolean) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  send(data: unknown): void {
    this.sent.push(String(data));
  }

  ping(): void {
    this.pingCount += 1;
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  terminate(): void {
    this.closed = true;
    this.emit("close");
  }

  emit(event: string, data?: unknown, isBinary?: boolean): void {
    for (const listener of this.listeners.get(event) ?? []) listener(data, isBinary);
  }

  /** 模拟对端发来一帧控制面 JSON。 */
  receive(raw: Record<string, unknown>): void {
    this.emit("message", JSON.stringify(raw), false);
  }

  frames(): Frame[] {
    return this.sent
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((raw) => {
        if (typeof raw.ok === "boolean") return { kind: "response" as const, raw };
        if (typeof raw.event === "string") return { kind: "event" as const, raw };
        return { kind: "request" as const, raw };
      });
  }
}

function makeHub(): CompanionHub {
  const hub = {
    handleNodeClosed: () => undefined,
    handleNodeWorkspaces: () => undefined,
    handleRelayJoin: () => true,
  } as unknown as CompanionHub;
  return hub;
}

test("createNodeLink：节点侧 ping 请求收到 ok 回执（反代空闲保活）", () => {
  const ws = new FakeWebSocket();
  createNodeLink({ ws: ws as never, nodeId: "desktop-1", hub: makeHub(), logger: noopLogger });

  ws.receive({ v: 1, id: "ping-1", op: "ping" });

  const responses = ws.frames().filter((frame) => frame.kind === "response");
  assert.equal(responses.length, 1);
  assert.equal(responses[0].raw.id, "ping-1");
  assert.equal(responses[0].raw.ok, true);
});

test("createNodeLink：未知 op 快速失败（不静默丢弃，connector 可感知）", () => {
  const ws = new FakeWebSocket();
  createNodeLink({ ws: ws as never, nodeId: "desktop-1", hub: makeHub(), logger: noopLogger });

  ws.receive({ v: 1, id: "req-1", op: "definitely-unknown" });

  const responses = ws.frames().filter((frame) => frame.kind === "response");
  assert.equal(responses.length, 1);
  assert.equal(responses[0].raw.ok, false);
  assert.equal((responses[0].raw.error as { code?: string }).code, "unknown_op");
});

test("attachRelaySocket：鉴权后周期发协议层 ping，close 后停止", async () => {
  const ws = new FakeWebSocket();
  const joins: RelayJoin[] = [];
  const hub = {
    handleRelayJoin: (join: RelayJoin) => {
      joins.push(join);
      return true;
    },
  } as unknown as CompanionHub;

  attachRelaySocket({ ws: ws as never, attachmentId: "att-1", hub, keepaliveIntervalMs: 20 });

  // 首帧 capability 完成鉴权前不发 ping。
  assert.equal(ws.pingCount, 0);
  ws.emit("message", "cap-token", false);
  assert.equal(joins.length, 1);

  let pingedWhileOpen = -1;
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    pingedWhileOpen = ws.pingCount;
    assert.ok(pingedWhileOpen >= 2, `expect periodic pings, got ${ws.pingCount}`);
  } finally {
    // 保活 interval 必须停，否则测试进程无法退出。
    ws.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(ws.pingCount, pingedWhileOpen, "ping 应在 close 后停止");
});
