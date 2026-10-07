// 控制元数据 SQLite 存储（node:sqlite）。只存登记/授权/凭证指纹/配对码，
// 不存任务、会话或任何业务状态（specs/companion-gateway.md §3）。
import { DatabaseSync } from "node:sqlite";
import type {
  CompanionDeviceRecord,
  CompanionNodeRecord,
} from "@zcode/shared/companion-protocol";
import type { CompanionDeviceGrants } from "../domain/grants.js";
import type {
  ControlStore,
  DeviceSecretKind,
  DeviceSecretRecord,
  PairingCodeRecord,
} from "../app/ports.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS device_secrets (
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  token_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS device_grants (
  device_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL
);
`;

export class SqliteControlStore implements ControlStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  async listDevices(): Promise<CompanionDeviceRecord[]> {
    const rows = this.db
      .prepare("SELECT device_id, device_name, created_at, revoked_at, last_seen_at FROM devices ORDER BY created_at")
      .all() as Array<{
      device_id: string;
      device_name: string;
      created_at: number;
      revoked_at: number | null;
      last_seen_at: number | null;
    }>;
    return rows.map((row) => ({
      deviceId: row.device_id,
      deviceName: row.device_name,
      createdAt: row.created_at,
      ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
      ...(row.last_seen_at !== null ? { lastSeenAt: row.last_seen_at } : {}),
    }));
  }

  async getDevice(deviceId: string): Promise<CompanionDeviceRecord | null> {
    const row = this.db
      .prepare("SELECT device_id, device_name, created_at, revoked_at, last_seen_at FROM devices WHERE device_id = ?")
      .get(deviceId) as
      | { device_id: string; device_name: string; created_at: number; revoked_at: number | null; last_seen_at: number | null }
      | undefined;
    if (!row) return null;
    return {
      deviceId: row.device_id,
      deviceName: row.device_name,
      createdAt: row.created_at,
      ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
      ...(row.last_seen_at !== null ? { lastSeenAt: row.last_seen_at } : {}),
    };
  }

  async saveDevice(record: CompanionDeviceRecord): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO devices (device_id, device_name, created_at, revoked_at, last_seen_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(device_id) DO UPDATE SET device_name = excluded.device_name, revoked_at = excluded.revoked_at, last_seen_at = excluded.last_seen_at",
      )
      .run(
        record.deviceId,
        record.deviceName,
        record.createdAt,
        record.revokedAt ?? null,
        record.lastSeenAt ?? null,
      );
  }

  async revokeDevice(deviceId: string, revokedAt: number): Promise<void> {
    this.db.prepare("UPDATE devices SET revoked_at = ? WHERE device_id = ?").run(revokedAt, deviceId);
  }

  async listNodes(): Promise<CompanionNodeRecord[]> {
    const rows = this.db
      .prepare("SELECT node_id, kind, display_name, token_fingerprint, created_at, revoked_at FROM nodes ORDER BY created_at")
      .all() as Array<{
      node_id: string;
      kind: string;
      display_name: string;
      token_fingerprint: string;
      created_at: number;
      revoked_at: number | null;
    }>;
    return rows.map((row) => ({
      nodeId: row.node_id,
      kind: row.kind === "cloud" ? "cloud" : "desktop",
      displayName: row.display_name,
      tokenFingerprint: row.token_fingerprint,
      createdAt: row.created_at,
      ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
    }));
  }

  async getNode(nodeId: string): Promise<CompanionNodeRecord | null> {
    const row = this.db
      .prepare("SELECT node_id, kind, display_name, token_fingerprint, created_at, revoked_at FROM nodes WHERE node_id = ?")
      .get(nodeId) as
      | { node_id: string; kind: string; display_name: string; token_fingerprint: string; created_at: number; revoked_at: number | null }
      | undefined;
    if (!row) return null;
    return {
      nodeId: row.node_id,
      kind: row.kind === "cloud" ? "cloud" : "desktop",
      displayName: row.display_name,
      tokenFingerprint: row.token_fingerprint,
      createdAt: row.created_at,
      ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
    };
  }

  async saveNode(record: CompanionNodeRecord): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO nodes (node_id, kind, display_name, token_fingerprint, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(node_id) DO UPDATE SET kind = excluded.kind, display_name = excluded.display_name, token_fingerprint = excluded.token_fingerprint, revoked_at = excluded.revoked_at",
      )
      .run(
        record.nodeId,
        record.kind,
        record.displayName,
        record.tokenFingerprint,
        record.createdAt,
        record.revokedAt ?? null,
      );
  }

  async listSecrets(deviceId: string, kind: DeviceSecretKind): Promise<DeviceSecretRecord[]> {
    const rows = this.db
      .prepare("SELECT device_id, kind, hash, expires_at FROM device_secrets WHERE device_id = ? AND kind = ?")
      .all(deviceId, kind) as Array<{ device_id: string; kind: string; hash: string; expires_at: number }>;
    return rows.map((row) => ({
      deviceId: row.device_id,
      kind: row.kind === "refresh" ? "refresh" : "access",
      hash: row.hash,
      expiresAt: row.expires_at,
    }));
  }

  async putSecret(record: DeviceSecretRecord): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO device_secrets (device_id, kind, hash, expires_at) VALUES (?, ?, ?, ?)")
      .run(record.deviceId, record.kind, record.hash, record.expiresAt);
  }

  async deleteSecret(deviceId: string, kind: DeviceSecretKind, hash: string): Promise<void> {
    this.db
      .prepare("DELETE FROM device_secrets WHERE device_id = ? AND kind = ? AND hash = ?")
      .run(deviceId, kind, hash);
  }

  async consumeSecret(deviceId: string, kind: DeviceSecretKind, hash: string): Promise<boolean> {
    // 原子单次消费：DELETE 带 WHERE 条件，changes===1 才算本次调用者消费成功。
    // 并发重放同一 refresh 时只有一个请求删得掉，其余按失效处理。
    const result = this.db
      .prepare("DELETE FROM device_secrets WHERE device_id = ? AND kind = ? AND hash = ?")
      .run(deviceId, kind, hash);
    return Number(result.changes) === 1;
  }

  async deleteSecrets(deviceId: string): Promise<void> {
    this.db.prepare("DELETE FROM device_secrets WHERE device_id = ?").run(deviceId);
  }

  async putPairingCode(record: PairingCodeRecord): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO pairing_codes (hash, expires_at, used_at) VALUES (?, ?, ?)")
      .run(record.hash, record.expiresAt, record.usedAt);
  }

  async consumePairingCode(hash: string, now: number): Promise<boolean> {
    const row = this.db
      .prepare("SELECT expires_at, used_at FROM pairing_codes WHERE hash = ?")
      .get(hash) as { expires_at: number; used_at: number | null } | undefined;
    if (!row) return false;
    if (row.used_at !== null || row.expires_at <= now) return false;
    const result = this.db
      .prepare("UPDATE pairing_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL")
      .run(now, hash);
    return Number(result.changes) === 1;
  }

  async getGrants(deviceId: string): Promise<CompanionDeviceGrants | null> {
    const row = this.db
      .prepare("SELECT payload FROM device_grants WHERE device_id = ?")
      .get(deviceId) as { payload: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.payload) as CompanionDeviceGrants;
  }

  async saveGrants(grants: CompanionDeviceGrants): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO device_grants (device_id, payload) VALUES (?, ?)")
      .run(grants.deviceId, JSON.stringify(grants));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
