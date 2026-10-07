// companion.json 节点令牌加密存储回归：cipher 往返 / 明文迁移 / 解密失败降级。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  companionConfigPath,
  isEncryptedTokenPayload,
  loadCompanionConfig,
  saveCompanionConfig,
  upgradeCompanionConfigTokenStorage,
  type CompanionTokenCipher,
} from "../src/main/companion/companionConfig.js";

/** 与 safeStorage 同形韵的假 cipher：前缀 + 可逆变换（测试无 electron 依赖）。 */
const fakeCipher: CompanionTokenCipher = {
  encrypt: (plain) => `enc:v1:${Buffer.from(plain, "utf8").toString("base64")}`,
  decrypt: (payload) => {
    if (!isEncryptedTokenPayload(payload)) return null;
    try {
      return Buffer.from(payload.slice("enc:v1:".length), "base64").toString("utf8");
    } catch {
      return null;
    }
  },
};

const BASE_CONFIG = {
  enabled: true,
  gatewayUrl: "wss://gateway.example.com",
  nodeToken: "node-token-plain-secret",
  allowedWorkspaces: ["/srv/ws"],
};

test("有 cipher：令牌密文落盘，load 解密还原", async () => {
  const root = await mkdtemp(join(tmpdir(), "companion-cfg-"));
  try {
    await saveCompanionConfig(root, BASE_CONFIG, fakeCipher);
    const raw = await readFile(companionConfigPath(root), "utf8");
    assert.ok(!raw.includes(BASE_CONFIG.nodeToken), "明文令牌不得出现在落盘 JSON");
    const loaded = await loadCompanionConfig(root, fakeCipher);
    assert.equal(loaded.nodeToken, BASE_CONFIG.nodeToken);
    assert.equal(loaded.enabled, true);
    assert.deepEqual(loaded.allowedWorkspaces, BASE_CONFIG.allowedWorkspaces);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("升级路径：明文旧配置一次性迁移为密文", async () => {
  const root = await mkdtemp(join(tmpdir(), "companion-cfg-"));
  try {
    await saveCompanionConfig(root, BASE_CONFIG); // 旧版本明文
    await upgradeCompanionConfigTokenStorage(root, fakeCipher);
    const raw = await readFile(companionConfigPath(root), "utf8");
    assert.ok(!raw.includes(BASE_CONFIG.nodeToken));
    assert.equal((await loadCompanionConfig(root, fakeCipher)).nodeToken, BASE_CONFIG.nodeToken);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("无 cipher 读取密文配置 → 令牌按不可用清空（不崩、其余字段保留）", async () => {
  const root = await mkdtemp(join(tmpdir(), "companion-cfg-"));
  try {
    await saveCompanionConfig(root, BASE_CONFIG, fakeCipher);
    const loaded = await loadCompanionConfig(root);
    assert.equal(loaded.nodeToken, "");
    assert.equal(loaded.enabled, true);
    assert.equal(loaded.gatewayUrl, BASE_CONFIG.gatewayUrl);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
