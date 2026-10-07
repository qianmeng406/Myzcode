// 测试共享的内存 ControlStore（行为与 SqliteControlStore 对齐），供 hub/pairing 测试复用。
// 独立模块的原因：node:test 按 glob 执行文件，放在 *.test.ts 里会被其他测试 import 导致用例重复执行。
import type {
  CompanionDeviceRecord,
  CompanionNodeRecord,
} from "@zcode/shared/companion-protocol";
import type { CompanionDeviceGrants } from "../src/domain/grants.js";
import type {
  ControlStore,
  DeviceSecretKind,
  DeviceSecretRecord,
  PairingCodeRecord,
} from "../src/app/ports.js";

/** 行为与 SqliteControlStore 一致的内存实现：hub/pairing 逻辑测试用。 */
export class MemoryControlStore implements ControlStore {
  devices = new Map<string, CompanionDeviceRecord>();
  nodes = new Map<string, CompanionNodeRecord>();
  secrets = new Map<string, DeviceSecretRecord>();
  pairingCodes = new Map<string, PairingCodeRecord>();
  grants = new Map<string, CompanionDeviceGrants>();

  async listDevices(): Promise<CompanionDeviceRecord[]> {
    return [...this.devices.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async getDevice(deviceId: string): Promise<CompanionDeviceRecord | null> {
    return this.devices.get(deviceId) ?? null;
  }

  async saveDevice(record: CompanionDeviceRecord): Promise<void> {
    this.devices.set(record.deviceId, record);
  }

  async revokeDevice(deviceId: string, revokedAt: number): Promise<void> {
    const device = this.devices.get(deviceId);
    if (device) this.devices.set(deviceId, { ...device, revokedAt });
  }

  async listNodes(): Promise<CompanionNodeRecord[]> {
    return [...this.nodes.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async getNode(nodeId: string): Promise<CompanionNodeRecord | null> {
    return this.nodes.get(nodeId) ?? null;
  }

  async saveNode(record: CompanionNodeRecord): Promise<void> {
    this.nodes.set(record.nodeId, record);
  }

  async listSecrets(deviceId: string, kind: DeviceSecretKind): Promise<DeviceSecretRecord[]> {
    return [...this.secrets.values()].filter(
      (secret) => secret.deviceId === deviceId && secret.kind === kind,
    );
  }

  async putSecret(record: DeviceSecretRecord): Promise<void> {
    this.secrets.set(`${record.deviceId}:${record.kind}:${record.hash}`, record);
  }

  async deleteSecret(deviceId: string, kind: DeviceSecretKind, hash: string): Promise<void> {
    this.secrets.delete(`${deviceId}:${kind}:${hash}`);
  }

  async consumeSecret(deviceId: string, kind: DeviceSecretKind, hash: string): Promise<boolean> {
    const key = `${deviceId}:${kind}:${hash}`;
    const existed = this.secrets.has(key);
    this.secrets.delete(key);
    return existed;
  }

  async deleteSecrets(deviceId: string): Promise<void> {
    for (const [key, secret] of [...this.secrets.entries()]) {
      if (secret.deviceId === deviceId) this.secrets.delete(key);
    }
  }

  async putPairingCode(record: PairingCodeRecord): Promise<void> {
    this.pairingCodes.set(record.hash, record);
  }

  async consumePairingCode(hash: string, now: number): Promise<boolean> {
    const record = this.pairingCodes.get(hash);
    if (!record || record.usedAt !== null || record.expiresAt <= now) return false;
    this.pairingCodes.set(hash, { ...record, usedAt: now });
    return true;
  }

  async getGrants(deviceId: string): Promise<CompanionDeviceGrants | null> {
    return this.grants.get(deviceId) ?? null;
  }

  async saveGrants(grants: CompanionDeviceGrants): Promise<void> {
    this.grants.set(grants.deviceId, grants);
  }

  async close(): Promise<void> {}
}

