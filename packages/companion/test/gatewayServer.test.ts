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

test("限速来源键：伪造 XFF 第一跳不得分桶，X-Real-IP 才是权威", async () => {
  const root = tempRoot();
  try {
    const gateway = await startCompanionGatewayServer({
      port: 0,
      controlDbPath: join(root, "control.db"),
      pairRateLimit: { windowMs: 60_000, maxAttempts: 2 },
    });
    try {
      const url = `http://127.0.0.1:${gateway.port}/companion/pair`;
      const pair = (headers: Record<string, string>): Promise<number> =>
        fetch(url, {
          method: "POST",
          headers: { ...CSRF_HEADERS, ...headers },
          body: JSON.stringify({ deviceName: "d", code: "bad" }),
        }).then(async (response) => {
          await response.arrayBuffer();
          return response.status;
        });
      // 每次伪造不同的 XFF 第一跳：旧实现按第一跳分桶 → 永不 429。
      // 新实现忽略第一跳（无 X-Real-IP 时取 XFF 最后一跳 = 本机回环）。
      const forged: number[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        forged.push(await pair({ "x-forwarded-for": `10.0.0.${attempt + 1}, 127.0.0.1` }));
      }
      assert.deepEqual(forged, [400, 400, 429, 429]);
      // X-Real-IP 优先且按其分桶：换个真实 IP 桶重新计数。
      const otherIp = await pair({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9" });
      assert.equal(otherIp, 400);
    } finally {
      await gateway.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("节点配对码端点：CSRF 缺失 403、令牌错误 401、有效令牌发码、撤销节点 401", async () => {
  const root = tempRoot();
  try {
    const gateway = await startCompanionGatewayServer({
      port: 0,
      controlDbPath: join(root, "control.db"),
    });
    try {
      const base = `http://127.0.0.1:${gateway.port}`;
      const register = await gateway.owner.registerNode({
        nodeId: "desktop-1",
        displayName: "家里电脑",
        kind: "desktop",
      });
      const issue = async (token: string, extraHeaders: Record<string, string> = {}): Promise<{
        status: number;
        body: Record<string, unknown>;
      }> => {
        const response = await fetch(`${base}/companion/nodes/pair-code`, {
          method: "POST",
          headers: {
            "x-zcode-companion": "my-zcode",
            authorization: `Bearer ${token}`,
            ...extraHeaders,
          },
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      };
      // 有效令牌 → 6 位一次性码 + 节点信息
      const ok = await issue(register.token);
      assert.equal(ok.status, 200);
      assert.match(String(ok.body.code), /^\d{6}$/);
      assert.equal(ok.body.nodeId, "desktop-1");
      assert.equal(ok.body.displayName, "家里电脑");
      // 错误令牌 → 401（日志只落指纹）
      const bad = await issue("totally-invalid-token");
      assert.equal(bad.status, 401);
      // 撤销节点后同令牌 → 401
      await gateway.owner.revokeNode("desktop-1");
      const revoked = await issue(register.token);
      assert.equal(revoked.status, 401);
      // owner 撤销即时生效：revokeNode 已同步关闭（这里无在线链路，仅语义回归）
      assert.equal(await gateway.owner.revokeNode("desktop-1"), false);
    } finally {
      await gateway.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
