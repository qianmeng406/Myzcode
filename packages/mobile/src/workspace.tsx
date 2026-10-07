// Chat 页容器：官方 WebRemoteControlMobileShell chat 分支的结构复刻
// （extract/pretty.js 62520：h-11 顶栏 + workspace header 紧凑条 + 内容区 +
// 加载浮层 + 重连 toast + 右侧滑入切换面板）。
// attach/relay 生命周期不变：每设备至多一个 attachment；切换工作区先 detach
// 旧目标再建新通道；返回首页统一 detach。
import { useCallback, useEffect, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { CompanionAttachResult, CompanionCatalogResult } from "@zcode/shared/companion-protocol";
import type { CompanionClient } from "@zcode/companion/client";
import type { ConversationTarget } from "./conversation.js";
import { ConversationView } from "./conversation.js";
import { MOBILE_CAPABILITIES } from "./mobileCapabilities.js";
import { ArrowLeftIcon, RefreshIcon, ThemeMenu, type ThemeName } from "./ui.js";

interface Attachment {
  attachResult: CompanionAttachResult;
  accessor: IServiceAccessor;
  close: () => void;
}

export interface SwitchCandidate {
  node: string;
  workspacePath: string;
  workspaceIdentity: string;
  title: string;
}

export function ChatView(props: {
  target: ConversationTarget;
  /** 首页任务直达：attach 成功后自动打开该会话（"" = 新任务草稿）。 */
  initialSessionId: string | null;
  ensureClient: () => Promise<CompanionClient>;
  /** 连接代次：控制面掉线重连成功后 +1，触发 re-attach 与订阅重建。 */
  connectionEpoch: number;
  /** history 栈耗尽时的直接回首页兜底。 */
  onBackHome: () => void;
  onSwitchWorkspace: (candidate: SwitchCandidate) => void;
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
}): React.ReactElement {
  const { target } = props;
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [candidates, setCandidates] = useState<SwitchCandidate[] | null>(null);
  const attachRef = useRef<Attachment | null>(null);
  attachRef.current = attachment;

  // Android 返回键优先关侧板（main.tsx backButton 接管后经此事件收口）。
  useEffect(() => {
    const close = (): void => setSwitcherOpen(false);
    window.addEventListener("zcode-close-sheets", close);
    return () => window.removeEventListener("zcode-close-sheets", close);
  }, []);

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
        // relay 断开（含控制面掉线引发的 attachment 拆除）：官方重连 toast；
        // 自动恢复由 connectionEpoch 变化触发本 effect 重跑（re-attach + 重建订阅）。
        channel.onClosed(() => {
          if (disposed) return;
          setError("relay-closed");
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
      // 只关 relay 通道；detach 由返回首页/切换工作区统一处理。
      attachRef.current?.close();
      attachRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 每个工作区/每代连接建立一次
  }, [target.node, target.workspaceIdentity, props.connectionEpoch]);

  /** detach 当前 attachment（切换工作区/返回首页共用）。 */
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

  const backHome = useCallback((): void => {
    // 官方语义：优先 history.back()（popstate 在 App 层收口回首页）。
    if (window.history.state?.zcodeMobilePage === "chat") {
      window.history.back();
      return;
    }
    detachCurrent();
    props.onBackHome();
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
            title: workspace.title,
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
      // 官方语义：跨工作区切换保持 chat 页，目标交换触发加载浮层。
      if (attachRef.current !== null) detachCurrent();
      setAttachment(null);
      setError(null);
      props.onSwitchWorkspace(candidate);
    },
    [detachCurrent, props],
  );

  const themeMenu = <ThemeMenu theme={props.theme} onThemeChange={props.onThemeChange} />;

  if (error !== null && error !== "relay-closed" && attachment === null) {
    // attach 失败：整页错误（保留官方顶栏与 header 骨架）。
    return (
      <div className="chatpage">
        <div className="chat-topbar">
          <button type="button" className="iconbtn" onClick={backHome} aria-label="返回任务首页">
            <ArrowLeftIcon />
          </button>
          <span className="title">任务会话</span>
          {themeMenu}
        </div>
        <div className="ws-header">
          <div className="ws-head-main">
            <div className="ws-head-title">{target.title}</div>
            <div className="ws-head-path">{target.workspacePath}</div>
          </div>
        </div>
        <div className="chat-body">
          <div className="chat-rows">
            <div className="error">{error}</div>
          </div>
        </div>
      </div>
    );
  }

  const switcher = switcherOpen && MOBILE_CAPABILITIES.workspaceSwitch ? (
    <>
      <button type="button" className="sheet-mask" aria-label="收起侧边面板" onClick={() => setSwitcherOpen(false)} />
      <div className="sheet">
        <div className="sheet-title">切换工作区</div>
        {candidates === null && <p className="muted">加载中…</p>}
        {candidates !== null && candidates.length === 0 && (
          <p className="muted">没有其他在线且可用的工作区</p>
        )}
        {candidates?.map((candidate) => (
          <button
            key={`${candidate.node}:${candidate.workspaceIdentity}`}
            type="button"
            className="card-btn"
            onClick={() => switchWorkspace(candidate)}
          >
            {candidate.title}
            <div className="sub">{candidate.workspacePath}</div>
          </button>
        ))}
      </div>
    </>
  ) : null;

  return (
    <div className="chatpage">
      <div className="chat-topbar">
        <button type="button" className="iconbtn" onClick={backHome} aria-label="返回任务首页">
          <ArrowLeftIcon />
        </button>
        <span className="title">任务会话</span>
        {themeMenu}
      </div>
      <div className="ws-header">
        <div className="ws-head-main">
          <div className="ws-head-title">{target.title}</div>
          <div className="ws-head-path">{target.workspacePath}</div>
        </div>
        {MOBILE_CAPABILITIES.workspaceSwitch && (
          <button type="button" className="iconbtn" aria-label="切换工作区" onClick={() => void openSwitcher()}>
            <RefreshIcon />
          </button>
        )}
      </div>
      <div className="chat-body">
        {attachment === null ? (
          <div className="chat-main">
            <div className="chat-rows">
              <p className="muted">正在连接工作区…</p>
            </div>
          </div>
        ) : (
          <ConversationView
            target={target}
            sessionId={props.initialSessionId === "" ? null : props.initialSessionId}
            accessor={attachment.accessor}
          />
        )}
        {switcher}
        {attachment === null ? (
          <div className="overlay-loading" aria-live="polite" aria-busy="true">
            <div className="overlay-card">
              <span className="spinner lg" />
              加载中...
            </div>
          </div>
        ) : null}
        {error === "relay-closed" ? (
          <div className="toast-reconnect" aria-live="polite" aria-busy="true">
            <div>
              <span className="spinner" />
              <span>正在自动重连...</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
