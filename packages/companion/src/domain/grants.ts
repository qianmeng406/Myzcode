// 设备授权决策（纯逻辑，无 IO）：设备能否附着到某节点某工作区。
// 授权模型：个人自托管、单所有者 —— 每台设备按节点授予工作区白名单；
// workspaceIdentities 为空数组表示「该节点登记的全部工作区」（个人使用的默认宽松粒度）。
import type { CompanionNodeId } from "@zcode/shared/companion-protocol";

export interface CompanionDeviceGrants {
  deviceId: string;
  nodes: ReadonlyArray<{
    nodeId: CompanionNodeId;
    /** 空数组 = 允许该节点当前登记的全部工作区；非空 = 精确白名单。 */
    workspaceIdentities: ReadonlyArray<string>;
  }>;
}

export interface DeviceGrantsDecisionInput {
  grants: CompanionDeviceGrants | null;
  revokedAt: number | null;
  nodeId: CompanionNodeId;
  workspaceIdentity: string;
}

export type DeviceGrantsDecision =
  | { allowed: true }
  | { allowed: false; reason: "device_revoked" | "node_not_granted" | "workspace_not_granted" };

export function decideDeviceWorkspaceAccess(input: DeviceGrantsDecisionInput): DeviceGrantsDecision {
  if (input.revokedAt !== null) {
    return { allowed: false, reason: "device_revoked" };
  }
  const grants = input.grants;
  if (!grants) {
    return { allowed: false, reason: "node_not_granted" };
  }
  const nodeGrant = grants.nodes.find((entry) => entry.nodeId === input.nodeId);
  if (!nodeGrant) {
    return { allowed: false, reason: "node_not_granted" };
  }
  if (nodeGrant.workspaceIdentities.length === 0) {
    return { allowed: true };
  }
  if (nodeGrant.workspaceIdentities.includes(input.workspaceIdentity)) {
    return { allowed: true };
  }
  return { allowed: false, reason: "workspace_not_granted" };
}

/** 配对码可用性（纯判定）：未过期且未被使用。 */
export function isPairingCodeUsable(code: {
  expiresAt: number;
  usedAt: number | null;
}): { usable: boolean; reason?: "expired" | "used" } {
  if (code.usedAt !== null) {
    return { usable: false, reason: "used" };
  }
  return { usable: true };
}

/** 附件并发配额判定（纯逻辑）。 */
export function canCreateAttachment(currentCount: number, maxCount: number): boolean {
  return currentCount < maxCount;
}
