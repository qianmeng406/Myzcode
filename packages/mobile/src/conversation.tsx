// 会话视图：v4 transport 的正确用法与最小渲染。
// 协议事实（shared/src/zcode-protocol-v4）：
//  - conversation transport.subscribe 只接受 "conversation/<sessionId>" 主题；
//  - 帧形状 = { payload: { kind:"snapshot", snapshot } | { kind:"deltas", deltas[] } }，
//    snapshot.rows 是 rowsWindow（window 数组），增量是七个封闭操作；
//  - createSession 命令（sessionId=null）的 ACK result 携带新 sessionId。
// 模式显示/切换读 snapshot.config.mode，经 setMode 服务调用（facade 白名单面）。
// 完整投影/历史分页/模型切换是后续增量（模型选项面未开放，见 spec §9.1）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import {
  createAgentConversationTransport,
  type ConversationTransport,
} from "@zcode/ui/v4-agent-transport";
// 命令 clientId 必须与 clientHello 一致：companion attachment 的 connection
// scope 是 terminal-client 角色，envelope.clientId 不匹配会拒绝
// fault.command.clientMismatch（幂等归属也随之失真）。
import { getV4ClientId } from "@zcode/ui/v4-command-factory";
import {
  INITIAL_STATE,
  MODE_LABELS,
  applyFrame,
  type ConversationState,
} from "./conversationState.js";
import { agentServiceOf } from "./sessions.js";
import { InteractionCard } from "./interactionCard.js";

export interface ConversationTarget {
  node: string;
  workspacePath: string;
  workspaceIdentity: string;
  title: string;
}

const MODE_OPTIONS = ["build", "edit", "plan", "yolo"] as const;

export function ConversationView(props: {
  target: ConversationTarget;
  sessionId: string | null;
  accessor: IServiceAccessor;
  onBack: () => void;
}): React.ReactElement {
  const { target: view, sessionId: initialSessionId } = props;
  const [transport, setTransport] = useState<ConversationTransport | null>(null);
  const [state, setState] = useState<ConversationState>(() => ({
    ...INITIAL_STATE,
    sessionId: initialSessionId,
  }));
  const [draft, setDraft] = useState(() => {
    // 草稿按工作区身份持久；发送成功即清除。
    return window.sessionStorage.getItem(`zcode-draft:${view.workspaceIdentity}`) ?? "";
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const subscriptionRef = useRef<string | null>(null);

  useEffect(() => {
    window.sessionStorage.setItem(`zcode-draft:${view.workspaceIdentity}`, draft);
  }, [draft, view.workspaceIdentity]);

  useEffect(() => {
    let disposed = false;
    let currentTransport: ConversationTransport | null = null;
    const agentService = agentServiceOf(props.accessor);
    void (async () => {
      try {
        const newTransport = createAgentConversationTransport(agentService as never, {
          workspacePath: view.workspacePath,
          workspaceIdentity: view.workspaceIdentity,
        });
        currentTransport = newTransport;
        if (disposed) {
          currentTransport = null;
          return;
        }
        setTransport(newTransport);
        newTransport.onFrame((frame) => setState((previous) => applyFrame(previous, frame)));
        // 既有会话：进入即订阅；新任务：等 createSession ACK 带回 sessionId。
        if (initialSessionId !== null) {
          const subscribeResult = await newTransport.subscribe({
            topic: `conversation/${initialSessionId}`,
            visibility: "foreground",
          });
          subscriptionRef.current = subscribeResult.ack.subscriptionId;
          newTransport.activate(subscribeResult.ack.subscriptionId);
        }
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 通道按目标/连接代次建立；重建由 accessor 换新触发
  }, [props.accessor, view.workspaceIdentity, initialSessionId]);

  const newCommandId = useCallback(
    (): string => `mob-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    [],
  );

  /**
   * 命令发送 + ACK 丢失对账：断线/超时时发送结局不确定，先 queryCommands
   * 查真实结局——accepted 按成功继续，unknown 显示"未确认"且不自动重发
   * （避免重复建任务/重复输入；对账本身失败也按未确认处理）。
   */
  const sendCommandWithReconcile = useCallback(
    async (
      activeTransport: ConversationTransport,
      envelope: CommandEnvelope,
    ): Promise<{ ack: CommandAck | null; unconfirmed: boolean }> => {
      try {
        return { ack: await activeTransport.sendCommand(envelope), unconfirmed: false };
      } catch {
        const item = await activeTransport
          .queryCommands({ commands: [{ sessionId: envelope.sessionId, commandId: envelope.commandId }] })
          .then((result) => result.results[0]?.result ?? null)
          .catch(() => null);
        if (item !== null && item !== "unknown") return { ack: item, unconfirmed: false };
        return { ack: null, unconfirmed: true };
      }
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
      const current = stateRef.current;
      if (current.sessionId === null) {
        // 首条输入：createSession（sessionId=null），ACK result 带回新会话 id。
        const { ack, unconfirmed } = await sendCommandWithReconcile(activeTransport, {
          commandId: newCommandId(),
          clientId: getV4ClientId(),
          sessionId: null,
          type: "createSession",
          payload: {
            workspaceId: view.workspaceIdentity,
            firstInput: { text },
          },
          issuedAt: Date.now(),
        });
        if (unconfirmed) {
          // 不自动重发：任务可能已在桌面落定，重复提交会产生两个任务。
          setError("网络中断，任务提交结果未确认；请返回列表查看是否已创建，勿重复发送。");
          return;
        }
        if (ack!.status !== "accepted") {
          setError(`任务未被接受：${ack!.reasonCode ?? ack!.status}`);
          return;
        }
        const result = ack!.result;
        const sessionId =
          result !== undefined && result.type === "createSession" ? result.sessionId : null;
        if (sessionId === null) {
          setError("会话创建结果缺少 sessionId");
          return;
        }
        window.sessionStorage.removeItem(`zcode-draft:${view.workspaceIdentity}`);
        setDraft("");
        setState((previous) => ({ ...previous, sessionId }));
        const subscribeResult = await activeTransport.subscribe({
          topic: `conversation/${sessionId}`,
          visibility: "foreground",
        });
        subscriptionRef.current = subscribeResult.ack.subscriptionId;
        activeTransport.activate(subscribeResult.ack.subscriptionId);
        return;
      }
      const { ack, unconfirmed } = await sendCommandWithReconcile(activeTransport, {
        commandId: newCommandId(),
        clientId: getV4ClientId(),
        sessionId: current.sessionId,
        type: "sendText",
        payload: { text, displayText: text },
        issuedAt: Date.now(),
      });
      if (unconfirmed) {
        setError("网络中断，发送结果未确认；请稍后在会话中确认，勿重复发送。");
        return;
      }
      if (ack!.status !== "accepted") {
        setError(`输入未被接受：${ack!.reasonCode ?? ack!.status}`);
        return;
      }
      window.sessionStorage.removeItem(`zcode-draft:${view.workspaceIdentity}`);
      setDraft("");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setBusy(false);
    }
  }, [transport, draft, view.workspaceIdentity, newCommandId, sendCommandWithReconcile]);

  const stop = useCallback(async (): Promise<void> => {
    const activeTransport = transport;
    const current = stateRef.current;
    if (activeTransport === null || current.sessionId === null) return;
    setBusy(true);
    try {
      const { ack, unconfirmed } = await sendCommandWithReconcile(activeTransport, {
        commandId: newCommandId(),
        clientId: getV4ClientId(),
        sessionId: current.sessionId,
        type: "stop",
        payload: {},
        issuedAt: Date.now(),
      });
      // 停止语义幂等且结果由权威快照收口：未确认时静默，不误导也不重发。
      if (!unconfirmed && ack !== null && ack.status === "rejected") {
        setError(`停止未被接受：${ack.reasonCode ?? ack.status}`);
      }
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
    } finally {
      setBusy(false);
    }
  }, [transport, newCommandId, sendCommandWithReconcile]);

  const answerInteraction = useCallback(
    async (interactionId: string, answer: { optionId?: string; freeText?: string }): Promise<void> => {
      const activeTransport = transport;
      const current = stateRef.current;
      if (activeTransport === null || current.sessionId === null) return;
      try {
        // 先到先得由运行时保证（迟到 noop）；已处理的请求点击无效果属预期。
        await activeTransport.sendCommand({
          commandId: newCommandId(),
          clientId: getV4ClientId(),
          sessionId: current.sessionId,
          type: "resolveInteraction",
          payload: { interactionId, answer },
          issuedAt: Date.now(),
        });
      } catch (answerError) {
        setError(answerError instanceof Error ? answerError.message : String(answerError));
      }
    },
    [transport, newCommandId],
  );

  const switchMode = useCallback(
    async (mode: string): Promise<void> => {
      const current = stateRef.current;
      if (current.sessionId === null) return;
      try {
        await agentServiceOf(props.accessor).setMode({
          workspacePath: view.workspacePath,
          workspaceIdentity: view.workspaceIdentity,
          sessionId: current.sessionId,
          mode: mode as never,
        });
      } catch (modeError) {
        setError(modeError instanceof Error ? modeError.message : String(modeError));
      }
    },
    [props.accessor, view.workspacePath, view.workspaceIdentity],
  );

  const rendered = useMemo(() => state.rows.filter((row) => row.text !== ""), [state.rows]);

  return (
    <div className="app">
      <header className="topbar">
        <button className="button secondary" onClick={props.onBack}>
          ←
        </button>
        <h1>{state.sessionId === null ? "新任务" : view.title}</h1>
        {state.sessionId !== null && (
          <button className="button danger" disabled={busy} onClick={() => void stop()}>
            停止
          </button>
        )}
      </header>
      {error !== null && <div className="error" style={{ padding: "0 16px" }}>{error}</div>}
      <div className="content">
        {transport === null && <p className="muted">正在建立数据通道…</p>}
        {state.modelLabel !== null && (
          <p className="muted" style={{ textAlign: "left", padding: "4px 0" }}>
            模型 {state.modelLabel}
            {state.mode !== null ? ` · 模式 ${MODE_LABELS[state.mode] ?? state.mode}` : ""}
          </p>
        )}
        {state.sessionId !== null && (
          <div className="answer" style={{ marginBottom: 8 }}>
            {MODE_OPTIONS.map((mode) => (
              <button
                key={mode}
                className={`button secondary`}
                style={state.mode === mode ? { outline: "2px solid #4f7cff" } : undefined}
                disabled={busy}
                onClick={() => void switchMode(mode)}
              >
                {MODE_LABELS[mode]}
              </button>
            ))}
          </div>
        )}
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
          <InteractionCard
            key={interaction.interactionId}
            interaction={interaction}
            disabled={state.sessionId === null}
            onAnswer={answerInteraction}
          />
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
