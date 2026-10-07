// 目录视图组装（纯函数，从 hub 拆出保持单文件架构门禁内）：
// 按设备 grants 过滤节点与工作区——未授权目标对设备不可见（存在性不泄露）。
// 空工作区白名单 = 该节点全部共享工作区（个人自托管默认粒度，spec §6）。
import type { CompanionCatalogResult, CompanionWorkspaceEntry } from "@zcode/shared/companion-protocol";
import type { CompanionDeviceGrants } from "../domain/grants.js";

export function buildDeviceCatalog(input: {
  records: ReadonlyArray<{ nodeId: string; kind: "desktop" | "cloud"; displayName: string; revokedAt?: number }>;
  grants: CompanionDeviceGrants | null;
  nodeDisplayNames: ReadonlyMap<string, string>;
  /** 只用 has()：hub 侧直接传 Map<string, NodeLink> 即可。 */
  onlineNodeIds: { has(nodeId: string): boolean };
  nodeWorkspaces: ReadonlyMap<string, CompanionWorkspaceEntry[]>;
}): CompanionCatalogResult {
  const grantedFor = (nodeId: string): CompanionDeviceGrants["nodes"][number] | null =>
    input.grants?.nodes.find((entry) => entry.nodeId === nodeId) ?? null;
  const nodes = input.records
    .filter((record) => record.revokedAt === undefined && grantedFor(record.nodeId) !== null)
    .map((record) => {
      const nodeGrant = grantedFor(record.nodeId)!;
      const published = input.nodeWorkspaces.get(record.nodeId) ?? [];
      const workspaces =
        nodeGrant.workspaceIdentities.length > 0
          ? published.filter((entry) => nodeGrant.workspaceIdentities.includes(entry.workspaceIdentity))
          : published;
      return {
        nodeId: record.nodeId,
        kind: record.kind,
        displayName: input.nodeDisplayNames.get(record.nodeId) ?? record.displayName,
        online: input.onlineNodeIds.has(record.nodeId),
        workspaces,
      };
    });
  return { nodes };
}
