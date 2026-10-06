// Companion 协议 —— My zcode 手机端与自托管 gateway/connector 之间的控制面契约。
// 本文件纪律与 zcode-protocol-v4 相同：只放 schema 类型 + 纯常量，禁止任何运行时/IO/传输逻辑。
// 数据面（attach 后的 binary 透传）不经过本协议；见 packages/companion/specs/companion-gateway.md §2/§4。
import { z } from "zod";

export const COMPANION_PROTOCOL_VERSION = 1 as const;

/** 执行节点类型：desktop = 电脑上已打开工作区的 ZCode；cloud = 独立 resident 运行时。 */
export const companionNodeKindSchema = z.enum(["desktop", "cloud"]);
export type CompanionNodeKind = z.infer<typeof companionNodeKindSchema>;

/** 节点稳定标识；由 gateway 登记时分配，connector hello 时声明。 */
export const companionNodeIdSchema = z.string().trim().min(1).max(128);
export type CompanionNodeId = z.infer<typeof companionNodeIdSchema>;

/** 节点在线状态（hub 内存事实，重启后由 connector 重连恢复）。 */
export const companionNodeStatusSchema = z.object({
  nodeId: companionNodeIdSchema,
  online: z.boolean(),
  /** 最后一次在线时间（Unix ms，gateway 时钟）；从不在线为 undefined。 */
  lastSeenAt: z.number().int().positive().optional(),
});
export type CompanionNodeStatus = z.infer<typeof companionNodeStatusSchema>;

/** 工作区目录条目：connector 显式白名单，不是任意文件系统枚举。 */
export const companionWorkspaceEntrySchema = z.object({
  nodeId: companionNodeIdSchema,
  workspacePath: z.string().min(1).max(1024),
  /** 与运行端一致的身份 key（workspaceIdentity?.trim() || workspacePath），由 connector 构造。 */
  workspaceIdentity: z.string().min(1).max(1024),
  title: z.string().trim().min(1).max(256),
  /** desktop 节点经既有远程连接开放的工作区需带 remoteSessionId 以复用 attachment。 */
  remoteSessionId: z.string().min(1).optional(),
  /** connector 判定当前是否可附着（desktop: attachable；cloud: daemon 在线）。 */
  available: z.boolean(),
});
export type CompanionWorkspaceEntry = z.infer<typeof companionWorkspaceEntrySchema>;

// ── 控制面信封（/companion/ws 与 /companion/node 的 JSON 文本帧） ──

export const companionErrorCodes = [
  "unauthorized",
  "forbidden_workspace",
  "node_offline",
  "workspace_unavailable",
  "attachment_limit",
  "bad_request",
  "internal",
] as const;
export const companionErrorCodeSchema = z.enum(companionErrorCodes);
export type CompanionErrorCode = z.infer<typeof companionErrorCodeSchema>;

export const companionErrorSchema = z.object({
  code: companionErrorCodeSchema,
  message: z.string().max(512),
});
export type CompanionError = z.infer<typeof companionErrorSchema>;

export const companionRequestSchema = z.object({
  v: z.literal(COMPANION_PROTOCOL_VERSION),
  id: z.string().min(1).max(128),
  op: z.string().min(1).max(64),
  params: z.unknown().optional(),
});
export type CompanionRequest = z.infer<typeof companionRequestSchema>;

export const companionResponseSchema = z.object({
  v: z.literal(COMPANION_PROTOCOL_VERSION),
  id: z.string().min(1).max(128),
  ok: z.literal(true),
  result: z.unknown().optional(),
});
export type CompanionResponse = z.infer<typeof companionResponseSchema>;

export const companionErrorResponseSchema = z.object({
  v: z.literal(COMPANION_PROTOCOL_VERSION),
  id: z.string().min(1).max(128),
  ok: z.literal(false),
  error: companionErrorSchema,
});
export type CompanionErrorResponse = z.infer<typeof companionErrorResponseSchema>;

export const companionEventSchema = z.object({
  v: z.literal(COMPANION_PROTOCOL_VERSION),
  event: z.string().min(1).max(64),
  payload: z.unknown().optional(),
});
export type CompanionEvent = z.infer<typeof companionEventSchema>;

// ── 手机 → gateway 控制操作 ──

export const companionCatalogResultSchema = z.object({
  nodes: z.array(
    z.object({
      nodeId: companionNodeIdSchema,
      kind: companionNodeKindSchema,
      displayName: z.string().trim().min(1).max(128),
      online: z.boolean(),
      workspaces: z.array(companionWorkspaceEntrySchema),
    }),
  ),
});
export type CompanionCatalogResult = z.infer<typeof companionCatalogResultSchema>;

export const companionAttachParamsSchema = z.object({
  nodeId: companionNodeIdSchema,
  workspacePath: z.string().min(1).max(1024),
  workspaceIdentity: z.string().min(1).max(1024),
  remoteSessionId: z.string().min(1).optional(),
});
export type CompanionAttachParams = z.infer<typeof companionAttachParamsSchema>;

/** attach 成功结果：手机据 relayPath 建 binary WebSocket（首帧携一次性 capability）。 */
export const companionAttachResultSchema = z.object({
  attachmentId: z.string().min(1).max(128),
  relayPath: z.string().min(1).max(256),
  /** 本端（手机）的 relay capability；connector 持自己的另一份。 */
  relayCapability: z.string().min(16).max(256),
});
export type CompanionAttachResult = z.infer<typeof companionAttachResultSchema>;

export const companionDetachParamsSchema = z.object({
  attachmentId: z.string().min(1).max(128),
});
export type CompanionDetachParams = z.infer<typeof companionDetachParamsSchema>;

// ── gateway ↔ connector 控制操作（/companion/node） ──

export const companionNodeHelloParamsSchema = z.object({
  nodeId: companionNodeIdSchema,
  displayName: z.string().trim().min(1).max(128),
  kind: companionNodeKindSchema,
});
export type CompanionNodeHelloParams = z.infer<typeof companionNodeHelloParamsSchema>;

export const companionNodeWorkspacesParamsSchema = z.object({
  workspaces: z.array(companionWorkspaceEntrySchema.omit({ nodeId: true })).max(64),
});
export type CompanionNodeWorkspacesParams = z.infer<typeof companionNodeWorkspacesParamsSchema>;

/** hub → connector：为某手机连接申请 attachment（含一次性 relay capability）。 */
export const companionAttachRequestParamsSchema = z.object({
  attachmentId: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(128),
  workspacePath: z.string().min(1).max(1024),
  workspaceIdentity: z.string().min(1).max(1024),
  remoteSessionId: z.string().min(1).optional(),
  /** 一次性 relay 凭据：connector 凭它拨 /companion/relay/:attachmentId。 */
  relayCapability: z.string().min(16).max(256),
});
export type CompanionAttachRequestParams = z.infer<typeof companionAttachRequestParamsSchema>;

export const companionAttachResultParamsSchema = z.object({
  attachmentId: z.string().min(1).max(128),
  accepted: z.boolean(),
  errorCode: companionErrorCodeSchema.optional(),
});
export type CompanionAttachResultParams = z.infer<typeof companionAttachResultParamsSchema>;

/** connector → hub 事件：节点侧可附着状态变化（如 resident daemon 退出）。 */
export const companionWorkspaceEventSchema = z.object({
  event: z.enum(["workspacesChanged"]),
  workspaces: z.array(companionWorkspaceEntrySchema.omit({ nodeId: true })).max(64),
});
export type CompanionWorkspaceEvent = z.infer<typeof companionWorkspaceEventSchema>;

// ── 配对与设备 ──

export const companionDeviceIdSchema = z.string().trim().min(1).max(128);
export type CompanionDeviceId = z.infer<typeof companionDeviceIdSchema>;

/** 已登记设备（ControlStore 权威记录；凭证哈希不入此目录协议）。 */
export const companionDeviceRecordSchema = z.object({
  deviceId: companionDeviceIdSchema,
  deviceName: z.string().trim().min(1).max(128),
  createdAt: z.number().int().positive(),
  revokedAt: z.number().int().positive().optional(),
  lastSeenAt: z.number().int().positive().optional(),
});
export type CompanionDeviceRecord = z.infer<typeof companionDeviceRecordSchema>;

export const companionNodeRecordSchema = z.object({
  nodeId: companionNodeIdSchema,
  kind: companionNodeKindSchema,
  displayName: z.string().trim().min(1).max(128),
  /** 节点 token 的 sha256 指纹（绝不明文存储）。 */
  tokenFingerprint: z.string().length(64),
  createdAt: z.number().int().positive(),
  revokedAt: z.number().int().positive().optional(),
});
export type CompanionNodeRecord = z.infer<typeof companionNodeRecordSchema>;

/** 手机会话事件：待处理交互/任务终态等需要提醒的事实（gateway 不解释 payload 内部结构）。 */
export const companionAttentionEventSchema = z.object({
  nodeId: companionNodeIdSchema,
  workspaceIdentity: z.string().min(1).max(1024),
  sessionId: z.string().min(1),
  kind: z.enum(["pendingInteraction", "taskCompleted", "taskFailed"]),
  occurredAt: z.number().int().positive(),
});
export type CompanionAttentionEvent = z.infer<typeof companionAttentionEventSchema>;
