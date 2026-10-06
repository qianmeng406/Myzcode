// 控制面管理端口公开入口（Node 侧）：独立于 contract.ts 的运维面，供
// pair-code / register-node / revoke 等短命 CLI 进程与 serve 进程共享同一
// control SQLite 协同——配对码的单次消费由 SQL 层裁决（consumePairingCode），
// 无需在 gateway 进程内执行。明文令牌/配对码只在创建时返回一次，
// 存储面仅保留 sha256 指纹。
import type { CompanionDeviceRecord } from "@zcode/shared/companion-protocol";

export interface CompanionControlAdmin {
  createPairingCode(): Promise<{
    code: string;
    expiresAt: number;
  }>;
  registerNode(input: {
    nodeId: string;
    displayName: string;
    kind: "desktop" | "cloud";
  }): Promise<{ nodeId: string; token: string }>;
  listDevices(): Promise<CompanionDeviceRecord[]>;
  revokeDevice(deviceId: string): Promise<boolean>;
  revokeNode(nodeId: string): Promise<boolean>;
  close(): Promise<void>;
}

export function openCompanionControlAdmin(options: {
  controlDbPath: string;
  logger?: {
    info(message: string, details?: Record<string, unknown>): void;
    warn(message: string, details?: Record<string, unknown>): void;
    error(message: string, details?: Record<string, unknown>): void;
  };
}): Promise<CompanionControlAdmin> {
  return import("./adapters/controlAdmin.js").then((m) => m.openCompanionControlAdmin(options));
}
