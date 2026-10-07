// 只读文件变更卡：turnHeader 摘要 → 按需拉取 unified diff 只读渲染。
// 不提供任何写操作（保存/stage/commit/rewind 均不存在）；大文件截断渲染。
import { useState } from "react";
import type { V4ConversationFileChangesResult } from "@zcode/shared/zcode-protocol-v4";
import type { MobileFileChangesSummary } from "./conversationState.js";

const MAX_FILES = 20;
const MAX_DIFF_LINES = 400;

interface Fetcher {
  (params: {
    sessionId: string;
    target: { rowId: number; entityId: string };
    baseRevision: number;
    baseLogEpoch: string;
  }): Promise<V4ConversationFileChangesResult>;
}

function DiffHunks(props: { patches: Array<{ lines: string[] }> }): React.ReactElement | null {
  const lines: string[] = [];
  for (const patch of props.patches) {
    for (const line of patch.lines) {
      if (lines.length >= MAX_DIFF_LINES) break;
      lines.push(line);
    }
    if (lines.length >= MAX_DIFF_LINES) break;
  }
  if (lines.length === 0) return null;
  return (
    <pre
      style={{
        margin: "6px 0 0",
        padding: "8px",
        background: "#111",
        borderRadius: 8,
        overflowX: "auto",
        fontSize: 11,
        lineHeight: 1.5,
        whiteSpace: "pre",
      }}
    >
      {lines.map((line, index) => (
        <div
          key={index}
          style={{
            color: line.startsWith("+") ? "#4ade80" : line.startsWith("-") ? "#f87171" : "#9a9a9e",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {line}
        </div>
      ))}
      {lines.length >= MAX_DIFF_LINES && <div style={{ color: "#777" }}>…差异过大已截断</div>}
    </pre>
  );
}

export function FileChangesCard(props: {
  rowId: number;
  entityId: string;
  sessionId: string;
  logEpoch: string;
  revision: number;
  summary: MobileFileChangesSummary;
  fetch: Fetcher;
}): React.ReactElement {
  const [details, setDetails] = useState<V4ConversationFileChangesResult | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  const toggle = async (): Promise<void> => {
    if (details !== null) {
      setDetails(null);
      return;
    }
    setState("loading");
    try {
      const result = await props.fetch({
        sessionId: props.sessionId,
        target: { rowId: props.rowId, entityId: props.entityId },
        baseRevision: props.revision,
        baseLogEpoch: props.logEpoch,
      });
      setDetails(result);
      setState("idle");
    } catch {
      setState("error");
    }
  };

  const summary =
    props.summary.state === "reverted" ? "（已回退）" : ` +${props.summary.additions} −${props.summary.deletions}`;

  return (
    <div className="card" onClick={() => void toggle()}>
      <span className={props.summary.state === "reverted" ? "muted-title" : undefined}>
        📄 文件变更 {props.summary.files} 个
      </span>
      <div className="sub">
        {summary}
        {state === "loading" ? " · 加载中…" : state === "error" ? " · 加载失败，点按重试" : details !== null ? " · 收起" : " · 点按查看差异"}
      </div>
      {details !== null && (
        <div style={{ marginTop: 8 }}>
          {details.items.slice(0, MAX_FILES).map((item) => (
            <div key={item.path} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, overflowWrap: "anywhere" }}>
                {item.path}{" "}
                <span style={{ color: "#4ade80" }}>+{item.additions}</span>{" "}
                <span style={{ color: "#f87171" }}>−{item.deletions}</span>
              </div>
              <DiffHunks patches={item.patches} />
            </div>
          ))}
          {details.items.length > MAX_FILES && (
            <div className="sub">其余 {details.items.length - MAX_FILES} 个文件未展示</div>
          )}
        </div>
      )}
    </div>
  );
}
