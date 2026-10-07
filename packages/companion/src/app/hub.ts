// Companion hub：gateway 的链路编排骨架（app 层，IO 全部经 ports）。
// attachment 状态机（pending/active/relay 绑定/计时器）归 AttachmentRegistry 所有；
// hub 持有节点与手机的在线链路、工作区目录缓存与 catalog 编排。
// 不变量（specs/companion-gateway.md）：
//  - 一条手机连接同时至多绑定一个 attachment（切换 = detach → attach）；
//  - 数据面 binary 帧只在 relay 双端间逐帧互转，hub/registry 不缓存、不解释；
//  - hub 不持有任务/会话状态；节点断开只影响经它的 attachment，不影响运行时任务。
import {
  companionAttachParamsSchema,
  companionDetachParamsSchema,
  type CompanionCatalogResult,
  type CompanionEvent,
  type CompanionNodeKind,
  type CompanionWorkspaceEntry,
} from "@zcode/shared/companion-protocol";
import { canCreateAttachment, decideDeviceWorkspaceAccess } from "../domain/grants.js";
import { AttachmentRegistry } from "./attachmentRegistry.js";
import type {
  GatewayDefaults,
  HubLogger,
  MobileLink,
  NodeLink,
  RelayJoin,
} from "./ports.js";

export interface CompanionHubDeps {
  store: import("./ports.js").ControlStore;
  clock: import("./ports.js").Clock;
  secrets: import("./ports.js").SecretBox;
  defaults: GatewayDefaults;
  logger: HubLogger;
}

export class CompanionHub {
  private readonly registry: AttachmentRegistry;
  private readonly nodeLinks = new Map<string, NodeLink>();
  private readonly nodeWorkspaces = new Map<string, CompanionWorkspaceEntry[]>();
  private readonly nodeDisplayNames = new Map<string, string>();
  private readonly mobileLinks = new Set<MobileLink>();
  private stopped = false;

  constructor(private readonly deps: CompanionHubDeps) {
    this.registry = new AttachmentRegistry(
      {
        logger: deps.logger,
        requestNodeDetach: (nodeId, attachmentId) => {
          const link = this.nodeLinks.get(nodeId);
          void link
            ?.request("detach", { attachmentId }, 3_000)
            .catch(() => undefined);
        },
      },
      deps.defaults,
    );
  }

  stop(): void {
    this.stopped = true;
    this.registry.stop();
    for (const link of this.nodeLinks.values()) link.close();
    for (const link of this.mobileLinks) link.close();
    this.nodeLinks.clear();
    this.nodeWorkspaces.clear();
    this.nodeDisplayNames.clear();
    this.mobileLinks.clear();
  }

  // ── 节点侧 ──

  async handleNodeHello(
    link: NodeLink,
    hello: { nodeId: string; displayName: string; kind: CompanionNodeKind },
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    if (this.stopped) {
      return { ok: false, code: "internal", message: "gateway is stopping" };
    }
    const record = await this.deps.store.getNode(hello.nodeId);
    if (!record || record.revokedAt !== undefined) {
      return { ok: false, code: "unauthorized", message: "unknown or revoked node" };
    }
    const existing = this.nodeLinks.get(hello.nodeId);
    if (existing && existing !== link) {
      // 同节点重复连接：以新连接为准（旧连接由适配器关闭）。
      existing.close();
      this.nodeLinks.delete(hello.nodeId);
    }
    this.nodeLinks.set(hello.nodeId, link);
    this.nodeDisplayNames.set(hello.nodeId, hello.displayName);
    this.deps.logger.info("companion node connected", { nodeId: hello.nodeId, kind: hello.kind });
    this.broadcastNodeStatus(hello.nodeId, true);
    return { ok: true };
  }

  handleNodeWorkspaces(nodeId: string, workspaces: CompanionWorkspaceEntry[]): void {
    if (!this.nodeLinks.has(nodeId)) return;
    this.nodeWorkspaces.set(
      nodeId,
      workspaces.map((entry) => ({ ...entry, nodeId })),
    );
    this.broadcastNodeStatus(nodeId, true);
  }

  /** 迟到的旧连接 close 不得误杀已接管的新链路：按链路身份比对。 */
  handleNodeClosed(nodeId: string, link: NodeLink): void {
    if (this.nodeLinks.get(nodeId) !== link) return;
    this.nodeLinks.delete(nodeId);
    this.nodeWorkspaces.delete(nodeId);
    this.deps.logger.warn("companion node disconnected", { nodeId });
    this.broadcastNodeStatus(nodeId, false);
    this.registry.teardownAllForNode(nodeId, "node_offline");
  }

  /** owner 撤销节点：关闭其在线控制链路并拆除全部 attachment。 */
  closeNodeConnections(nodeId: string): void {
    this.registry.teardownAllForNode(nodeId, "node_revoked");
    const link = this.nodeLinks.get(nodeId);
    if (link) {
      link.close();
      this.handleNodeClosed(nodeId, link);
    }
  }

  /** 周期性吊销复查：关闭已撤销设备/节点的在线链路（CLI 撤销跨进程生效）。 */
  async revalidateRevocations(): Promise<void> {
    if (this.stopped) return;
    try {
      const devices = await this.deps.store.listDevices();
      const revokedDevices = new Set(
        devices.filter((device) => device.revokedAt !== undefined).map((device) => device.deviceId),
      );
      for (const link of Array.from(this.mobileLinks)) {
        if (revokedDevices.has(link.deviceId)) {
          this.closeDeviceConnections(link.deviceId);
        }
      }
      const nodes = await this.deps.store.listNodes();
      for (const record of nodes) {
        if (record.revokedAt !== undefined && this.nodeLinks.has(record.nodeId)) {
          this.deps.logger.warn("companion node revoked while online", { nodeId: record.nodeId });
          this.closeNodeConnections(record.nodeId);
        }
      }
    } catch (error) {
      this.deps.logger.warn("revocation sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── 手机侧 ──

  handleMobileOpened(link: MobileLink): void {
    this.mobileLinks.add(link);
  }

  handleMobileClosed(link: MobileLink): void {
    this.mobileLinks.delete(link);
    // 在途 attach 请求随连接断开即时失效（spec「断开即时失效」），不等超时兜底。
    this.registry.cancelPendingForDevice(link.deviceId);
    const attachment = this.registry.findActiveByDevice(link.deviceId);
    if (attachment) {
      this.registry.teardown(attachment.attachmentId, "mobile_detached");
    }
  }

  /** owner 撤销设备时调用：立即拆除其 attachment 并关闭其在线控制连接。 */
  closeDeviceConnections(deviceId: string): void {
    this.registry.teardownAllForDevice(deviceId, "device_revoked");
    for (const link of Array.from(this.mobileLinks)) {
      if (link.deviceId === deviceId) link.close();
    }
  }

  async handleMobileRequest(
    link: MobileLink,
    id: string,
    op: string,
    rawParams: unknown,
  ): Promise<void> {
    try {
      if (op === "catalog") {
        link.respond(id, { ok: true, result: await this.buildCatalog() });
        return;
      }
      if (op === "attach") {
        await this.handleAttach(link, id, rawParams);
        return;
      }
      if (op === "detach") {
        this.handleDetach(link, id, rawParams);
        return;
      }
      link.respond(id, { ok: false, code: "bad_request", message: `unknown op: ${op}` });
    } catch (error) {
      this.deps.logger.error("mobile request failed", {
        op,
        error: error instanceof Error ? error.message : String(error),
      });
      link.respond(id, { ok: false, code: "internal", message: "gateway internal error" });
    }
  }

  // ── relay 接入 ──

  /** relay 首帧（capability）到达；side 由 capability 归属推导。返回 false = 拒绝。 */
  handleRelayJoin(join: RelayJoin): boolean {
    return this.registry.handleRelayJoin(join);
  }

  // ── 内部 ──

  private async handleAttach(link: MobileLink, id: string, rawParams: unknown): Promise<void> {
    const parsed = companionAttachParamsSchema.safeParse(rawParams);
    if (!parsed.success) {
      link.respond(id, { ok: false, code: "bad_request", message: "invalid attach params" });
      return;
    }
    const params = parsed.data;
    if (this.registry.findActiveByDevice(link.deviceId)) {
      link.respond(id, { ok: false, code: "bad_request", message: "device already attached" });
      return;
    }
    const device = await this.deps.store.getDevice(link.deviceId);
    const grants = await this.deps.store.getGrants(link.deviceId);
    const decision = decideDeviceWorkspaceAccess({
      grants,
      revokedAt: device?.revokedAt !== undefined ? device.revokedAt : null,
      nodeId: params.nodeId,
      workspaceIdentity: params.workspaceIdentity,
    });
    if (!decision.allowed) {
      link.respond(id, {
        ok: false,
        code: decision.reason === "device_revoked" ? "unauthorized" : "forbidden_workspace",
        message: decision.reason,
      });
      return;
    }
    const nodeLink = this.nodeLinks.get(params.nodeId);
    if (!nodeLink) {
      link.respond(id, { ok: false, code: "node_offline", message: "node is offline" });
      return;
    }
    // 在线 ≠ 仍被授权：被撤销但尚未断开的节点不接受新 attach（存量连接由吊销复查关闭）。
    const nodeRecord = await this.deps.store.getNode(params.nodeId);
    if (!nodeRecord || nodeRecord.revokedAt !== undefined) {
      link.respond(id, { ok: false, code: "unauthorized", message: "node is revoked" });
      return;
    }
    const entry = this.nodeWorkspaces
      .get(params.nodeId)
      ?.find((candidate) => candidate.workspaceIdentity === params.workspaceIdentity);
    if (!entry || !entry.available) {
      link.respond(id, {
        ok: false,
        code: "workspace_unavailable",
        message: "workspace is not attachable",
      });
      return;
    }
    if (!canCreateAttachment(this.registry.countActive(), this.deps.defaults.maxAttachments)) {
      link.respond(id, {
        ok: false,
        code: "attachment_limit",
        message: "attachment limit reached",
      });
      return;
    }
    const attachmentId = this.deps.secrets.randomToken(16);
    const capabilityMobile = this.deps.secrets.randomToken(32);
    const capabilityConnector = this.deps.secrets.randomToken(32);
    this.registry.createPending(
      {
        attachmentId,
        nodeId: params.nodeId,
        deviceId: link.deviceId,
        capabilityMobile,
        capabilityConnector,
      },
      link,
      id,
      () =>
        link.respond(id, {
          ok: false,
          code: "node_offline",
          message: "attach request timed out",
        }),
    );
    let nodeResult: { ok: true; result?: unknown } | { ok: false; code: string; message: string };
    try {
      nodeResult = await nodeLink.request(
        "attach",
        {
          attachmentId,
          deviceId: link.deviceId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          relayCapability: capabilityConnector,
        },
        this.deps.defaults.attachRequestTimeoutMs,
      );
    } catch (error) {
      nodeResult = {
        ok: false,
        code: "node_offline",
        message: error instanceof Error ? error.message : "node request failed",
      };
    }
    // attach 请求超时分支可能已删除 pending 并回复；relay join 先到时登记表也已
    // 代发成功响应：这两种情况下本流程静默返回，保证响应恰好一次。
    if (!this.registry.hasPending(attachmentId)) {
      return;
    }
    this.registry.takePending(attachmentId);
    if (!nodeResult.ok) {
      link.respond(id, { ok: false, code: nodeResult.code, message: nodeResult.message });
      return;
    }
    this.registry.createActiveFromPending(
      {
        attachmentId,
        nodeId: params.nodeId,
        deviceId: link.deviceId,
        capabilityMobile,
        capabilityConnector,
      },
      link,
    );
    link.respond(id, {
      ok: true,
      result: {
        attachmentId,
        relayPath: `/companion/relay/${attachmentId}`,
        relayCapability: capabilityMobile,
      },
    });
  }

  private handleDetach(link: MobileLink, id: string, rawParams: unknown): void {
    const parsed = companionDetachParamsSchema.safeParse(rawParams);
    if (!parsed.success) {
      link.respond(id, { ok: false, code: "bad_request", message: "invalid detach params" });
      return;
    }
    const attachment = this.registry.getByAttachment(parsed.data.attachmentId);
    if (!attachment || attachment.deviceId !== link.deviceId) {
      link.respond(id, { ok: false, code: "bad_request", message: "no such attachment" });
      return;
    }
    this.registry.teardown(parsed.data.attachmentId, "mobile_detached");
    link.respond(id, { ok: true });
  }

  private async buildCatalog(): Promise<CompanionCatalogResult> {
    const nodeRecords = await this.deps.store.listNodes();
    const nodes = nodeRecords
      .filter((record) => record.revokedAt === undefined)
      .map((record) => ({
        nodeId: record.nodeId,
        kind: record.kind,
        displayName: this.nodeDisplayNames.get(record.nodeId) ?? record.displayName,
        online: this.nodeLinks.has(record.nodeId),
        workspaces: this.nodeWorkspaces.get(record.nodeId) ?? [],
      }));
    return { nodes };
  }

  private broadcastNodeStatus(nodeId: string, online: boolean): void {
    const event: CompanionEvent = {
      v: 1,
      event: "nodeStatus",
      payload: { nodeId, online },
    };
    for (const link of this.mobileLinks) {
      link.sendEvent(event);
    }
  }
}
