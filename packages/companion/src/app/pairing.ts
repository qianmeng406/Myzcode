// 配对与设备凭证（app 层）：所有秘密只以 sha256 指纹进入 ControlStore。
// 事件顺序（specs/companion-gateway.md §6）：
//   owner 建码（一次性、15 分钟）→ 手机提交码+设备名 → 消费码（单次）→
//   登记设备 + 授权（默认全部已登记节点）→ 签发 access/refresh。
// 撤销：级联失效全部秘密 + 关闭在线连接由 hub 适配器执行；已接受任务不受影响。
import type {
  CompanionDeviceRecord,
  CompanionNodeRecord,
} from "@zcode/shared/companion-protocol";
import type { CompanionDeviceGrants } from "../domain/grants.js";
import type { Clock, ControlStore, HubLogger, SecretBox } from "./ports.js";

export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/**
 * 配对码位数（6 位数字）。安全依据：单次消费 + 15 分钟 TTL + /companion/pair
 * 每来源限速（默认 15 分钟 10 次）——在线爆破上限 10/1,000,000 每窗口。
 * 小空间碰撞由 INSERT OR REPLACE 天然覆盖（新码生效、旧码作废），
 * 个人使用并发量下可忽略。
 */
export const PAIRING_CODE_DIGITS = 6;

export interface IssuedPairingCode {
  code: string;
  expiresAt: number;
}

export interface PairDeviceResult {
  device: CompanionDeviceRecord;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
}

export class PairingError extends Error {
  constructor(
    public readonly code: "invalid_code" | "code_expired" | "device_limit",
    message: string,
  ) {
    super(message);
  }
}

export const COMPANION_DEVICE_LIMIT = 8;

export class CompanionPairingService {
  constructor(
    private readonly deps: {
      store: ControlStore;
      secrets: SecretBox;
      clock: Clock;
      logger: HubLogger;
    },
  ) {}

  async createPairingCode(): Promise<IssuedPairingCode> {
    const code = String(this.deps.secrets.randomInt(10 ** PAIRING_CODE_DIGITS)).padStart(
      PAIRING_CODE_DIGITS,
      "0",
    );
    const expiresAt = this.deps.clock.now() + PAIRING_CODE_TTL_MS;
    await this.deps.store.putPairingCode({
      hash: this.deps.secrets.sha256Hex(code),
      expiresAt,
      usedAt: null,
    });
    this.deps.logger.info("companion pairing code issued");
    return { code, expiresAt };
  }

  async pairDevice(deviceName: string, rawCode: string): Promise<PairDeviceResult> {
    const devices = await this.deps.store.listDevices();
    if (devices.filter((device) => device.revokedAt === undefined).length >= COMPANION_DEVICE_LIMIT) {
      throw new PairingError("device_limit", "too many paired devices");
    }
    const consumed = await this.deps.store.consumePairingCode(
      this.deps.secrets.sha256Hex(rawCode),
      this.deps.clock.now(),
    );
    if (!consumed) {
      throw new PairingError("invalid_code", "pairing code invalid, expired or already used");
    }
    const now = this.deps.clock.now();
    const device: CompanionDeviceRecord = {
      deviceId: `dev-${this.deps.secrets.randomToken(12)}`,
      deviceName: deviceName.trim().slice(0, 128),
      createdAt: now,
    };
    await this.deps.store.saveDevice(device);
    // 个人使用默认授权：允许访问当前已登记且未撤销的全部节点（空白名单 = 全部工作区）。
    const nodes = (await this.deps.store.listNodes()).filter(
      (node: CompanionNodeRecord) => node.revokedAt === undefined,
    );
    const grants: CompanionDeviceGrants = {
      deviceId: device.deviceId,
      nodes: nodes.map((node) => ({ nodeId: node.nodeId, workspaceIdentities: [] })),
    };
    await this.deps.store.saveGrants(grants);
    const issued = await this.issueSecrets(device.deviceId);
    this.deps.logger.info("companion device paired", { deviceId: device.deviceId });
    return { device, ...issued };
  }

  async refreshAccess(rawRefreshToken: string): Promise<
    | { ok: true; accessToken: string; refreshToken: string; accessExpiresAt: number; deviceId: string }
    | { ok: false }
  > {
    const hash = this.deps.secrets.sha256Hex(rawRefreshToken);
    const devices = await this.deps.store.listDevices();
    for (const device of devices) {
      if (device.revokedAt !== undefined) continue;
      const refreshSecrets = await this.deps.store.listSecrets(device.deviceId, "refresh");
      const hit = refreshSecrets.find((secret) => secret.hash === hash);
      if (!hit) continue;
      if (hit.expiresAt <= this.deps.clock.now()) {
        return { ok: false };
      }
      // 轮换：只失效被使用的这条 refresh（同设备其他表面积不受影响），签发新对。
      await this.deps.store.deleteSecret(device.deviceId, "refresh", hash);
      const issued = await this.issueSecrets(device.deviceId);
      return { ok: true, deviceId: device.deviceId, ...issued };
    }
    return { ok: false };
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const device = await this.deps.store.getDevice(deviceId);
    if (!device || device.revokedAt !== undefined) return false;
    await this.deps.store.revokeDevice(deviceId, this.deps.clock.now());
    await this.deps.store.deleteSecrets(deviceId);
    this.deps.logger.info("companion device revoked", { deviceId });
    return true;
  }

  async issueSecrets(deviceId: string): Promise<{
    accessToken: string;
    refreshToken: string;
    accessExpiresAt: number;
  }> {
    const now = this.deps.clock.now();
    const accessToken = this.deps.secrets.randomToken(32);
    const refreshToken = this.deps.secrets.randomToken(32);
    await this.deps.store.putSecret({
      deviceId,
      kind: "access",
      hash: this.deps.secrets.sha256Hex(accessToken),
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
    });
    await this.deps.store.putSecret({
      deviceId,
      kind: "refresh",
      hash: this.deps.secrets.sha256Hex(refreshToken),
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
    });
    return { accessToken, refreshToken, accessExpiresAt: now + ACCESS_TOKEN_TTL_MS };
  }

  /** WS/HTTP 入口鉴权：匹配未撤销设备的未过期 access 指纹。 */
  async authenticateAccessToken(rawToken: string): Promise<string | null> {
    if (!rawToken) return null;
    const hash = this.deps.secrets.sha256Hex(rawToken);
    const devices = await this.deps.store.listDevices();
    for (const device of devices) {
      if (device.revokedAt !== undefined) continue;
      const secrets = await this.deps.store.listSecrets(device.deviceId, "access");
      if (secrets.some((secret) => secret.hash === hash && secret.expiresAt > this.deps.clock.now())) {
        return device.deviceId;
      }
    }
    return null;
  }
}
