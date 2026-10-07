// 工作区容器：attach + relay 通道提升到工作区级（hub 不变量：每设备至多一个
// attachment）。会话打开 = pushState 进历史（Android 返回键回列表不退出 App）；
// 切换工作区 = detach 旧 attachment 后换目标；返回目录才统一 detach。
import { useCallback, useEffect, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { CompanionAttachResult, CompanionCatalogResult } from "@zcode/shared/companion-protocol";
import type { CompanionClient } from "@zcode/companion/client";
import type { ConversationTarget } from "./conversation.js";
import { ConversationView } from "./conversation.js";
import { SessionsListView } from "./sessions.js";

interface Attachment {
  attachResult: CompanionAttachResult;
  accessor: IServiceAccessor;
  close: () => void;
}

interface SwitchCandidate {
  node: string;
  workspacePath: string;
  workspaceIdentity: string;
  title: string;
}

export function WorkspaceView(props: {
  target: ConversationTarget;
  ensureClient: () => Promise<CompanionClient>;
  /** 连接代次：控制面掉线重连成功后 +1，触发 re-attach 与订阅重建。 */
  connectionEpoch: number;
  onBackToCatalog: () => void;
  onSwitchWorkspace: (candidate: SwitchCandidate) => void;
}): React.ReactElement {
  const { target } = props;
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = 会话列表（Home）；"" = 新任务；非空 = 打开的会话（Chat）。
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [candidates, setCandidates] = useState<SwitchCandidate[] | null>(null);
  const attachRef = useRef<Attachment | null>(null);
  attachRef.current = attachment;
  const openRef = useRef(openSessionId);
  openRef.current = openSessionId;
  const switcherRef = useRef(switcherOpen);
  switcherRef.current = switcherOpen;

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const client = await props.ensureClient();
        const attachResult = await client.attach({
          nodeId: target.node,
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
        });
        const channel = await client.openRelayChannel(attachResult);
        if (disposed) {
          channel.close();
          return;
        }
        // relay 断开（含控制面掉线引发的 attachment 拆除）：呈现重连横幅；
        // 自动恢复由 connectionEpoch 变化触发本 effect 重跑（re-attach + 重建订阅）。
        channel.onClosed(() => {
          if (disposed) return;
          setError("与工作区的连接已断开，正在自动恢复…");
        });
        const record: Attachment = {
          attachResult,
          accessor: channel.accessor,
          close: () => channel.close(),
        };
        attachRef.current = record;
        setAttachment(record);
        setError(null);
      } catch (attachError) {
        if (!disposed) {
          setError(attachError instanceof Error ? attachError.message : String(attachError));
        }
      }
    })();
    return () => {
      disposed = true;
      // 只关 relay 通道；detach 由返回目录/切换工作区统一处理。
      attachRef.current?.close();
      attachRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 每个工作区/每代连接建立一次
  }, [target.node, target.workspaceIdentity, props.connectionEpoch]);

  // Home/Chat 历史导航：打开会话压栈，Android/浏览器返回键经 popstate 回列表
  // （而非退出 App）；组件卸载时若栈里还留着 chat 项，交给宿主导航处理。
  useEffect(() => {
    const onPopState = (): void => {
      if (openRef.current !== null) setOpenSessionId(null);
      if (switcherRef.current) setSwitcherOpen(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const openSession = useCallback((sessionId: string): void => {
    window.history.pushState({ view: "chat", sessionId }, "");
    setOpenSessionId(sessionId);
  }, []);

  const backToSessions = useCallback((): void => {
    if (window.history.state?.view === "chat") {
      window.history.back(); // popstate 统一收口 setOpenSessionId(null)
      return;
    }
    setOpenSessionId(null);
  }, []);

  /** detach 当前 attachment（切换工作区/返回目录共用）。 */
  const detachCurrent = useCallback((): void => {
    const record = attachRef.current;
    void props
      .ensureClient()
      .then((client) =>
        record === null
          ? undefined
          : client.detach({ attachmentId: record.attachResult.attachmentId }),
      )
      .catch(() => undefined)
      .finally(() => {
        record?.close();
        attachRef.current = null;
      });
  }, [props]);

  const backToCatalog = useCallback((): void => {
    detachCurrent();
    props.onBackToCatalog();
  }, [detachCurrent, props]);

  const openSwitcher = useCallback(async (): Promise<void> => {
    setSwitcherOpen(true);
    setCandidates(null);
    try {
      const client = await props.ensureClient();
      const catalog: CompanionCatalogResult = await client.catalog();
      const list: SwitchCandidate[] = [];
      for (const node of catalog.nodes) {
        if (!node.online) continue;
        for (const workspace of node.workspaces) {
          if (!workspace.available) continue;
          if (node.nodeId === target.node && workspace.workspaceIdentity === target.workspaceIdentity) {
            continue;
          }
          list.push({
            node: node.nodeId,
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
            title: `${node.displayName} · ${workspace.title}`,
          });
        }
      }
      setCandidates(list);
    } catch {
      setCandidates([]);
    }
  }, [props, target.node, target.workspaceIdentity]);

  const switchWorkspace = useCallback(
    (candidate: SwitchCandidate): void => {
      setSwitcherOpen(false);
      // 掉线恢复期间 attachment 可能不在：无 record 也要让目标切换生效。
      if (openRef.current !== null) setOpenSessionId(null);
      if (attachRef.current !== null) detachCurrent();
      props.onSwitchWorkspace(candidate);
    },
    [detachCurrent, props],
  );

  if (error !== null && attachment === null) {
    // 无 attachment 的失败（attach 失败等）：整页错误，返回目录重试。
    return (
      <div className="app">
        <header className="topbar">
          <button className="button secondary" onClick={backToCatalog}>
            ←
          </button>
          <h1>{target.title}</h1>
        </header>
        <div className="content">
          <div className="error">{error}</div>
        </div>
      </div>
    );
  }
  if (attachment === null) {
    return (
      <div className="app">
        <header className="topbar">
          <button className="button secondary" onClick={props.onBackToCatalog}>
            ←
          </button>
          <h1>{target.title}</h1>
        </header>
        <div className="content">
          <p className="muted">正在连接工作区…</p>
        </div>
      </div>
    );
  }
  const banner =
    error !== null ? (
      <div className="error" style={{ padding: "0 16px" }}>
        {error}
      </div>
    ) : null;

  const switcher = switcherOpen ? (
    <div className="sheet-mask" onClick={() => setSwitcherOpen(false)}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-title">切换工作区</div>
        {candidates === null && <p className="muted">加载中…</p>}
        {candidates !== null && candidates.length === 0 && (
          <p className="muted">没有其他在线且可用的工作区</p>
        )}
        {candidates?.map((candidate) => (
          <button
            key={`${candidate.node}:${candidate.workspaceIdentity}`}
            className="card"
            onClick={() => switchWorkspace(candidate)}
          >
            {candidate.title}
            <div className="sub">{candidate.workspacePath}</div>
          </button>
        ))}
      </div>
    </div>
  ) : null;

  if (openSessionId === null) {
    return (
      <div className="app">
        {banner}
        <header className="topbar">
          <button className="button secondary" onClick={backToCatalog}>
            ←
          </button>
          <h1>{target.title}</h1>
          <button className="button secondary" onClick={() => void openSwitcher()}>
            切换
          </button>
        </header>
        <SessionsListView
          accessor={attachment.accessor}
          target={target}
          openSessionId={openSessionId}
          onOpen={openSession}
          onNewTask={() => openSession("")}
        />
        {switcher}
      </div>
    );
  }
  return (
    <div className="app">
      {banner}
      {/* 会话层自带顶栏（返回/停止），切换入口在会话列表层 */}
      <ConversationView
        target={target}
        sessionId={openSessionId === "" ? null : openSessionId}
        accessor={attachment.accessor}
        onBack={backToSessions}
      />
      {switcher}
    </div>
  );
}
