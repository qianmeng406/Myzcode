// 工作区目录视图：完整 UI 入口卡 + 节点分组的工作区列表（10s 轮询）。
import { useEffect, useState } from "react";
import type { CompanionClient } from "@zcode/companion/client";
import type { CompanionCatalogResult } from "@zcode/shared/companion-protocol";

export function CatalogView(props: {
  ensureClient: () => Promise<CompanionClient>;
  onOpen: (nodeId: string, workspacePath: string, workspaceIdentity: string, title: string) => void;
  onOpenFullUi: () => void;
}): React.ReactElement {
  const [catalog, setCatalog] = useState<CompanionCatalogResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    // interval 句柄必须挂在 effect 作用域：写在 async IIFE 内 return 的清理函数
    // 不会被 React 采用，组件卸载后 10s 轮询会泄漏。
    let interval: ReturnType<typeof setInterval> | null = null;
    void (async () => {
      try {
        const load = async (): Promise<void> => {
          // 每轮重取：掉线重连后 session 换新 client 实例，旧实例调用只会失败一轮。
          const client = await props.ensureClient();
          const result = await client.catalog();
          if (!disposed) setCatalog(result);
        };
        await load();
        if (disposed) return;
        interval = setInterval(() => void load().catch(() => undefined), 10_000);
      } catch (catalogError) {
        if (!disposed) {
          setError(catalogError instanceof Error ? catalogError.message : String(catalogError));
        }
      }
    })();
    return () => {
      disposed = true;
      if (interval !== null) clearInterval(interval);
    };
  }, [props.ensureClient]);
  const onlineCount = catalog?.nodes.filter((node) => node.online).length ?? 0;
  const workspaceCount =
    catalog?.nodes.reduce((sum, node) => sum + node.workspaces.length, 0) ?? 0;
  return (
    <div className="content">
      {error !== null && <div className="error">{error}</div>}
      <button className="feature-card" onClick={props.onOpenFullUi}>
        <span className="feature-main">
          <span className="feature-title">打开完整界面</span>
          <span className="feature-sub">桌面级完整 UI · 工作区 / 差异 / 文件树</span>
        </span>
        <span className="feature-arrow">›</span>
      </button>

      <div className="section-label">
        <span>工作区</span>
        {catalog !== null && (
          <span className="section-meta">{onlineCount} 台在线 · {workspaceCount} 个工作区</span>
        )}
      </div>

      {catalog === null && <p className="muted">正在加载工作区…</p>}
      {catalog !== null && catalog.nodes.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">⌘</div>
          <p>还没有已连接的设备</p>
          <p className="empty-sub">在电脑端「Myzcode 桌面直连」弹窗生成配对码</p>
        </div>
      )}
      {catalog?.nodes.map((node) => (
        <div key={node.nodeId} className="node-group">
          <div className="node-header">
            <span className={node.online ? "dot on" : "dot off"} />
            <span className="node-name">{node.displayName}</span>
            <span className={node.kind === "cloud" ? "node-chip cloud" : "node-chip desktop"}>
              {node.kind === "cloud" ? "云端" : "电脑"}
            </span>
            <span className={node.online ? "node-state on" : "node-state off"}>
              {node.online ? "在线" : "离线"}
            </span>
          </div>
          {node.workspaces.map((workspace) => (
            <button
              key={`${node.nodeId}:${workspace.workspaceIdentity}`}
              className="ws-row"
              disabled={!node.online || !workspace.available}
              onClick={() =>
                props.onOpen(node.nodeId, workspace.workspacePath, workspace.workspaceIdentity, workspace.title)
              }
            >
              <span className="ws-icon">▣</span>
              <span className="ws-main">
                <span className="ws-title">{workspace.title}</span>
                <span className="ws-path">{workspace.workspacePath}</span>
              </span>
              <span className={workspace.available && node.online ? "ws-badge ok" : "ws-badge off"}>
                {workspace.available ? (node.online ? "可用" : "离线") : "不可用"}
              </span>
              <span className="ws-arrow">›</span>
            </button>
          ))}
          {node.online && node.workspaces.length === 0 && (
            <p className="node-empty">该节点未开放工作区</p>
          )}
        </div>
      ))}
    </div>
  );
}
