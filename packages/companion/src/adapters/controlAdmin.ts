// 控制面管理端口适配（无 HTTP、无 hub）：独立 CLI 进程与 serve 进程共享同一
// control SQLite 协同——配对码的单次消费由 SQL 层裁决（consumePairingCode），
// 因此 pair-code / register-node 不需要在 gateway 进程内执行。
// 秘密规则与 gateway 相同：明文只在创建时返回一次，库里只存 sha256 指纹。
import type { CompanionControlAdmin } from "../admin.js";
import { CompanionPairingService } from "../app/pairing.js";
import type { HubLogger } from "../app/ports.js";
import { NodeSecretBox, systemClock } from "./secrets.js";
import { SqliteControlStore } from "./sqliteControlStore.js";

export async function openCompanionControlAdmin(options: {
  controlDbPath: string;
  logger?: { info(message: string, details?: Record<string, unknown>): void; warn(message: string, details?: Record<string, unknown>): void; error(message: string, details?: Record<string, unknown>): void };
}): Promise<CompanionControlAdmin> {
  const logger: HubLogger = options.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const store = new SqliteControlStore(options.controlDbPath);
  const secrets = new NodeSecretBox();
  const pairing = new CompanionPairingService({ store, secrets, clock: systemClock, logger });
  return {
    createPairingCode: () => pairing.createPairingCode(),
    registerNode: async ({ nodeId, displayName, kind }) => {
      const token = secrets.randomToken(32);
      await store.saveNode({
        nodeId,
        kind,
        displayName,
        tokenFingerprint: secrets.sha256Hex(token),
        createdAt: systemClock.now(),
      });
      return { nodeId, token };
    },
    listDevices: () => store.listDevices(),
    revokeDevice: (deviceId) => pairing.revokeDevice(deviceId),
    revokeNode: async (nodeId) => {
      const record = await store.getNode(nodeId);
      if (!record || record.revokedAt !== undefined) return false;
      await store.saveNode({ ...record, revokedAt: systemClock.now() });
      return true;
    },
    close: () => store.close(),
  };
}
