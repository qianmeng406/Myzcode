// Attachment 生命周期登记表：pending → active → teardown 状态机与 relay 绑定。
// 从 hub 拆出的原因：单一所有者管理 attachment 状态与计时器（specs/companion-gateway.md §3），
// hub 只负责链路与编排骨架。事件顺序：
//   attach 成功 → createActive（joinTimer 兜底）→ 首个 join 转入等待另一侧 →
//   双侧齐 → bindRelayPair 透传；任一侧断开/超时/撤销 → teardown（断链 + 通知 + 请求节点 detach）。
import type { RelayJoin } from "./ports.js";
import type { GatewayDefaults, HubLogger, MobileLink } from "./ports.js";
import { bindRelayPair } from "./relayPipe.js";

export interface PendingAttachmentSpec {
  attachmentId: string;
  nodeId: string;
  deviceId: string;
  capabilityMobile: string;
  capabilityConnector: string;
}

interface PendingEntry extends PendingAttachmentSpec {
  timer: ReturnType<typeof setTimeout>;
  mobileLink: MobileLink;
  requestId: string;
}

interface ActiveAttachment {
  attachmentId: string;
  nodeId: string;
  deviceId: string;
  capabilityMobile: string;
  capabilityConnector: string;
  relay: ReturnType<typeof bindRelayPair> | null;
  joins: { mobile?: RelayJoin; connector?: RelayJoin };
  joinTimer: ReturnType<typeof setTimeout> | null;
}

export interface AttachmentRegistryHost {
  logger: HubLogger;
  /** teardown 时请求节点侧同步 detach（best-effort，由 hub 提供节点链路）。 */
  requestNodeDetach(nodeId: string, attachmentId: string): void;
}

export class AttachmentRegistry {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly active = new Map<string, ActiveAttachment>();
  private readonly mobileByAttachment = new Map<string, MobileLink>();

  constructor(
    private readonly host: AttachmentRegistryHost,
    private readonly defaults: GatewayDefaults,
  ) {}

  countActive(): number {
    return this.active.size;
  }

  getByAttachment(attachmentId: string): ActiveAttachment | null {
    return this.active.get(attachmentId) ?? null;
  }

  findActiveByDevice(deviceId: string): ActiveAttachment | null {
    for (const attachment of this.active.values()) {
      if (attachment.deviceId === deviceId) return attachment;
    }
    return null;
  }

  /** attach 请求发起：登记 pending 并启动超时（超时直接回复手机）。 */
  createPending(
    spec: PendingAttachmentSpec,
    mobileLink: MobileLink,
    requestId: string,
    onTimeoutRespond: () => void,
  ): void {
    const timer = setTimeout(() => {
      if (this.pending.get(spec.attachmentId) === entry) {
        this.pending.delete(spec.attachmentId);
        onTimeoutRespond();
      }
    }, this.defaults.attachRequestTimeoutMs);
    const entry: PendingEntry = { ...spec, timer, mobileLink, requestId };
    this.pending.set(spec.attachmentId, entry);
  }

  hasPending(attachmentId: string): boolean {
    return this.pending.has(attachmentId);
  }

  /** 取出 pending（清计时器、移除）；attach 响应裁决时使用。 */
  takePending(attachmentId: string): PendingAttachmentSpec | null {
    const pending = this.pending.get(attachmentId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.pending.delete(attachmentId);
    return pending;
  }

  /** attach 成功：pending 转 active（不等 relay join，join 超时由 joinTimer 兜底）。 */
  createActiveFromPending(pending: PendingAttachmentSpec, mobileLink: MobileLink): ActiveAttachment {
    const attachmentId = pending.attachmentId;
    const attachment: ActiveAttachment = {
      attachmentId: pending.attachmentId,
      nodeId: pending.nodeId,
      deviceId: pending.deviceId,
      capabilityMobile: pending.capabilityMobile,
      capabilityConnector: pending.capabilityConnector,
      relay: null,
      joins: {},
      joinTimer: setTimeout(() => {
        const stillActive = this.active.get(attachmentId);
        if (stillActive) this.teardown(attachmentId, "relay_join_timeout");
      }, this.defaults.relayJoinTimeoutMs),
    };
    this.active.set(attachmentId, attachment);
    this.mobileByAttachment.set(attachmentId, mobileLink);
    return attachment;
  }

  /**
   * relay 接入：side 由 capability 归属推导，客户端不自证身份。
   * 双侧齐 → 建立透传。返回 false 表示拒绝（适配器应关闭连接）。
   */
  handleRelayJoin(join: RelayJoin): boolean {
    const pending = this.pending.get(join.attachmentId);
    const existing = this.active.get(join.attachmentId);
    const record = pending ?? existing;
    if (!record) {
      this.host.logger.warn("relay join rejected: unknown attachment", {
        attachmentId: join.attachmentId,
      });
      return false;
    }
    const side =
      record.capabilityMobile === join.capability
        ? ("mobile" as const)
        : record.capabilityConnector === join.capability
          ? ("connector" as const)
          : null;
    if (!side) {
      this.host.logger.warn("relay join rejected: capability mismatch", {
        attachmentId: join.attachmentId,
      });
      return false;
    }
    this.host.logger.info("relay join accepted", { attachmentId: join.attachmentId, side });
    if (pending && !existing) {
      // connector 的 relay join 可能先于节点 attach 响应到达（拨号与响应并行）：
      // 这里消费 pending 并转 active，同时**代 hub 补发 attach 成功响应**；
      // hub 侧 hasPending 检查会发现 pending 已消费而静默返回，响应恰好一次。
      this.takePending(join.attachmentId);
      const target = this.createActiveFromPending(pending, pending.mobileLink);
      this.consumeJoin(target, side, join);
      pending.mobileLink.respond(pending.requestId, {
        ok: true,
        result: {
          attachmentId: join.attachmentId,
          relayPath: `/companion/relay/${join.attachmentId}`,
          relayCapability: pending.capabilityMobile,
        },
      });
      return true;
    }
    this.consumeJoin(existing!, side, join);
    return true;
  }

  teardownAllForNode(nodeId: string, reason: string): void {
    for (const attachment of Array.from(this.active.values())) {
      if (attachment.nodeId === nodeId) this.teardown(attachment.attachmentId, reason);
    }
    for (const pending of Array.from(this.pending.values())) {
      if (pending.nodeId === nodeId) this.takePending(pending.attachmentId);
    }
  }

  /** 断开/撤销时取消该设备仍在途的 attach 请求（不必等 attachRequestTimeout 兜底）。 */
  cancelPendingForDevice(deviceId: string): void {
    for (const pending of Array.from(this.pending.values())) {
      if (pending.deviceId === deviceId) this.takePending(pending.attachmentId);
    }
  }

  teardownAllForDevice(deviceId: string, reason: string): void {
    for (const attachment of Array.from(this.active.values())) {
      if (attachment.deviceId === deviceId) this.teardown(attachment.attachmentId, reason);
    }
    for (const pending of Array.from(this.pending.values())) {
      if (pending.deviceId === deviceId) {
        this.takePending(pending.attachmentId);
        pending.mobileLink.close();
      }
    }
  }

  teardown(attachmentId: string, reason: string): void {
    const attachment = this.active.get(attachmentId);
    if (!attachment) return;
    this.active.delete(attachmentId);
    if (attachment.joinTimer) clearTimeout(attachment.joinTimer);
    attachment.relay?.close();
    attachment.relay = null;
    for (const join of [attachment.joins.mobile, attachment.joins.connector]) {
      join?.close(1000, "attachment closed");
    }
    attachment.joins = {};
    const mobileLink = this.mobileByAttachment.get(attachmentId);
    this.mobileByAttachment.delete(attachmentId);
    mobileLink?.sendEvent({
      v: 1,
      event: "attachmentClosed",
      payload: { attachmentId, reason },
    });
    this.host.requestNodeDetach(attachment.nodeId, attachmentId);
  }

  stop(): void {
    for (const pending of Array.from(this.pending.values())) {
      clearTimeout(pending.timer);
    }
    this.pending.clear();
    for (const attachment of Array.from(this.active.values())) {
      if (attachment.joinTimer) clearTimeout(attachment.joinTimer);
      attachment.relay?.close();
      attachment.relay = null;
      for (const join of [attachment.joins.mobile, attachment.joins.connector]) {
        join?.close(1000, "gateway closing");
      }
      attachment.joins = {};
    }
    this.active.clear();
    this.mobileByAttachment.clear();
  }

  private consumeJoin(attachment: ActiveAttachment, side: "mobile" | "connector", join: RelayJoin): void {
    if (attachment.joins[side]) {
      join.close(4000, "duplicate relay join");
      return;
    }
    attachment.joins[side] = join;
    const mobile = attachment.joins.mobile;
    const connector = attachment.joins.connector;
    if (!mobile || !connector) {
      // 单侧等待期对端断开：立即拆除 attachment。否则记录残留到 joinTimer 超时，
      // 而手机侧 attach 成功响应已发出 —— 需要 attachmentClosed 事件对账。
      join.onClosed(() => this.teardown(attachment.attachmentId, "relay_closed"));
      return;
    }
    if (attachment.joinTimer) {
      clearTimeout(attachment.joinTimer);
      attachment.joinTimer = null;
    }
    attachment.relay = bindRelayPair(mobile, connector, this.defaults.maxFrameBytes, () => {
      // 通道任一侧断开：拆除 attachment（teardown 幂等，递归触发安全）。
      this.teardown(attachment.attachmentId, "relay_closed");
    });
    this.host.logger.info("companion relay bound", { attachmentId: attachment.attachmentId });
  }
}
