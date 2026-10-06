// gateway HTTP 面集成测试：pair 限速、trustForwardedProto 的 Secure cookie、
// controlAdmin 跨进程铸码（同一 SQLite、两个独立"进程面"协同）。
// 用真实 startCompanionGatewayServer（随机端口）+ fetch 打端点。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openCompanionControlAdmin } from "../src/admin.js";
import { startCompanionGatewayServer } from "../src/adapters/gatewayServer.js";

const CSRF_HEADERS = {
  "content-type": "application/json",
  "x-zcode-companion": "my-zcode",
};

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "companion-gw-test-"));
}

test("pair 限速：窗口内超过上限返回 429", async () => {
  const root = tempRoot();
  try {
    const gateway = await startCompanionGatewayServer({
      port: 0,
      controlDbPath: join(root, "control.db"),
      pairRateLimit: { windowMs: 60_000, maxAttempts: 3 },
    });
    try {
      const url = `http://127.0.0.1:${gateway.port}/companion/pair`;
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await fetch(url, {
          method: "POST",
          headers: CSRF_HEADERS,
          body: JSON.stringify({ deviceName: "d", code: "bad" }),
        });
        statuses.push(response.status);
        await response.arrayBuffer();
      }
      // 前三次是无效码（400 计数），第 4 次起被限速（429）。
      assert.deepEqual(statuses.slice(0, 3), [400, 400, 400]);
      assert.equal(statuses[3], 429);
      assert.equal(statuses[4], 429);
    } finally {
      await gateway.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trustForwardedProto：X-Forwarded-Proto: https 时 refresh cookie 带 Secure", async () => {
  const root = tempRoot();
  try {
    const controlDbPath = join(root, "control.db");
    const gateway = await startCompanionGatewayServer({
      port: 0,
      controlDbPath,
      allowedOrigins: [],
      trustForwardedProto: true,
    });
    try {
      // 跨"进程"面铸码：admin 面与 gateway 面共享同一 SQLite（pair-code CLI 的形态）。
      const admin = await openCompanionControlAdmin({ controlDbPath });
      const issued = await admin.createPairingCode();
      await admin.close();

      const response = await fetch(`http://127.0.0.1:${gateway.port}/companion/pair`, {
        method: "POST",
        headers: { ...CSRF_HEADERS, "x-forwarded-proto": "https" },
        body: JSON.stringify({ deviceName: "phone", code: issued.code }),
      });
      assert.equal(response.status, 200);
      const cookie = response.headers.get("set-cookie") ?? "";
      assert.ok(cookie.includes("Secure"), `cookie should be Secure, got: ${cookie}`);
      const body = (await response.json()) as { accessToken: string; deviceId: string };
      assert.ok(body.accessToken.length > 0);
    } finally {
      await gateway.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("默认（不信任转发头）：直连 http 不下发 Secure", async () => {
  const root = tempRoot();
  try {
    const controlDbPath = join(root, "control.db");
    const gateway = await startCompanionGatewayServer({ port: 0, controlDbPath });
    try {
      const admin = await openCompanionControlAdmin({ controlDbPath });
      const issued = await admin.createPairingCode();
      await admin.close();
      const response = await fetch(`http://127.0.0.1:${gateway.port}/companion/pair`, {
        method: "POST",
        headers: { ...CSRF_HEADERS, "x-forwarded-proto": "https" },
        body: JSON.stringify({ deviceName: "phone", code: issued.code }),
      });
      assert.equal(response.status, 200);
      const cookie = response.headers.get("set-cookie") ?? "";
      assert.equal(cookie.includes("Secure"), false);
    } finally {
      await gateway.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
