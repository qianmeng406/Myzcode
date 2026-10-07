import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSecretBox, systemClock } from "../src/adapters/secrets.js";
import { CompanionPairingService } from "../src/app/pairing.js";
import { MemoryControlStore } from "./memoryControlStore.js";

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

test("配对：码一次性消费 + 设备登记 + 凭证可鉴权", async () => {
  const store = new MemoryControlStore();
  const secrets = new NodeSecretBox();
  let now = 1_000_000;
  const clock = { now: () => now };
  const pairing = new CompanionPairingService({ store, secrets, clock, logger: noopLogger });

  await store.saveNode({
    nodeId: "cloud-1",
    kind: "cloud",
    displayName: "测试云端",
    tokenFingerprint: "f".repeat(64),
    createdAt: 1,
  });

  const issued = await pairing.createPairingCode();
  // 6 位数字码：人可抄录；安全依据 = 单次消费 + TTL + pair 端点限速。
  assert.match(issued.code, /^\d{6}$/);
  const paired = await pairing.pairDevice("我的手机", issued.code);
  assert.equal(paired.device.deviceName, "我的手机");

  // 同码第二次使用必须失败。
  await assert.rejects(
    () => pairing.pairDevice("第二台", issued.code),
    (error: unknown) => error instanceof Error && "code" in error,
  );

  const deviceId = await pairing.authenticateAccessToken(paired.accessToken);
  assert.equal(deviceId, paired.device.deviceId);

  // 过期 access 不能通过。
  now += 13 * 60 * 60 * 1000;
  const expired = await pairing.authenticateAccessToken(paired.accessToken);
  assert.equal(expired, null);

  // refresh 轮换：被使用的 refresh 失效，签发新对；旧 access 按自身 TTL 继续有效。
  now = 1_000_000;
  const refreshed = await pairing.refreshAccess(paired.refreshToken);
  assert.ok(refreshed.ok);
  if (refreshed.ok) {
    assert.equal(await pairing.authenticateAccessToken(paired.accessToken), paired.device.deviceId);
    assert.equal(await pairing.authenticateAccessToken(refreshed.accessToken), paired.device.deviceId);
    const reuse = await pairing.refreshAccess(paired.refreshToken);
    assert.equal(reuse.ok, false);
  }

  // 撤销设备：级联失效凭证。
  await pairing.revokeDevice(paired.device.deviceId);
  assert.equal(await pairing.authenticateAccessToken(refreshed.ok ? refreshed.accessToken : ""), null);
});

test("配对码过期不可用", async () => {
  const store = new MemoryControlStore();
  const secrets = new NodeSecretBox();
  let now = 1_000_000;
  const pairing = new CompanionPairingService({
    store,
    secrets,
    clock: { now: () => now },
    logger: noopLogger,
  });
  const issued = await pairing.createPairingCode();
  now += 16 * 60 * 1000;
  await assert.rejects(() => pairing.pairDevice("手机", issued.code));
});

test("SQLite 存储与内存语义一致（真实文件落盘）", async () => {
  const root = await mkdtemp(join(tmpdir(), "companion-store-"));
  try {
    const { SqliteControlStore } = await import("../src/adapters/sqliteControlStore.js");
    const store = new SqliteControlStore(join(root, "control.db"));
    const secrets = new NodeSecretBox();
    await store.saveNode({
      nodeId: "cloud-1",
      kind: "cloud",
      displayName: "云端",
      tokenFingerprint: secrets.sha256Hex("node-token"),
      createdAt: 1,
    });
    await store.saveDevice({
      deviceId: "dev-1",
      deviceName: "手机",
      createdAt: 2,
    });
    await store.saveGrants({ deviceId: "dev-1", nodes: [{ nodeId: "cloud-1", workspaceIdentities: [] }] });
    await store.putPairingCode({
      hash: "h1",
      expiresAt: 100,
      usedAt: null,
      issuedByNodeId: null,
      scopeWorkspaceIdentities: null,
    });
    assert.deepEqual(await store.consumePairingCode("h1", 50), {
      issuedByNodeId: null,
      scopeWorkspaceIdentities: null,
    });
    assert.equal(await store.consumePairingCode("h1", 51), null);
    assert.equal(await store.consumePairingCode("h1", 50), null);
    await store.putSecret({ deviceId: "dev-1", kind: "access", hash: "ah", expiresAt: 999 });
    assert.equal((await store.listSecrets("dev-1", "access")).length, 1);
    await store.deleteSecret("dev-1", "access", "ah");
    assert.equal((await store.listSecrets("dev-1", "access")).length, 0);
    await store.revokeDevice("dev-1", 3);
    const device = await store.getDevice("dev-1");
    assert.equal(device?.revokedAt, 3);
    assert.ok(await store.getNode("cloud-1"));
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("系统时钟与随机 token 基础性质", () => {
  const secrets = new NodeSecretBox();
  const token = secrets.randomToken(32);
  assert.equal(token.length, 43); // base64url(32 bytes)
  assert.notEqual(secrets.randomToken(32), token);
  assert.match(secrets.sha256Hex("abc"), /^[0-9a-f]{64}$/);
  assert.ok(systemClock.now() > 0);
});

test("refresh 并发重放：原子轮换下只有一个赢家", async () => {
  const store = new MemoryControlStore();
  const secrets = new NodeSecretBox();
  const clock = { now: () => 1_000_000 };
  const pairing = new CompanionPairingService({ store, secrets, clock, logger: noopLogger });
  await store.saveNode({ nodeId: "cloud-1", kind: "cloud", displayName: "本机云端", tokenFingerprint: "fp", createdAt: 1 });
  const codeIssued = await pairing.createPairingCode();
  const paired = await pairing.pairDevice("dev", codeIssued.code);

  // 同一 refresh 并发刷新：旧实现先查后删可双双成功；原子消费后恰一个赢家。
  const [first, second] = await Promise.all([
    pairing.refreshAccess(paired.refreshToken),
    pairing.refreshAccess(paired.refreshToken),
  ]);
  const winners = [first, second].filter((result) => result.ok);
  assert.equal(winners.length, 1);
  // 赢家签发的新 refresh 可继续轮换，输家的旧 token 已失效。
  const winner = winners[0]!;
  if (winner.ok) {
    const next = await pairing.refreshAccess(winner.refreshToken);
    assert.ok(next.ok);
  }
  assert.equal((await pairing.refreshAccess(paired.refreshToken)).ok, false);
});

test("节点签发的配对码只授予该节点（含工作区范围）", async () => {
  const store = new MemoryControlStore();
  const secrets = new NodeSecretBox();
  const pairing = new CompanionPairingService({
    store,
    secrets,
    clock: { now: () => 1_000_000 },
    logger: noopLogger,
  });
  await store.saveNode({ nodeId: "desktop-1", kind: "desktop", displayName: "家里电脑", tokenFingerprint: "fp-d", createdAt: 1 });
  await store.saveNode({ nodeId: "cloud-1", kind: "cloud", displayName: "云端", tokenFingerprint: "fp-c", createdAt: 2 });

  // 节点签发 + 声明工作区范围：grants 精确到该节点该范围，云节点不可见。
  const scoped = await pairing.createPairingCode({
    issuedByNodeId: "desktop-1",
    scopeWorkspaceIdentities: ["/srv/ws-a"],
  });
  const scopedPairing = await pairing.pairDevice("手机A", scoped.code);
  const scopedGrants = await store.getGrants(scopedPairing.device.deviceId);
  assert.deepEqual(scopedGrants?.nodes, [
    { nodeId: "desktop-1", workspaceIdentities: ["/srv/ws-a"] },
  ]);

  // 节点签发、未声明范围：该节点全部共享工作区（空 = all-shared），但不含其他节点。
  const unscoped = await pairing.createPairingCode({ issuedByNodeId: "desktop-1" });
  const unscopedPairing = await pairing.pairDevice("手机B", unscoped.code);
  const unscopedGrants = await store.getGrants(unscopedPairing.device.deviceId);
  assert.deepEqual(unscopedGrants?.nodes, [{ nodeId: "desktop-1", workspaceIdentities: [] }]);

  // owner（gateway 主机）签发：全部已登记未撤销节点。
  const ownerIssued = await pairing.createPairingCode();
  const ownerPairing = await pairing.pairDevice("手机C", ownerIssued.code);
  const ownerGrants = await store.getGrants(ownerPairing.device.deviceId);
  assert.deepEqual(
    ownerGrants?.nodes.map((entry) => entry.nodeId).sort(),
    ["cloud-1", "desktop-1"],
  );
});
