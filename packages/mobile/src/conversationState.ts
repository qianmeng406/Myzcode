// 会话帧 → 渲染模型的纯状态逻辑（shared/zcode-protocol-v4 形状的解析层）。
// 独立模块原因：架构门禁单文件 400 行上限；组件文件只留视图与命令提交。
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";

export interface MobileRow {
  rowId: number;
  entityId: string;
  kind: string;
  text: string;
}

export interface MobileInteraction {
  interactionId: string;
  kind: string;
  prompt: string;
  options: Array<{ optionId: string; label: string }>;
  /** 允许自由文本回答（permission 反馈 / userInput 输入）。 */
  freeText: boolean;
  /** 敏感输入：按密码框渲染，只留内存、不入草稿/历史。 */
  sensitive: boolean;
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
      sensitive: payload.sensitive === true,
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
      sensitive: payload.sensitive === true,
    };
  }
  // workspaceHookReview 等其余类型：v1 只展示，不提供手机侧按钮（命令面未开放）。
  return { interactionId, kind, prompt: "待处理项（请在电脑端处理）", options: [], freeText: false, sensitive: false };
}

export interface ConversationState {
  sessionId: string | null;
  rows: MobileRow[];
  interactions: MobileInteraction[];
  mode: string | null;
  modelLabel: string | null;
}

export const INITIAL_STATE: ConversationState = {
  sessionId: null,
  rows: [],
  interactions: [],
  mode: null,
  modelLabel: null,
};

export function applyFrame(state: ConversationState, frame: ConversationTopicFrame): ConversationState {
  const { payload } = frame;
  if (payload.kind === "snapshot") {
    const snapshot = payload.snapshot;
    const config = snapshot.config as
      | { mode?: string; provider?: string; model?: string }
      | undefined;
    return {
      sessionId: snapshot.sessionId,
      rows: (snapshot.rows.window as unknown as Record<string, unknown>[]).map(describeRow),
      interactions: snapshot.pendingInteractions
        .map((interaction) => describeInteraction(interaction as unknown as Record<string, unknown>))
        .filter((interaction): interaction is MobileInteraction => interaction !== null),
      mode: typeof config?.mode === "string" ? config.mode : state.mode,
      modelLabel:
        typeof config?.provider === "string" && typeof config?.model === "string"
          ? `${config.provider}/${config.model}`
          : state.modelLabel,
    };
  }
  let { sessionId, rows, interactions, mode, modelLabel } = state;
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
    if (delta.op === "state.updated") {
      const patch = delta.patch as {
        pendingInteractions?: unknown[];
        config?: { mode?: string; provider?: string; model?: string };
      };
      if (patch.pendingInteractions !== undefined) {
        interactions = patch.pendingInteractions
          .map((interaction) => describeInteraction(interaction as unknown as Record<string, unknown>))
          .filter((interaction): interaction is MobileInteraction => interaction !== null);
      }
      if (patch.config?.mode !== undefined) mode = patch.config.mode;
      if (patch.config?.provider !== undefined && patch.config?.model !== undefined) {
        modelLabel = `${patch.config.provider}/${patch.config.model}`;
      }
      continue;
    }
    // workflowRun.*：v1 渲染不消费。
  }
  return { sessionId, rows, interactions, mode, modelLabel };
}

export const MODE_LABELS: Record<string, string> = {
  build: "构建",
  edit: "编辑",
  plan: "计划",
  yolo: "自动",
};

