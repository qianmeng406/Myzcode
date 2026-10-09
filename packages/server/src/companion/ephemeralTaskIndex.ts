// 只读任务摘要（specs §11.4 跨工作区任务索引）：对既有运行时做一次
// existing-only 的 sessions-index 订阅，取首个权威快照即退订并释放上游。
// - 不新建执行者：start-if-needed 只属于手机显式进入工作区路径（sessions.tsx），
//   目录索引读取一律 existing-only；
// - 不携带正文/命令/答案，只有目录展示所需最小字段；
// - 全程硬超时，任何失败都返回 available:false（不挂起控制面、不抛给 hub）。
//
// 双读路径（phase-1 修复）：sessions-index 只在**该工作区 agent 运行时已在跑**时
// 可读（Host 端 getReadOnlyClient 的 existing-only 分支在无运行时直接抛
// "ZCode Agent runtime is not running"——这不是错误而是既有语义）。只靠它会让
// 侧栏里所有"本会话尚未启动运行时"的共享工作区都显示「暂无任务」，而桌面端同一
// 侧栏能列出它们的磁盘任务（走 window-controller.listTaskList 的磁盘链路）。
// 因此这里补一条纯磁盘兜底：同一临时端口上的 IZCodeTaskService.listTasks 直接读
// tasks-index 持久化，不启动任何执行者。sessions-index 可用时优先（含实时
// sessionEnded/pendingInteractionSummary），不可用时回落磁盘历史。
import { ProxyChannel } from "@zcode/rpc";
import { IZCodeAgentService, IZCodeTaskService } from "@zcode/services";
import {
  TopicWireFrameAssembler,
  V4_WIRE_PROTOCOL_VERSION,
  sessionsIndexTopicFrameSchema,
  type TopicWireFrameCandidate,
  type TopicWireAssemblyEvent,
  type SessionsIndexTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  CompanionWorkspaceTaskItem,
  CompanionWorkspaceTasksResult,
} from "@zcode/shared/companion-protocol";
import type { RelayAttachmentUpstream } from "./relayAttachment.js";

const DEFAULT_TIMEOUT_MS = 8_000;
/** sessions-index 尝试的预算上限：必须给它留出磁盘兜底的时间，不能吃满总预算。 */
const SESSIONS_INDEX_ATTEMPT_MS = 4_000;
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

/** 磁盘任务读面：只取目录展示所需字段的服务子集（不引入写方法）。 */
interface TaskListClientPick {
  listTasks(params: { workspacePath: string; workspaceIdentity?: string }): Promise<
    Array<{
      taskId: string;
      title: string;
      updatedAt: number;
      status?: "running" | "completed" | "error";
      pendingInteraction?: { interactionId: string; kind: "permission" | "userInput" };
    }>
  >;
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

function toItem(session: {
  sessionId: string;
  title: string;
  sessionEnded: boolean;
  pendingCount: number;
  lastActivityAt: number;
}): CompanionWorkspaceTaskItem {
  return {
    sessionId: session.sessionId,
    title: session.title.slice(0, TITLE_MAX_CHARS),
    sessionEnded: session.sessionEnded,
    pendingCount: session.pendingCount,
    lastActivityAt: session.lastActivityAt,
  };
}

function trimAndSort(items: CompanionWorkspaceTaskItem[]): CompanionWorkspaceTaskItem[] {
  return items
    .slice()
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, MAX_SESSIONS);
}

/**
 * sessions-index 读面（权威、实时）。返回 null = 该读面不可用（无运行时/超时），
 * 由调用方决定是否回落磁盘；此处不抛错，避免把兜底路径一起打断。
 */
async function readViaSessionsIndex(options: {
  workspacePath: string;
  workspaceIdentity: string;
  channelClient: RelayAttachmentUpstream["channelClient"];
  clientId?: string;
  deadline: number;
  log?: (message: string, details?: Record<string, unknown>) => void;
}): Promise<CompanionWorkspaceTaskItem[] | null> {
  let activeService: AgentV4ClientPick | null = null;
  let subscriptionId: string | null = null;
  let frameDisposable: { dispose(): void } | null = null;
  try {
    activeService = ProxyChannel.toService<AgentV4ClientPick>(
      options.channelClient.getChannel(IZCodeAgentService.channelName),
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

    await withTimeout(activeService.helloConversationV4(), remaining(options.deadline), "v4 hello");
    await withTimeout(
      activeService.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        clientId: options.clientId ?? "companion-task-index",
        clientKind: "web",
        appVersion: "unknown",
        capabilities: { workspaceHookReviewUi: true },
      }),
      remaining(options.deadline),
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
      remaining(options.deadline),
      "sessions-index subscribe",
    );
    subscriptionId = ack.ack.subscriptionId;
    const frame = await withTimeout(firstSnapshot, remaining(options.deadline), "sessions-index snapshot");
    if (frame.payload.kind !== "snapshot") {
      // 首帧必为快照（fresh subscribe）；出现增量即视为异常，交给磁盘兜底。
      return null;
    }
    const items = trimAndSort(
      frame.payload.snapshot.sessions.map((session) =>
        toItem({
          sessionId: session.sessionId,
          title: session.title,
          sessionEnded: session.sessionEnded,
          pendingCount: session.pendingInteractionSummary
            ? session.pendingInteractionSummary.permissionCount +
              session.pendingInteractionSummary.userInputCount
            : 0,
          lastActivityAt: session.lastActivityAt,
        }),
      ),
    );
    return items;
  } catch (error) {
    options.log?.("workspace task summary sessions-index unavailable", {
      workspaceIdentity: options.workspaceIdentity.slice(0, 64),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
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
  }
}

/**
 * 磁盘任务读面（兜底）：直接读 tasks-index 持久化，不需要 agent 运行时在跑。
 * 返回 null = 该读面也不可用（通道未暴露/超时）。
 */
async function readViaTaskIndex(options: {
  workspacePath: string;
  workspaceIdentity: string;
  channelClient: RelayAttachmentUpstream["channelClient"];
  deadline: number;
  log?: (message: string, details?: Record<string, unknown>) => void;
}): Promise<CompanionWorkspaceTaskItem[] | null> {
  try {
    const taskService = ProxyChannel.toService<TaskListClientPick>(
      options.channelClient.getChannel(IZCodeTaskService.channelName),
    );
    const tasks = await withTimeout(
      taskService.listTasks({
        workspacePath: options.workspacePath,
        workspaceIdentity: options.workspaceIdentity,
      }),
      remaining(options.deadline),
      "task list read",
    );
    return trimAndSort(
      tasks.map((task) =>
        toItem({
          sessionId: task.taskId,
          title: typeof task.title === "string" ? task.title : "",
          // 磁盘 meta 没有 v4 的 sessionEnded 事实；status 已终态即视为会话已结束
          // （running/缺省一律按未结束，避免把活跃任务渲染成历史项）。
          sessionEnded: task.status === "completed" || task.status === "error",
          pendingCount: task.pendingInteraction ? 1 : 0,
          lastActivityAt: task.updatedAt,
        }),
      ),
    );
  } catch (error) {
    options.log?.("workspace task summary disk read failed", {
      workspaceIdentity: options.workspaceIdentity.slice(0, 64),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * 读取一个工作区的任务摘要。createUpstream 由 connector 供给
 * （云端 = daemon loopback TCP 握手；桌面 = 窗口 Host 临时 attachment 端口）。
 * 任何失败（上游建连失败/两条读面都不可用/超时）都返回 available:false。
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
    try {
      // sessions-index 先拿到一段自己的预算，剩余时间留给磁盘兜底，避免它超时吃满总预算。
      const sessionsDeadline = Math.min(deadline, Date.now() + SESSIONS_INDEX_ATTEMPT_MS);
      const fromSessions = await readViaSessionsIndex({
        workspacePath: options.workspacePath,
        workspaceIdentity: options.workspaceIdentity,
        channelClient: upstream.channelClient,
        ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
        deadline: sessionsDeadline,
        ...(options.log ? { log: options.log } : {}),
      });
      if (fromSessions !== null) {
        options.log?.("workspace task summary read", {
          workspaceIdentity: options.workspaceIdentity.slice(0, 80),
          source: "sessions-index",
          returned: fromSessions.length,
          newestAt: fromSessions[0]?.lastActivityAt ?? null,
        });
        return { generatedAt: Date.now(), available: true, sessions: fromSessions };
      }
      const fromDisk = await readViaTaskIndex({
        workspacePath: options.workspacePath,
        workspaceIdentity: options.workspaceIdentity,
        channelClient: upstream.channelClient,
        deadline,
        ...(options.log ? { log: options.log } : {}),
      });
      if (fromDisk !== null) {
        options.log?.("workspace task summary read", {
          workspaceIdentity: options.workspaceIdentity.slice(0, 80),
          source: "task-index",
          returned: fromDisk.length,
          newestAt: fromDisk[0]?.lastActivityAt ?? null,
        });
        return { generatedAt: Date.now(), available: true, sessions: fromDisk };
      }
      return { generatedAt: Date.now(), available: false, sessions: [] };
    } finally {
      upstream.dispose();
    }
  };
  try {
    return await withTimeout(run(), timeoutMs + 4_000, "task summary read");
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
