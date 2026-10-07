// 会话帧 → 渲染模型的纯状态逻辑（shared/zcode-protocol-v4 形状的解析层）。
// 独立模块原因：架构门禁单文件 400 行上限；组件文件只留视图与命令提交。
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";

export interface MobileFileChangesSummary {
  files: number;
  additions: number;
  deletions: number;
  state?: string;
}

export interface MobileRow {
  rowId: number;
  entityId: string;
  kind: string;
  text: string;
  /** turnHeader 行的文件变更摘要（只读详情按需经 fileChanges 查询拉取）。 */
  fileChanges: MobileFileChangesSummary | null;
}

export interface MobileElicitationQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ value: string; label: string }>;
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
  /** AskUserQuestion/计划批准的多题结构；空数组 = 普通单题交互。 */
  questions: MobileElicitationQuestion[];
  /** 计划批准（schema.interaction = plan_approval）：提交走 accept/decline。 */
  isPlanApproval: boolean;
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
  const summary = (raw.fileChanges ?? null) as Record<string, unknown> | null;
  return {
    rowId: typeof raw.rowId === "number" ? raw.rowId : 0,
    entityId: typeof raw.entityId === "string" ? raw.entityId : "",
    kind: String(raw.kind ?? "row"),
    text: rowText(raw),
    fileChanges:
      summary !== null && typeof summary === "object"
        ? {
            files: typeof summary.files === "number" ? summary.files : 0,
            additions: typeof summary.additions === "number" ? summary.additions : 0,
            deletions: typeof summary.deletions === "number" ? summary.deletions : 0,
            ...(typeof summary.state === "string" ? { state: summary.state } : {}),
          }
        : null,
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
      questions: [],
      isPlanApproval: false,
    };
  }
  if (kind === "userInput") {
    const options = Array.isArray(payload.options) ? payload.options : [];
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const schema = (payload.schema ?? payload.input ?? null) as Record<string, unknown> | null;
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
      questions: questions
        .filter((question): question is Record<string, unknown> => question !== null && typeof question === "object")
        .map((question) => ({
          question: typeof question.question === "string" ? question.question : "",
          header: typeof question.header === "string" ? question.header : "",
          multiSelect: question.multiSelect === true,
          options: (Array.isArray(question.options) ? question.options : [])
            .filter((option): option is Record<string, unknown> => option !== null && typeof option === "object")
            .map((option) => ({
              value: String(option.value ?? ""),
              label: String(option.label ?? option.value ?? ""),
            }))
            .filter((option) => option.value !== ""),
        })),
      // 计划批准： elicitation 收敛路径以 schema 标记（与桌面 ElicitationDialog 同判据）。
      isPlanApproval:
        schema !== null &&
        typeof schema === "object" &&
        schema.interaction === "plan_approval" &&
        schema.toolName === "ExitPlanMode",
    };
  }
  // workspaceHookReview 等其余类型：v1 只展示，不提供手机侧按钮（命令面未开放）。
  return {
    interactionId,
    kind,
    prompt: "待处理项（请在电脑端处理）",
    options: [],
    freeText: false,
    sensitive: false,
    questions: [],
    isPlanApproval: false,
  };
}

export interface ConversationState {
  sessionId: string | null;
  rows: MobileRow[];
  interactions: MobileInteraction[];
  mode: string | null;
  modelLabel: string | null;
  /** 只读查询（fileChanges）的 CAS 游标：快照携带，增量帧推进 revision。 */
  logEpoch: string | null;
  revision: number | null;
}

export const INITIAL_STATE: ConversationState = {
  sessionId: null,
  rows: [],
  interactions: [],
  mode: null,
  modelLabel: null,
  logEpoch: null,
  revision: null,
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
      logEpoch: typeof snapshot.logEpoch === "string" ? snapshot.logEpoch : state.logEpoch,
      revision: typeof snapshot.revision === "number" ? snapshot.revision : state.revision,
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
  return { sessionId, rows, interactions, mode, modelLabel, logEpoch: state.logEpoch, revision: frame.toSeq };
}

/**
 * 多题答案 → resolveInteraction 的 content（与桌面 ElicitationDialog 同语义）：
 * answers 按"选项标签 join"承载；answer_i / 单题 answer 兼容新旧 agent 读取路径。
 * 只提交用户真实作答的题（AskUserQuestion 是可选澄清，不用空串伪造）。
 */
export function buildElicitationAnswer(
  questions: MobileElicitationQuestion[],
  selections: Readonly<Record<string, string[]>>,
): { action: "accept"; content: Record<string, unknown> } {
  const answersOf = (question: MobileElicitationQuestion): string[] =>
    (selections[question.question] ?? []).filter((value) => value !== "");
  const answered = questions
    .map((question) => ({ question, values: answersOf(question) }))
    .filter((entry) => entry.values.length > 0);
  const content: Record<string, unknown> = {
    answers: Object.fromEntries(answered.map((entry) => [entry.question.question, entry.values.join(", ")])),
  };
  answered.forEach((entry, index) => {
    content[`answer_${index}`] = entry.question.multiSelect ? entry.values : entry.values[0]!;
  });
  if (questions.length === 1 && answered.length === 1) {
    content.answer = questions[0]!.multiSelect ? answered[0]!.values : answered[0]!.values[0]!;
  }
  return { action: "accept", content };
}

export const MODE_LABELS: Record<string, string> = {
  build: "构建",
  edit: "编辑",
  plan: "计划",
  yolo: "自动",
};

