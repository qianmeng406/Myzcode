import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { PromptOptimizerContext } from "@/v4/composer/promptOptimizerPrompt.js";

/**
 * 当前会话的**有限**上下文抽取（只读已有窗口，不做 rows/range 回溯）。
 *
 * 取舍理由：指导优化方消解指代需要的是「最近几轮用户原话 + 助手结论」，
 * 不是全量转录。带上工具日志/思考会稀释信号、拉高延迟，还会把未确认的建议
 * 混成事实。窗口不足时宁可标 missing，也不猜一个历史方案。
 */

const MAX_CONTEXT_TURNS = 3;
const MAX_CONTEXT_CHARS = 4_000;
const MAX_ENTRY_CHARS = 1_500;

const USER_ORIGIN_LABELS: Record<string, string> = {
  realUser: "用户",
  backgroundResult: "后台结果",
  goalContinuation: "目标续跑",
  mailbox: "信箱",
  synthetic: "系统",
  workflowLaunch: "工作流启动",
};

interface ContextEntry {
  turnId: string;
  label: string;
  text: string;
}

function userInputEntry(row: Extract<ConversationRow, { kind: "userInput" }>): ContextEntry | null {
  // text 从 epilogueStart 起是引擎附加文本（尾注/nudge），不是用户原话，必须切掉。
  const visible = row.epilogueStart === undefined ? row.text : row.text.slice(0, row.epilogueStart);
  const text = visible.trim();
  if (!text) {
    return null;
  }
  const base = USER_ORIGIN_LABELS[row.origin] ?? row.origin;
  return {
    turnId: row.turnId,
    label: row.guided ? `${base}·中途指导` : base,
    text,
  };
}

function assistantEntry(row: Extract<ConversationRow, { kind: "assistantText" }>): ContextEntry | null {
  const text = row.text.trim();
  if (!text) {
    return null;
  }
  return { turnId: row.turnId, label: "助手", text };
}

/** 只保留用户原话与助手正文；工具/思考/行级元数据一律不进上下文。 */
function toContextEntry(row: ConversationRow): ContextEntry | null {
  switch (row.kind) {
    case "userInput":
      return userInputEntry(row);
    case "assistantText":
      return assistantEntry(row);
    default:
      return null;
  }
}

function truncateEntry(text: string): string {
  return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}…` : text;
}

export function buildPromptOptimizerContext(
  rows: readonly ConversationRow[],
): PromptOptimizerContext {
  const entries = rows.map(toContextEntry).filter((entry): entry is ContextEntry => entry !== null);
  if (entries.length === 0) {
    return { text: "", truncated: false, missing: true };
  }

  // 按 turnId 从尾部取最近 N 轮（窗口本身就是最近的，不排序重排保证时间序）。
  const turnOrder: string[] = [];
  for (let index = entries.length - 1; index >= 0 && turnOrder.length < MAX_CONTEXT_TURNS; index -= 1) {
    const turnId = entries[index]!.turnId;
    if (!turnOrder.includes(turnId)) {
      turnOrder.unshift(turnId);
    }
  }
  const kept = entries.filter((entry) => turnOrder.includes(entry.turnId));

  const lines: string[] = [];
  let used = 0;
  let truncated = false;
  for (const entry of kept) {
    const line = `[${entry.label}] ${truncateEntry(entry.text)}`;
    if (used + line.length > MAX_CONTEXT_CHARS) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length;
  }
  if (kept.length > lines.length) {
    truncated = true;
  }
  return { text: lines.join("\n"), truncated, missing: false };
}
