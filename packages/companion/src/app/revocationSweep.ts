// 吊销/授权复查 sweep（从 hub 拆出，保持单文件架构门禁内）：
// 周期性把持久层的撤销与 grants 收缩落到在线链路——CLI 在独立进程改库，
// gateway 只能靠轮询收敛（≤ sweep 周期）。attach 时刻始终有即时裁决，
// 本模块只是存量连接/attachment 的兜底。
import { decideDeviceWorkspaceAccess } from "../domain/grants.js";
import type { AttachmentRegistry } from "../app/attachmentRegistry.js";
import type { ControlStore, HubLogger, MobileLink } from "../app/ports.js";

export interface RevocationSweepDeps {
  store: ControlStore;
  registry: AttachmentRegistry;
  mobileLinks: ReadonlySet<MobileLink>;
  logger: HubLogger;
  closeDeviceConnections(deviceId: string): void;
  closeNodeConnections(nodeId: string): void;
}

export async function runRevocationSweep(deps: RevocationSweepDeps): Promise<void> {
  const { store, registry, mobileLinks, logger } = deps;
  try {
    const devices = await store.listDevices();
    const revokedDevices = new Set(
      devices.filter((device) => device.revokedAt !== undefined).map((device) => device.deviceId),
    );
    for (const link of Array.from(mobileLinks)) {
      if (revokedDevices.has(link.deviceId)) {
        deps.closeDeviceConnections(link.deviceId);
      }
    }
    const nodes = await store.listNodes();
    for (const record of nodes) {
      if (record.revokedAt !== undefined) {
        deps.closeNodeConnections(record.nodeId);
      }
    }
    // grants 收缩/删除：拆除不再被授权的存量 attachment。
    for (const entry of registry.activeEntries()) {
      const grants = await store.getGrants(entry.deviceId);
      const device = await store.getDevice(entry.deviceId);
      const decision = decideDeviceWorkspaceAccess({
        grants,
        revokedAt: device?.revokedAt !== undefined ? device.revokedAt : null,
        nodeId: entry.nodeId,
        workspaceIdentity: entry.workspaceIdentity,
      });
      if (!decision.allowed) {
        logger.info("companion attachment torn down by grants change", {
          attachmentId: entry.attachmentId,
          reason: decision.reason,
        });
        registry.teardown(entry.attachmentId, "grants_shrunk");
      }
    }
  } catch (error) {
    logger.warn("revocation sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
