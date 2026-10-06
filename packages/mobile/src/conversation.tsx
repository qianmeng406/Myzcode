// 会话视图：v4 transport 的正确用法与最小渲染。
// 协议事实（shared/src/zcode-protocol-v4）：
//  - conversation transport.subscribe 只接受 "conversation/<sessionId>" 主题；
//  - 帧形状 = { payload: { kind:"snapshot", snapshot } | { kind:"deltas", deltas[] } }，
//    snapshot.rows 是 rowsWindow（window 数组），增量是七个封闭操作；
//  - createSession 命令（sessionId=null）的 ACK result 携带新 sessionId。
// 完整投影/历史分页的复用是阶段 3 工作（specs/companion-gateway.md）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompanionClient, CompanionRelayChannel } from "@zcode/companion/client";
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import {
  createAgentConversationTransport,
  type ConversationTransport,
} from "@zcode/ui/v4-agent-transport";

export interface ConversationTarget {
  node: string;
  workspacePath: string;
  workspaceIdentity: string;
  title: string;
}

interface MobileRow {
  rowId: number;
  entityId: string;
  kind: string;
  text: string;
}

interface MobileInteraction {
  interactionId: string;
  kind: string;
  prompt: string;
  options: Array<{ optionId: string; label: string }>;
  freeText: boolean;
}

function rowText(raw: Record<string, unknown>): string {
  for (const key of ["text", "summary", "description", "title"]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  if (raw.payload && typeof raw.payload === "object") {
    const payload = raw.payload as Record<string, unknown>;
    for (const key of ["text", "summary", "description", "prompt"]) {
      const value = payload[key];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
  }
  return "";
}

function describeRow(raw: Record<string, unknown>): MobileRow {
  return {
    rowId: typeof raw.rowId === "number" ? raw.rowId : 0,
    entityId: typeof raw.entityId === "string" ? raw.entityId : "",
    kind: String(raw.kind ?? "row"),
    text: rowText(raw),
  };
}

function describeInteraction(raw: Record<string, unknown>): MobileInteraction | null {
  const interactionId = typeof raw.interactionId === "string" ? raw.interactionId : "";
  const kind = String(raw.kind ?? "");
  const payload = (raw.payload ?? {}) as Record<string, unknown>;
  if (interactionId === "") return null;
  if (kind === "permission") {
    const options = Array.isArray(payload.options) ? payload.options : [];
    return {
      interactionId,
      kind,
      prompt: typeof payload.summary === "string" ? payload.summary : "工具权限请求",
      options: options
        .filter((option): option is Record<string, unknown> => option !== null && typeof option === "object")
        .map((option) => ({
          optionId: String(option.optionId ?? ""),
          label: String(option.label ?? option.optionId ?? ""),
        }))
        .filter((option) => option.optionId !== ""),
      freeText: payload.freeText === true,
    };
  }
  if (kind === "userInput") {
    const options = Array.isArray(payload.options) ? payload.options : [];
    return {
      interactionId,
      kind,
      prompt: typeof payload.prompt === "string" ? payload.prompt : "Agent 提问",
      options: options
        .filter((option): option is Record<string, unknown> => option !== null && typeof option === "object")
        .map((option) => ({
          optionId: String(option.optionId ?? option.value ?? ""),
          label: String(option.label ?? option.value ?? ""),
        }))
        .filter((option) => option.optionId !== ""),
      freeText: payload.freeText === true,
    };
  }
  // workspaceHookReview 等其余类型：v1 只展示，不提供手机侧按钮（命令面未开放）。
  return { interactionId, kind, prompt: "待处理项（请在电脑端处理）", options: [], freeText: false };
}

interface ConversationState {
  sessionId: string | null;
  rows: MobileRow[];
  interactions: MobileInteraction[];
}

function applyFrame(state: ConversationState, frame: ConversationTopicFrame): ConversationState {
  const { payload } = frame;
  if (payload.kind === "snapshot") {
    const snapshot = payload.snapshot;
    return {
      sessionId: snapshot.sessionId,
      rows: (snapshot.rows.window as unknown as Record<string, unknown>[]).map(describeRow),
      interactions: snapshot.pendingInteractions
        .map((interaction) => describeInteraction(interaction as unknown as Record<string, unknown>))
        .filter((interaction): interaction is MobileInteraction => interaction !== null),
    };
  }
  let { sessionId, rows, interactions } = state;
  for (const delta of payload.deltas) {
    if (delta.op === "row.appended") {
      rows = [...rows, describeRow(delta.row as unknown as Record<string, unknown>)];
      continue;
    }
    if (delta.op === "row.upserted") {
      const row = describeRow(delta.row as unknown as Record<string, unknown>);
      rows = rows.map((existing) => (existing.rowId === row.rowId ? row : existing));
      continue;
    }
    if (delta.op === "row.removed") {
      rows = rows.filter((row) => row.rowId < delta.fromRowId);
      continue;
    }
    if (delta.op === "row.delta") {
      if (delta.path === "text") {
        rows = rows.map((row) =>
          row.rowId === delta.rowId ? { ...row, text: row.text + delta.append } : row,
        );
      }
      continue;
    }
    if (delta.op === "state.updated" && delta.patch.pendingInteractions !== undefined) {
      interactions = delta.patch.pendingInteractions
        .map((interaction) => describeInteraction(interaction as unknown as Record<string, unknown>))
        .filter((interaction): interaction is MobileInteraction => interaction !== null);
      continue;
    }
    // state.updated 其余键与 workflowRun.*：v1 渲染不消费。
  }
  return { sessionId, rows, interactions };
}

export function ConversationView(props: {
  target: ConversationTarget;
  ensureClient: () => Promise<CompanionClient>;
  onBack: () => void;
}): React.ReactElement {
  const { target: view } = props;
  const [transport, setTransport] = useState<ConversationTransport | null>(null);
  const [state, setState] = useState<ConversationState>({ sessionId: null, rows: [], interactions: [] });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const subscriptionRef = useRef<string | null>(null);
  const channelRef = useRef<CompanionRelayChannel | null>(null);

  useEffect(() => {
    let disposed = false;
    let currentTransport: ConversationTransport | null = null;
    void (async () => {
      try {
        const client = await props.ensureClient();
        const attachRaw = window.sessionStorage.getItem("zcode-companion-attach");
        if (!attachRaw) throw new Error("缺少 attach 结果");
        const attachResult = JSON.parse(attachRaw) as {
          attachmentId: string;
          relayPath: string;
          relayCapability: string;
        };
        window.sessionStorage.setItem("zcode-companion-attachment", attachResult.attachmentId);
        const openedChannel = await client.openRelayChannel(attachResult);
        if (disposed) {
          openedChannel.close();
          return;
        }
        channelRef.current = openedChannel;
        const agentService = (
          openedChannel.accessor as unknown as {
            zcodeAgentService: Record<string, unknown>;
          }
        ).zcodeAgentService as unknown as Parameters<typeof createAgentConversationTransport>[0];
        const newTransport = createAgentConversationTransport(agentService, {
          workspacePath: view.workspacePath,
          workspaceIdentity: view.workspaceIdentity,
        });
        currentTransport = newTransport;
        if (disposed) {
          currentTransport = null;
          openedChannel.close();
          return;
        }
        setTransport(newTransport);
        newTransport.onFrame((frame) => setState((previous) => applyFrame(previous, frame)));
      } catch (conversationError) {
        if (!disposed) {
          setError(conversationError instanceof Error ? conversationError.message : String(conversationError));
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
      channelRef.current?.close();
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 通道按目标建立一次；重建由返回目录触发
  }, [view.workspaceIdentity]);

  const newCommandId = useCallback(
    (): string => `mob-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    [],
  );

  const subscribeConversation = useCallback(
    async (activeTransport: ConversationTransport, sessionId: string): Promise<void> => {
      const subscribeResult = await activeTransport.subscribe({
        topic: `conversation/${sessionId}`,
        visibility: "foreground",
      });
      subscriptionRef.current = subscribeResult.ack.subscriptionId;
      activeTransport.activate(subscribeResult.ack.subscriptionId);
    },
    [],
  );

  const send = useCallback(async (): Promise<void> => {
    const activeTransport = transport;
    const text = draft.trim();
    if (activeTransport === null || text === "") return;
    setBusy(true);
    setError(null);
    try {
      setDraft("");
      const current = stateRef.current;
      if (current.sessionId === null) {
        // 首条输入：createSession（sessionId=null），ACK result 带回新会话 id。
        const ack = await activeTransport.sendCommand({
          commandId: newCommandId(),
          clientId: "my-zcode",
          sessionId: null,
          type: "createSession",
          payload: {
            workspaceId: view.workspaceIdentity,
            firstInput: { text },
          },
          issuedAt: Date.now(),
        });
        if (ack.status !== "accepted") {
          setError(`任务未被接受：${ack.reasonCode ?? ack.status}`);
          return;
        }
        const result = ack.result;
        const sessionId =
          result !== undefined && result.type === "createSession" ? result.sessionId : null;
        if (sessionId === null) {
          setError("会话创建结果缺少 sessionId");
          return;
        }
        setState((previous) => ({ ...previous, sessionId }));
        await subscribeConversation(activeTransport, sessionId);
        return;
      }
      const ack = await activeTransport.sendCommand({
        commandId: newCommandId(),
        clientId: "my-zcode",
        sessionId: current.sessionId,
        type: "sendText",
        payload: { text, displayText: text },
        issuedAt: Date.now(),
      });
      if (ack.status !== "accepted") {
        setError(`输入未被接受：${ack.reasonCode ?? ack.status}`);
      }
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setBusy(false);
    }
  }, [transport, draft, view.workspaceIdentity, newCommandId, subscribeConversation]);

  const stop = useCallback(async (): Promise<void> => {
    const activeTransport = transport;
    const current = stateRef.current;
    if (activeTransport === null || current.sessionId === null) return;
    setBusy(true);
    try {
      await activeTransport.sendCommand({
        commandId: newCommandId(),
        clientId: "my-zcode",
        sessionId: current.sessionId,
        type: "stop",
        payload: {},
        issuedAt: Date.now(),
      });
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
    } finally {
      setBusy(false);
    }
  }, [transport, newCommandId]);

  const answerInteraction = useCallback(
    async (interactionId: string, optionId: string): Promise<void> => {
      const activeTransport = transport;
      const current = stateRef.current;
      if (activeTransport === null || current.sessionId === null) return;
      try {
        // 先到先得由运行时保证（迟到 noop）；已处理的请求点击无效果属预期。
        await activeTransport.sendCommand({
          commandId: newCommandId(),
          clientId: "my-zcode",
          sessionId: current.sessionId,
          type: "resolveInteraction",
          payload: { interactionId, answer: { optionId } },
          issuedAt: Date.now(),
        });
      } catch (answerError) {
        setError(answerError instanceof Error ? answerError.message : String(answerError));
      }
    },
    [transport, newCommandId],
  );

  const rendered = useMemo(() => state.rows.filter((row) => row.text !== ""), [state.rows]);

  return (
    <div className="app">
      <header className="topbar">
        <button className="button secondary" onClick={props.onBack}>
          ←
        </button>
        <h1>{view.title}</h1>
        {state.sessionId !== null && (
          <button className="button danger" disabled={busy} onClick={() => void stop()}>
            停止
          </button>
        )}
      </header>
      {error !== null && <div className="error" style={{ padding: "0 16px" }}>{error}</div>}
      <div className="content">
        {transport === null && <p className="muted">正在建立数据通道…</p>}
        <div className="rows">
          {rendered.map((row) => (
            <div
              key={`${row.rowId}:${row.entityId}`}
              className={`row ${row.kind.includes("input") ? "user" : row.kind.includes("tool") ? "tool" : ""}`}
            >
              <div className="kind">{row.kind}</div>
              {row.text}
            </div>
          ))}
        </div>
        {state.interactions.map((interaction) => (
          <div key={interaction.interactionId} className="row">
            <div className="kind">{interaction.kind}</div>
            {interaction.prompt}
            <div className="answer">
              {interaction.options.map((option) => (
                <button
                  key={option.optionId}
                  className="button secondary"
                  disabled={state.sessionId === null}
                  onClick={() => void answerInteraction(interaction.interactionId, option.optionId)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        {rendered.length === 0 && state.interactions.length === 0 && transport !== null && (
          <p className="muted">
            {state.sessionId === null ? "在下方输入开始一个任务。" : "暂无会话内容。"}
          </p>
        )}
      </div>
      <div className="composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={state.sessionId === null ? "描述任务…" : "继续对话…"}
        />
        <button className="button" disabled={busy || draft.trim() === ""} onClick={() => void send()}>
          发送
        </button>
      </div>
    </div>
  );
}
