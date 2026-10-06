// 工作区会话列表：经既有 attachment 的 accessor 直接订阅 sessions-index 通道。
// 形状依据 shared/zcode-protocol-v4/sessions-index.ts（snapshot + 两个增量操作）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
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
  frame: { payload: { kind: string; snapshot?: unknown; deltas?: unknown[] } },
): SessionsIndexState {
  const sessions = new Map(state.sessions);
  if (frame.payload.kind === "snapshot") {
    const snapshot = frame.payload.snapshot as { sessions?: Array<SessionSummary> } | undefined;
    for (const session of snapshot?.sessions ?? []) {
      sessions.set(session.sessionId, session);
    }
    return { sessions };
  }
  for (const delta of (frame.payload.deltas ?? []) as Array<{
    op: string;
    session?: SessionSummary;
    sessionId?: string;
  }>) {
    if (delta.op === "session.upserted" && delta.session) {
      sessions.set(delta.session.sessionId, delta.session);
      continue;
    }
    if (delta.op === "session.removed" && delta.sessionId) {
      sessions.delete(delta.sessionId);
    }
  }
  return { sessions };
}

interface AgentServiceLike {
  subscribeSessionsIndexV4(params: {
    workspacePath: string;
    workspaceIdentity: string;
  }): Promise<{ ack: { subscriptionId: string } }>;
  unsubscribeSessionsIndexV4(params: {
    workspaceIdentity: string;
    subscriptionId: string;
  }): Promise<void>;
  onDynamicSessionsIndexFrame(params: {
    workspacePath: string;
    workspaceIdentity: string;
  }): (listener: (frame: unknown) => void) => { dispose(): void };
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
  const [state, setState] = useState<SessionsIndexState>({ sessions: new Map() });
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let disposed = false;
    let unsubscribeFrame: (() => void) | null = null;
    let subscriptionId: string | null = null;
    const service = agentServiceOf(accessor);
    const target_ = { workspacePath: target.workspacePath, workspaceIdentity: target.workspaceIdentity };
    void (async () => {
      try {
        const unsubscribe = service.onDynamicSessionsIndexFrame(target_)((frame) => {
          setState((previous) => applySessionsFrame(previous, frame as never));
        });
        if (disposed) {
          unsubscribe.dispose();
          return;
        }
        unsubscribeFrame = () => unsubscribe.dispose();
        const result = await service.subscribeSessionsIndexV4(target_);
        subscriptionId = result.ack.subscriptionId;
      } catch (sessionsError) {
        if (!disposed) {
          setError(sessionsError instanceof Error ? sessionsError.message : String(sessionsError));
        }
      }
    })();
    return () => {
      disposed = true;
      unsubscribeFrame?.();
      if (subscriptionId !== null) {
        void service
          .unsubscribeSessionsIndexV4({ workspaceIdentity: target.workspaceIdentity, subscriptionId })
          .catch(() => undefined);
      }
    };
  }, [accessor, target.workspacePath, target.workspaceIdentity]);

  const sorted = useMemo(
    () =>
      [...state.sessions.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt),
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
        {sorted.length === 0 && <p className="muted">暂无会话；点「新任务」开始。</p>}
        {sorted.map((session) => (
          <button
            key={session.sessionId}
            className="card"
            onClick={() => props.onOpen(session.sessionId)}
          >
            {pendingCount(session) > 0 && <span className="dot warn" />}
            <span className={session.sessionEnded ? "muted-title" : undefined}>{session.title}</span>
            <div className="sub">
              {pendingCount(session) > 0
                ? `待处理 ${pendingCount(session)} 项 · `
                : ""}
              {session.lastAssistantPreview ?? session.phase}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
