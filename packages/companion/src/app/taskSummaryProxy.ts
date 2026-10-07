// 只读任务索引代理（specs §11.4，从 hub 拆出保持单文件架构门禁内）：
// grants 裁决与 attach 同一函数；结果按 节点+工作区 30s TTL 缓存——connector
// 的临时订阅读取有成本，目录轮询频率下必须收敛。任务权威永远在执行端，
// 本代理只转发与缓存展示摘要。
import {
  companionWorkspaceTasksParamsSchema,
  companionWorkspaceTasksResultSchema,
  type CompanionWorkspaceTasksResult,
} from "@zcode/shared/companion-protocol";
import { decideDeviceWorkspaceAccess } from "../domain/grants.js";
import type { ControlStore, Clock, HubLogger, MobileLink, NodeLink } from "./ports.js";

const TASK_SUMMARY_TTL_MS = 30_000;
const NODE_REQUEST_TIMEOUT_MS = 20_000;

export interface WorkspaceTasksResolverDeps {
  store: ControlStore;
  clock: Clock;
  logger: HubLogger;
  resolveNodeLink(nodeId: string): NodeLink | null;
}

export type MobileResponsePayload =
  | { ok: true; result: CompanionWorkspaceTasksResult }
  | { ok: false; code: string; message: string };

export function createWorkspaceTasksResolver(deps: WorkspaceTasksResolverDeps) {
  const cache = new Map<string, { result: CompanionWorkspaceTasksResult; expiresAt: number }>();
  return {
    clear(): void {
      cache.clear();
    },
    async resolve(link: MobileLink, id: string, rawParams: unknown): Promise<void> {
      const parsed = companionWorkspaceTasksParamsSchema.safeParse(rawParams);
      if (!parsed.success) {
        link.respond(id, { ok: false, code: "bad_request", message: "invalid workspace-tasks params" });
        return;
      }
      const params = parsed.data;
      const device = await deps.store.getDevice(link.deviceId);
      const grants = await deps.store.getGrants(link.deviceId);
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
      const nodeLink = deps.resolveNodeLink(params.nodeId);
      if (!nodeLink) {
        link.respond(id, { ok: false, code: "node_offline", message: "node is offline" });
        return;
      }
      const cacheKey = `${params.nodeId}\0${params.workspaceIdentity}`;
      const now = deps.clock.now();
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        link.respond(id, { ok: true, result: cached.result });
        return;
      }
      const nodeResult = await nodeLink
        .request("workspace-tasks", { workspaceIdentity: params.workspaceIdentity }, NODE_REQUEST_TIMEOUT_MS)
        .catch((error: unknown) => ({
          ok: false as const,
          code: "node_offline",
          message: error instanceof Error ? error.message : "node request failed",
        }));
      if (!nodeResult.ok) {
        link.respond(id, { ok: false, code: nodeResult.code, message: nodeResult.message });
        return;
      }
      const parsedResult = companionWorkspaceTasksResultSchema.safeParse(nodeResult.result);
      if (!parsedResult.success) {
        deps.logger.warn("companion task summary malformed", { nodeId: params.nodeId });
        link.respond(id, { ok: false, code: "internal", message: "task summary malformed" });
        return;
      }
      cache.set(cacheKey, {
        result: parsedResult.data,
        expiresAt: now + TASK_SUMMARY_TTL_MS,
      });
      link.respond(id, { ok: true, result: parsedResult.data });
    },
  };
}

export type WorkspaceTasksResolver = ReturnType<typeof createWorkspaceTasksResolver>;
