// companion 公开契约（Node 侧嵌入入口）。浏览器客户端入口见 ./client.ts —— 两者都
// 是 architecture-policy 声明的公开面；其余文件禁止跨包引用。
// 职责边界：本契约只暴露 gateway 生命周期与 owner 管理操作；任务/会话控制永远
// 走数据面透传（既有 V4 通道），不在此处新增业务方法。
import type { CompanionDeviceRecord } from "@zcode/shared/companion-protocol";

export interface CompanionGatewayOptions {
  /** 监听端口；0 = 随机可用端口。生产部署应置于 TLS 反代之后。 */
  port?: number;
  host?: string;
  /** 控制元数据 SQLite 文件路径（设备/节点登记、授权、配对码、凭证指纹）。 */
  controlDbPath: string;
  /** 浏览器 Origin 白名单；空数组 = 拒绝所有浏览器 Origin（仅允许非浏览器客户端）。 */
  allowedOrigins?: string[];
  /**
   * TLS 反代模式：true 时按 `X-Forwarded-Proto: https` 决定 refresh cookie 的
   * Secure 标志。默认 false（按直连 URL 协议判断）——部署在反代后必须开启，
   * 否则反代回源是 http，cookie 永远不带 Secure。
   */
  trustForwardedProto?: boolean;
  /** /companion/pair 每来源限速（默认 15 分钟窗口 10 次），防配对码在线爆破。 */
  pairRateLimit?: { windowMs?: number; maxAttempts?: number };
  maxAttachments?: number;
  maxFrameBytes?: number;
  logger?: {
    info(message: string, details?: Record<string, unknown>): void;
    warn(message: string, details?: Record<string, unknown>): void;
    error(message: string, details?: Record<string, unknown>): void;
  };
}

export interface CompanionPairingCodeIssued {
  code: string;
  expiresAt: number;
}

export interface CompanionNodeTokenIssued {
  nodeId: string;
  /** 节点连接令牌明文；只在创建时返回一次，存储面仅保留 sha256 指纹。 */
  token: string;
}

/** owner 管理操作（个人自托管）：登记节点、配对设备、撤销。 */
export interface CompanionOwnerPort {
  createPairingCode(): Promise<CompanionPairingCodeIssued>;
  /** 手机提交配对码 + 设备名完成配对（也暴露为 /companion/pair，供 WebView 调用）。 */
  pairDevice(deviceName: string, code: string): Promise<{
    deviceId: string;
    accessToken: string;
    refreshToken: string;
    accessExpiresAt: number;
  }>;
  listDevices(): Promise<CompanionDeviceRecord[]>;
  revokeDevice(deviceId: string): Promise<boolean>;
  registerNode(input: { nodeId: string; displayName: string; kind: "desktop" | "cloud" }): Promise<CompanionNodeTokenIssued>;
  revokeNode(nodeId: string): Promise<boolean>;
}

export interface CompanionGatewayHandle {
  port: number;
  owner: CompanionOwnerPort;
  stop(): Promise<void>;
}

export function startCompanionGateway(
  options: CompanionGatewayOptions,
): Promise<CompanionGatewayHandle> {
  // 延迟引入 Node 适配层，保持 contract.ts 可被类型检查而不拖入浏览器构建。
  return import("./adapters/gatewayServer.js").then((m) => m.startCompanionGatewayServer(options));
}
