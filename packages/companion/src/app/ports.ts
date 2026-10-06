// companion app 层端口：hub 只面向这些接口编排，Node/浏览器细节全部留在 adapters。
// 状态所有权（见 specs/companion-gateway.md §3）：持久控制元数据归 ControlStore；
// 在线状态与 attachment 绑定归 hub 内存；任务/会话事实永远不属于本模块。
import type {
  CompanionDeviceRecord,
  CompanionEvent,
  CompanionNodeRecord,
  CompanionWorkspaceEntry,
} from "@zcode/shared/companion-protocol";
import type { CompanionDeviceGrants } from "../domain/grants.js";

export interface Clock {
  now(): number;
}

export interface SecretBox {
  /** 密码学随机 token（URL-safe base64）。 */
  randomToken(byteLength: number): string;
  sha256Hex(value: string): string;
}

export type DeviceSecretKind = "access" | "refresh";

export interface DeviceSecretRecord {
  deviceId: string;
  kind: DeviceSecretKind;
  /** sha256 指纹；明文永不落盘。 */
  hash: string;
  expiresAt: number;
}

export interface PairingCodeRecord {
  /** sha256 指纹；明文只在创建响应里出现一次。 */
  hash: string;
  expiresAt: number;
  usedAt: number | null;
}

/**
 * 控制元数据唯一权威。实现必须保证：撤销设备级联失效其全部秘密；
 * 配对码消费是单次的（并发消费只允许一个成功）。
 */
export interface ControlStore {
  listDevices(): Promise<CompanionDeviceRecord[]>;
  getDevice(deviceId: string): Promise<CompanionDeviceRecord | null>;
  saveDevice(record: CompanionDeviceRecord): Promise<void>;
  revokeDevice(deviceId: string, revokedAt: number): Promise<void>;

  listNodes(): Promise<CompanionNodeRecord[]>;
  getNode(nodeId: string): Promise<CompanionNodeRecord | null>;
  saveNode(record: CompanionNodeRecord): Promise<void>;

  listSecrets(deviceId: string, kind: DeviceSecretKind): Promise<DeviceSecretRecord[]>;
  putSecret(record: DeviceSecretRecord): Promise<void>;
  /** 精确删除一条秘密（refresh 轮换用）；deleteSecrets 撤销时级联清空。 */
  deleteSecret(deviceId: string, kind: DeviceSecretKind, hash: string): Promise<void>;
  deleteSecrets(deviceId: string): Promise<void>;

  putPairingCode(record: PairingCodeRecord): Promise<void>;
  /** 单次消费：命中未过期未使用码时置 usedAt 并返回 true。 */
  consumePairingCode(hash: string, now: number): Promise<boolean>;

  getGrants(deviceId: string): Promise<CompanionDeviceGrants | null>;
  saveGrants(grants: CompanionDeviceGrants): Promise<void>;

  close(): Promise<void>;
}

// ── hub 侧链路抽象（适配器把 ws/http 翻译成这些回调） ──

export interface LinkResponseWriter {
  /** 对某请求回成功/失败响应。 */
  respond(id: string, result: { ok: true; result?: unknown } | { ok: false; code: string; message: string }): void;
}

export interface MobileLink extends LinkResponseWriter {
  deviceId: string;
  sendEvent(event: CompanionEvent): void;
  close(): void;
}

export interface NodeLink {
  nodeId: string;
  /** hub → connector 的控制请求（attach/detach），adapter 负责关联 id 与超时。 */
  request(op: string, params: unknown, timeoutMs: number): Promise<{ ok: true; result?: unknown } | { ok: false; code: string; message: string }>;
  close(): void;
}

/** relay 侧接入点：凭一次性 capability 接入，side 由 hub 按 capability 归属推导。 */
export interface RelayJoin {
  attachmentId: string;
  capability: string;
  /** 注册下行 binary 帧监听（进入 hub 透传管线）。 */
  onBinary(listener: (data: Uint8Array) => void): void;
  /** 注册连接关闭监听（对端断开/异常都会触发）。 */
  onClosed(listener: () => void): void;
  sendBinary(data: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface HubLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface GatewayDefaults {
  maxAttachments: number;
  maxFrameBytes: number;
  attachRequestTimeoutMs: number;
  relayJoinTimeoutMs: number;
}

export const COMPANION_GATEWAY_DEFAULTS: GatewayDefaults = {
  maxAttachments: 8,
  maxFrameBytes: 1024 * 1024,
  attachRequestTimeoutMs: 10_000,
  relayJoinTimeoutMs: 30_000,
};

export type { CompanionDeviceGrants, CompanionDeviceRecord, CompanionNodeRecord, CompanionWorkspaceEntry };
