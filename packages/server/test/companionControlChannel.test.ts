// 节点控制通道心跳测试：ping 往返保活 + watchdog 半开连接主动断开。
// 用真实 WebSocketServer 走完整 wire（首帧 auth → 心跳 ping/pong），
// 并断言 ping 帧确实到达服务端（防止「从未发送→空洞通过」）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { connectControlChannel } from "../src/companion/controlChannel.js";

interface ServerHarness {
  url: string;
  close(): Promise<void>;
  /** 控制是否应答节点 ping。 */
  setAnswerPing(answer: boolean): void;
  /** 服务端收到的 ping 帧次数。 */
  pingCount(): number;
}

async function startGatewayLikeServer(): Promise<ServerHarness> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let answerPing = true;
  let pings = 0;
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (data) => {
      let frame: { id?: unknown; op?: unknown };
      try {
        frame = JSON.parse(String(data)) as { id?: unknown; op?: unknown };
      } catch {
        return;
      }
      if (frame.op === "auth") {
        socket.send(JSON.stringify({ v: 1, id: frame.id, ok: true }));
        return;
      }
      if (frame.op === "ping") {
        pings += 1;
        if (answerPing) socket.send(JSON.stringify({ v: 1, id: frame.id, ok: true }));
        // 不应答 = 模拟反代静默摘除后的半开连接。
        return;
      }
      socket.send(
        JSON.stringify({ v: 1, id: frame.id, ok: false, error: { code: "unknown_op", message: "test" } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${port}`,
    setAnswerPing: (answer: boolean) => {
      answerPing = answer;
    },
    pingCount: () => pings,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

test("心跳：ping 帧确实发出且收到回包，连接保持", async () => {
  const harness = await startGatewayLikeServer();
  try {
    let disconnected: string | null = null;
    const control = await connectControlChannel(
      harness.url,
      "node-token",
      (reason) => {
        disconnected = reason;
      },
      { intervalMs: 20, watchdogMs: 500 },
    );
    // 心跳跑 ~10 个周期，全部正常应答 → 不应断开。
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(disconnected, null);
    // 非空洞断言：服务端必须真的收到多帧 ping（250ms / 20ms ≥ 5）。
    assert.ok(harness.pingCount() >= 5, `expect >=5 pings at server, got ${harness.pingCount()}`);
    control.close();
  } finally {
    await harness.close();
  }
});

test("watchdog：ping 无回包（半开/被反代摘除）→ 主动断开并上报", async () => {
  const harness = await startGatewayLikeServer();
  try {
    harness.setAnswerPing(false);
    const disconnected = new Promise<string>((resolve) => {
      void connectControlChannel(
        harness.url,
        "node-token",
        (reason) => resolve(reason),
        { intervalMs: 20, watchdogMs: 120 },
      ).then((control) => {
        assert.equal(typeof control.send, "function");
      });
    });
    const reason = await Promise.race([
      disconnected,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("watchdog 未触发")), 3000)),
    ]);
    assert.ok(reason.length > 0, "onDisconnected 必须携带原因");
    // 半开判定前提：ping 确实发出过（否则是别的原因断开）。
    assert.ok(harness.pingCount() >= 1, "ping 帧应已发出");
  } finally {
    await harness.close();
  }
});

test("鉴权失败快速 reject（不走心跳路径）", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { id?: unknown };
      socket.send(JSON.stringify({ v: 1, id: frame.id, ok: false, error: { code: "unauthorized", message: "bad token" } }));
    });
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  try {
    await assert.rejects(
      connectControlChannel(`ws://127.0.0.1:${port}`, "bad", () => undefined, { intervalMs: 20, watchdogMs: 100 }),
      /rejected node auth/,
    );
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
