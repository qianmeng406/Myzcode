// 工作区会话列表：复用 @zcode/ui 的 sessions-index 专用传输层。
// 关键教训：wire 候选帧必须经 TopicWireDecoder 组装才是成品帧——直接读
// `frame.payload` 会拿到 undefined（真机阶段 4 实测崩溃），所以这里不手写解析。
// 幂等细节：subscribeSessionsIndexV4 带 runtimePolicy "existing-only"，
// 只附着既有运行时，不为列表拉起新 Agent。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { SessionsIndexTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { createAgentSessionsIndexTransport, type SessionsIndexTransport } from "@zcode/ui/v4-sessions-index-transport";
import type { ConversationTarget } from "./conversation.js";

interface SessionSummary {
  sessionId: string;
  title: string;
  phase: string;
  sessionEnded: boolean;
  pendingInteractionSummary?: { permissionCount: number; userInputCount: number };
  lastAssistantPreview?: string;
  lastActivityAt: number;
}

interface SessionsIndexState {
  sessions: Map<string, SessionSummary>;
}

function applySessionsFrame(
  state: SessionsIndexState,
  frame: SessionsIndexTopicFrame,
): SessionsIndexState {
  const sessions = new Map(state.sessions);
  const { payload } = frame;
  if (payload.kind === "snapshot") {
    for (const session of payload.snapshot.sessions) {
      sessions.set(session.sessionId, session);
    }
    return { sessions };
  }
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

export function SessionsListView(props: {
  accessor: IServiceAccessor;
  target: ConversationTarget;
  onOpen: (sessionId: string) => void;
  onNewTask: () => void;
}): React.ReactElement {
  const { target, accessor } = props;
  const [transport, setTransport] = useState<SessionsIndexTransport | null>(null);
  const [state, setState] = useState<SessionsIndexState>({ sessions: new Map() });
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const subscriptionRef = useRef<string | null>(null);

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

  const sorted = useMemo(
    () => [...state.sessions.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    [state.sessions],
  );
  const pendingCount = useCallback((session: SessionSummary): number => {
    const summary = session.pendingInteractionSummary;
    if (!summary) return 0;
    return summary.permissionCount + summary.userInputCount;
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <h1>{target.title}</h1>
        <button className="button" onClick={props.onNewTask}>
          新任务
        </button>
      </header>
      {error !== null && <div className="error" style={{ padding: "0 16px" }}>{error}</div>}
      <div className="content">
        {transport === null && <p className="muted">正在连接工作区…</p>}
        {sorted.length === 0 && transport !== null && (
          <p className="muted">暂无会话；点「新任务」开始。</p>
        )}
        {sorted.map((session) => (
          <button
            key={session.sessionId}
            className="card"
            onClick={() => props.onOpen(session.sessionId)}
          >
            {pendingCount(session) > 0 && <span className="dot warn" />}
            <span className={session.sessionEnded ? "muted-title" : undefined}>{session.title}</span>
            <div className="sub">
              {pendingCount(session) > 0 ? `待处理 ${pendingCount(session)} 项 · ` : ""}
              {session.lastAssistantPreview ?? session.phase}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
