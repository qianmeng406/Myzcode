// 只读任务摘要（specs §11.4 跨工作区任务索引）：对既有运行时做一次
// existing-only 的 sessions-index 订阅，取首个权威快照即退订并释放上游。
// - 不新建执行者：start-if-needed 只属于手机显式进入工作区路径（sessions.tsx），
//   目录索引读取一律 existing-only；
// - 不携带正文/命令/答案，只有目录展示所需最小字段；
// - 全程硬超时，任何失败都返回 available:false（不挂起控制面、不抛给 hub）。
import { ProxyChannel } from "@zcode/rpc";
import { IZCodeAgentService } from "@zcode/services";
import {
  TopicWireFrameAssembler,
  V4_WIRE_PROTOCOL_VERSION,
  sessionsIndexTopicFrameSchema,
  type TopicWireFrameCandidate,
  type TopicWireAssemblyEvent,
  type SessionsIndexTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import type { CompanionWorkspaceTasksResult } from "@zcode/shared/companion-protocol";
import type { RelayAttachmentUpstream } from "./relayAttachment.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_SESSIONS = 20;
const TITLE_MAX_CHARS = 200;

interface AgentV4ClientPick {
  helloConversationV4(): Promise<unknown>;
  initializeConversationV4(clientHello: unknown): Promise<void>;
  subscribeSessionsIndexV4(params: Record<string, unknown>): Promise<{ ack: { subscriptionId: string } }>;
  unsubscribeSessionsIndexV4(params: Record<string, unknown>): Promise<void>;
  onDynamicSessionsIndexFrame(params: Record<string, unknown>): (
    listener: (candidate: TopicWireFrameCandidate) => void,
  ) => { dispose(): void };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * 读取一个工作区的任务摘要。createUpstream 由 connector 供给
 * （云端 = daemon loopback TCP 握手；桌面 = 窗口 Host 临时 attachment 端口）。
 * 任何失败（上游建连失败/hello 拒绝/超时）都返回 available:false。
 */
export async function readWorkspaceTaskSummary(options: {
  workspacePath: string;
  workspaceIdentity: string;
  createUpstream: () => Promise<RelayAttachmentUpstream>;
  clientId?: string;
  timeoutMs?: number;
  log?: (message: string, details?: Record<string, unknown>) => void;
}): Promise<CompanionWorkspaceTasksResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const run = async (): Promise<CompanionWorkspaceTasksResult> => {
    const upstream = await options.createUpstream();
    let activeService: AgentV4ClientPick | null = null;
    let subscriptionId: string | null = null;
    let frameDisposable: { dispose(): void } | null = null;
    try {
      activeService = ProxyChannel.toService<AgentV4ClientPick>(
        upstream.channelClient.getChannel(IZCodeAgentService.channelName),
      );
      // 帧监听必须先于订阅：快照帧可能在 subscribe ACK 返回前就到。
      let notifyFrame: ((candidate: TopicWireFrameCandidate) => void) | null = null;
      frameDisposable = activeService.onDynamicSessionsIndexFrame({
        workspacePath: options.workspacePath,
        workspaceIdentity: options.workspaceIdentity,
      })((candidate) => {
        notifyFrame?.(candidate);
      });
      const firstSnapshot = new Promise<SessionsIndexTopicFrame>((resolve) => {
        const assembler = new TopicWireFrameAssembler<SessionsIndexTopicFrame>(
          sessionsIndexTopicFrameSchema,
        );
        notifyFrame = (candidate) => {
          const events: TopicWireAssemblyEvent<SessionsIndexTopicFrame>[] = assembler.accept(
            candidate,
            Date.now(),
          );
          for (const event of events) {
            if (event.kind !== "complete") continue;
            const parsed = sessionsIndexTopicFrameSchema.safeParse(event.frame);
            if (!parsed.success) continue;
            if (parsed.data.payload.kind === "snapshot") {
              resolve(parsed.data);
              return;
            }
          }
        };
      });

      await withTimeout(activeService.helloConversationV4(), remaining(deadline), "v4 hello");
      await withTimeout(
        activeService.initializeConversationV4({
          kind: "clientHello",
          protocolVersion: V4_WIRE_PROTOCOL_VERSION,
          clientId: options.clientId ?? "companion-task-index",
          clientKind: "web",
          appVersion: "unknown",
          capabilities: { workspaceHookReviewUi: true },
        }),
        remaining(deadline),
        "v4 clientHello",
      );
      const ack = await withTimeout(
        activeService.subscribeSessionsIndexV4({
          workspacePath: options.workspacePath,
          workspaceIdentity: options.workspaceIdentity,
          // 目录索引读取绝不拉起执行者（与手机显式进入工作区的 start-if-needed 相区分）。
          runtimePolicy: "existing-only",
          visibility: "foreground",
        }),
        remaining(deadline),
        "sessions-index subscribe",
      );
      subscriptionId = ack.ack.subscriptionId;
      const frame = await withTimeout(firstSnapshot, remaining(deadline), "sessions-index snapshot");
      if (frame.payload.kind !== "snapshot") {
        // 首帧必为快照（fresh subscribe）；出现增量即视为异常，按不可用处理。
        return { generatedAt: Date.now(), available: false, sessions: [] };
      }
      const items = frame.payload.snapshot.sessions
        .slice()
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
        .slice(0, MAX_SESSIONS)
        .map((session) => {
          const pending = session.pendingInteractionSummary
            ? session.pendingInteractionSummary.permissionCount +
              session.pendingInteractionSummary.userInputCount
            : 0;
          return {
            sessionId: session.sessionId,
            title: session.title.slice(0, TITLE_MAX_CHARS),
            sessionEnded: session.sessionEnded,
            pendingCount: pending,
            lastActivityAt: session.lastActivityAt,
          };
        });
      return { generatedAt: Date.now(), available: true, sessions: items };
    } finally {
      if (subscriptionId !== null && activeService !== null) {
        // 快照到手即退订；失败不影响已取得的结果。
        try {
          await activeService.unsubscribeSessionsIndexV4({
            workspacePath: options.workspacePath,
            workspaceIdentity: options.workspaceIdentity,
            subscriptionId,
          });
        } catch {
          // 上游随即整体释放。
        }
      }
      frameDisposable?.dispose();
      upstream.dispose();
    }
  };
  try {
    return await withTimeout(run(), timeoutMs + 2_000, "task summary read");
  } catch (error) {
    options.log?.("workspace task summary read failed", {
      workspaceIdentity: options.workspaceIdentity.slice(0, 64),
      error: error instanceof Error ? error.message : String(error),
    });
    return { generatedAt: Date.now(), available: false, sessions: [] };
  }
}

function remaining(deadline: number): number {
  return Math.max(250, deadline - Date.now());
}
