// 工作区会话列表：复用 @zcode/ui 的 sessions-index 专用传输层。
// 关键教训：wire 候选帧必须经 TopicWireDecoder 组装才是成品帧——直接读
// `frame.payload` 会拿到 undefined（真机阶段 4 实测崩溃），所以这里不手写解析。
// 幂等细节：subscribeSessionsIndexV4 用 runtimePolicy "start-if-needed"——
// 手机主动进入某工作区视为用户打开意图，允许常驻端为该工作区拉起 agent；
// 订阅本身不额外创造执行者（拉起只发生在这一条显式路径上）。
// 列表信息结构对齐官方任务首页：排序偏好持久化、状态胶囊、未读点、相对时间。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { SessionsIndexTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { createAgentSessionsIndexTransport, type SessionsIndexTransport } from "@zcode/ui/v4-sessions-index-transport";
import type { ConversationTarget } from "./conversation.js";
import { MOBILE_CAPABILITIES } from "./mobileCapabilities.js";

interface SessionSummary {
  sessionId: string;
  title: string;
  phase: string;
  sessionEnded: boolean;
  pendingInteractionSummary?: { permissionCount: number; userInputCount: number };
  lastAssistantPreview?: string;
  lastActivityAt: number;
  createdAt?: number;
}

interface SessionsIndexState {
  sessions: Map<string, SessionSummary>;
}

function applySessionsFrame(
  state: SessionsIndexState,
  frame: SessionsIndexTopicFrame,
): SessionsIndexState {
  const { payload } = frame;
  // snapshot 是权威全量（协议注释：conflated 最新态），必须整体替换——
  // 沿旧 Map 合并会让已不存在的会话永远残留（对齐 ui/v4/sessionsIndexStore 语义）。
  if (payload.kind === "snapshot") {
    const sessions = new Map<string, SessionSummary>();
    for (const session of payload.snapshot.sessions) {
      sessions.set(session.sessionId, session);
    }
    return { sessions };
  }
  const sessions = new Map(state.sessions);
  for (const delta of payload.deltas) {
    if (delta.op === "session.upserted") {
      sessions.set(delta.session.sessionId, delta.session);
      continue;
    }
    if (delta.op === "session.removed") {
      sessions.delete(delta.sessionId);
    }
  }
  return { sessions };
}

interface AgentServiceLike {
  // 传输层所需的 Pick 面；通过窄化 facade 代理时全部可用。
  helloConversationV4(): Promise<unknown>;
  initializeConversationV4(clientHello: unknown): Promise<void>;
  subscribeSessionsIndexV4(params: Record<string, unknown>): Promise<{ ack: { subscriptionId: string } }>;
  resyncSessionsIndexV4(params: Record<string, unknown>): Promise<unknown>;
  unsubscribeSessionsIndexV4(params: Record<string, unknown>): Promise<void>;
  onDynamicSessionsIndexFrame(params: Record<string, unknown>): (
    listener: (frame: unknown) => void,
  ) => { dispose(): void };
  onAgentRuntimeLifecycle?(listener: (state: "available" | "unavailable") => void): {
    dispose(): void;
  };
  setMode(params: {
    workspacePath: string;
    workspaceIdentity: string;
    sessionId: string;
    mode: string;
  }): Promise<unknown>;
}

export function agentServiceOf(accessor: IServiceAccessor): AgentServiceLike {
  return (accessor as unknown as { zcodeAgentService: AgentServiceLike }).zcodeAgentService;
}

// ── Home 信息结构（对齐官方 MobileTaskHome 的排序/状态/未读） ──

type HomeSort = "activity" | "created";
const SORT_KEY = "zcode-home-sort";

function loadSortPref(): HomeSort {
  return window.localStorage.getItem(SORT_KEY) === "created" ? "created" : "activity";
}

export function seenMapKey(workspaceIdentity: string): string {
  return `zcode-seen:${workspaceIdentity}`;
}

export function markSessionSeen(workspaceIdentity: string, sessionId: string, lastActivityAt: number): void {
  try {
    const key = seenMapKey(workspaceIdentity);
    const raw = window.localStorage.getItem(key);
    const seen = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    seen[sessionId] = Math.max(seen[sessionId] ?? 0, lastActivityAt);
    window.localStorage.setItem(key, JSON.stringify(seen));
  } catch {
    // 存储不可用只影响未读点，不阻塞功能。
  }
}

export function relativeTime(timestamp: number, now: number): string {
  const delta = Math.max(0, now - timestamp);
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

export function SessionsListView(props: {
  accessor: IServiceAccessor;
  target: ConversationTarget;
  /** 当前打开的会话（null = 列表层；该会话不显示未读点）。 */
  openSessionId: string | null;
  onOpen: (sessionId: string) => void;
  onNewTask: () => void;
}): React.ReactElement {
  const { target, accessor } = props;
  const [transport, setTransport] = useState<SessionsIndexTransport | null>(null);
  const [state, setState] = useState<SessionsIndexState>({ sessions: new Map() });
  const [error, setError] = useState<string | null>(null);
  const [sortPref, setSortPref] = useState<HomeSort>(loadSortPref);
  const [now, setNow] = useState(() => Date.now());
  const stateRef = useRef(state);
  stateRef.current = state;
  const subscriptionRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    let currentTransport: SessionsIndexTransport | null = null;
    const service = agentServiceOf(accessor);
    void (async () => {
      try {
        const newTransport = createAgentSessionsIndexTransport(service as never, {
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          // 手机进入工作区＝用户主动打开：常驻端应为该工作区拉起 agent。
          runtimePolicy: "start-if-needed",
        });
        currentTransport = newTransport;
        if (disposed) {
          currentTransport = null;
          return;
        }
        setTransport(newTransport);
        newTransport.onFrame((frame) => setState((previous) => applySessionsFrame(previous, frame)));
        const result = await newTransport.subscribe({ visibility: "foreground" });
        if (disposed) return;
        subscriptionRef.current = result.ack.subscriptionId;
        newTransport.activate(result.ack.subscriptionId);
      } catch (sessionsError) {
        if (!disposed) {
          setError(sessionsError instanceof Error ? sessionsError.message : String(sessionsError));
        }
      }
    })();
    return () => {
      disposed = true;
      const subscriptionId = subscriptionRef.current;
      subscriptionRef.current = null;
      if (currentTransport !== null && subscriptionId !== null) {
        void currentTransport.unsubscribe(subscriptionId).catch(() => undefined);
      }
      currentTransport = null;
    };
  }, [accessor, target.workspacePath, target.workspaceIdentity]);

  const pendingCount = useCallback((session: SessionSummary): number => {
    const summary = session.pendingInteractionSummary;
    if (!summary) return 0;
    return summary.permissionCount + summary.userInputCount;
  }, []);

  const sorted = useMemo(() => {
    const entries = [...state.sessions.values()];
    entries.sort((a, b) =>
      sortPref === "created"
        ? (b.createdAt ?? b.lastActivityAt) - (a.createdAt ?? a.lastActivityAt)
        : b.lastActivityAt - a.lastActivityAt,
    );
    return entries;
  }, [state.sessions, sortPref]);

  const switchSort = useCallback((next: HomeSort): void => {
    setSortPref(next);
    try {
      window.localStorage.setItem(SORT_KEY, next);
    } catch {
      // 忽略存储失败。
    }
  }, []);

  const isUnread = useCallback(
    (session: SessionSummary): boolean => {
      if (session.sessionEnded || session.sessionId === props.openSessionId) return false;
      let seen = 0;
      try {
        const raw = window.localStorage.getItem(seenMapKey(target.workspaceIdentity));
        if (raw) seen = (JSON.parse(raw) as Record<string, number>)[session.sessionId] ?? 0;
      } catch {
        // 读不到按未读过处理。
      }
      return session.lastActivityAt > seen;
    },
    [target.workspaceIdentity, props.openSessionId],
  );

  return (
    <div className="app">
      <header className="topbar">
        <h1>{target.title}</h1>
        {MOBILE_CAPABILITIES.taskCommands && (
          <button className="button" onClick={props.onNewTask}>
            新任务
          </button>
        )}
      </header>
      {error !== null && <div className="error" style={{ padding: "0 16px" }}>{error}</div>}
      <div className="sort-row" role="tablist" aria-label="排序">
        <button
          className={sortPref === "activity" ? "sort-chip on" : "sort-chip"}
          onClick={() => switchSort("activity")}
        >
          最近活动
        </button>
        <button
          className={sortPref === "created" ? "sort-chip on" : "sort-chip"}
          onClick={() => switchSort("created")}
        >
          创建时间
        </button>
      </div>
      <div className="content">
        {transport === null && <p className="muted">正在连接工作区…</p>}
        {sorted.length === 0 && transport !== null && (
          <p className="muted">暂无会话；点「新任务」开始。</p>
        )}
        {sorted.map((session) => {
          const pending = pendingCount(session);
          const unread = isUnread(session);
          return (
            <button
              key={session.sessionId}
              className="card"
              onClick={() => {
                markSessionSeen(target.workspaceIdentity, session.sessionId, session.lastActivityAt);
                props.onOpen(session.sessionId);
              }}
            >
              <div className="card-head">
                {unread && <span className="dot unread" />}
                {pending > 0 && <span className="dot warn" />}
                <span className={session.sessionEnded ? "muted-title" : undefined}>{session.title}</span>
                <span className={session.sessionEnded ? "pill ended" : "pill running"}>
                  {session.sessionEnded ? "已结束" : pending > 0 ? `待处理 ${pending}` : "运行中"}
                </span>
              </div>
              <div className="sub">
                {relativeTime(session.lastActivityAt, now)}
                {session.lastAssistantPreview ? ` · ${session.lastAssistantPreview}` : ""}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
