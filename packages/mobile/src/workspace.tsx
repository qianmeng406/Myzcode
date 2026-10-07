// 工作区容器：attach + relay 通道提升到工作区级（hub 不变量：每设备至多一个
// attachment）。默认渲染会话列表，点开/新建进入会话视图；返回列表不拆 attachment，
// 返回目录才 detach。
import { useCallback, useEffect, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { CompanionAttachResult } from "@zcode/shared/companion-protocol";
import type { CompanionClient } from "@zcode/companion/client";
import type { ConversationTarget } from "./conversation.js";
import { ConversationView } from "./conversation.js";
import { SessionsListView } from "./sessions.js";

interface Attachment {
  attachResult: CompanionAttachResult;
  accessor: IServiceAccessor;
  close: () => void;
}

export function WorkspaceView(props: {
  target: ConversationTarget;
  ensureClient: () => Promise<CompanionClient>;
  /** 连接代次：控制面掉线重连成功后 +1，触发 re-attach 与订阅重建。 */
  connectionEpoch: number;
  onBackToCatalog: () => void;
}): React.ReactElement {
  const { target } = props;
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = 会话列表；非 null = 打开的会话（"" 表示新任务，创建后由 ACK 回填）。
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const attachRef = useRef<Attachment | null>(null);
  attachRef.current = attachment;

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
      // 只关 relay 通道；detach 由返回目录（onBackToCatalog）统一处理。
      attachRef.current?.close();
      attachRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 每个工作区/每代连接建立一次
  }, [target.node, target.workspaceIdentity, props.connectionEpoch]);

  const backToCatalog = useCallback(() => {
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
        props.onBackToCatalog();
      });
  }, [props]);

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
  if (openSessionId === null) {
    return (
      <div className="app">
        {banner}
        <SessionsListView
          accessor={attachment.accessor}
          target={target}
          onOpen={setOpenSessionId}
          onNewTask={() => setOpenSessionId("")}
        />
      </div>
    );
  }
  return (
    <div className="app">
      {banner}
      <ConversationView
        target={target}
        sessionId={openSessionId === "" ? null : openSessionId}
        accessor={attachment.accessor}
        onBack={() => setOpenSessionId(null)}
      />
    </div>
  );
}
