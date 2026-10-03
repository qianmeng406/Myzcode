import type { ModelSelection } from "@zcode/shared";
import type { TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/provider";

/**
 * Oracle 双模型把关的纯函数层：prompt 构建 / 裁决解析 / diff 预算 / 模型偏好存取。
 *
 * 与 usePromptOptimizer 同构：一次**会话外的** workspace generateText 请求，
 * 不产生消息、不进历史；这里是其中所有可脱离 React 单测的部分。
 */

export const ORACLE_TURN_REVIEW_QUERY_SOURCE = "oracle_turn_review";
// 全量 diff + 最高推理档的思考可能很久；10 分钟客户端 deadline（宿主会据此派生
// 取消 signal，跳过 CLI 侧 60s 默认超时），横幅不阻塞输入。
export const ORACLE_REVIEW_REQUEST_TIMEOUT_MS = 600_000;
export const ORACLE_DEEP_REVIEW_QUERY_SOURCE = "oracle_deep_review";
// 深度审查是多轮只读子代理（读文件/搜索/只读 bash 取证），耗时数倍于标准审查。
export const ORACLE_DEEP_REVIEW_TIMEOUT_MS = 1_200_000;

export type OracleReviewDepth = "standard" | "deep";

/** 深度审查的进度通知也走同一 workspace/generateTextProgress 通道，按来源认领。 */
export function isOracleReviewQuerySource(querySource: string): boolean {
  return (
    querySource === ORACLE_TURN_REVIEW_QUERY_SOURCE ||
    querySource === ORACLE_DEEP_REVIEW_QUERY_SOURCE
  );
}
// maxOutputTokens 由 useOracleReview 按模型声明的上限（optionSpecs.maxOutputTokens.max）
// 传入：省略会被 adapters 校验拒绝（outside the model option range），设小了会被
// 思考模型的 reasoning 吃光导致空正文（实测 2048 上限 GLM 返回空文本）。

const MAX_USER_REQUEST_CHARS = 4_000;
// 注入上下文的长度上限：上次结论/提交行不设限会无上限撑大审查 prompt。
const MAX_PREVIOUS_SUMMARY_CHARS = 200;
const MAX_PREVIOUS_FINDINGS_CHARS = 2_000;
const MAX_COMMIT_LINE_CHARS = 120;

function truncateWithEllipsis(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface OracleReviewDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: readonly string[];
}

export interface OracleReviewDiffItem {
  path: string;
  additions: number;
  deletions: number;
  patches: readonly OracleReviewDiffHunk[];
}

export interface OracleDiffSection {
  path: string;
  text: string;
}

/** 把 v4 fileChanges 的 hunk 拼成 unified diff 文本（形状同 ConversationFileSummaryPanel 的局部 formatPatch）。 */
export function formatOraclePatch(path: string, patches: readonly OracleReviewDiffHunk[]): string {
  if (patches.length === 0) return "";
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const patch of patches) {
    lines.push(
      `@@ -${patch.oldStart},${patch.oldLines} +${patch.newStart},${patch.newLines} @@`,
      ...patch.lines,
    );
  }
  return lines.join("\n");
}

/**
 * 上轮全部 diff 原样进 prompt，不做任何裁剪——截断会让审查结论只覆盖部分改动，
 * 用户明确要求全量审查。空 patch（二进制/无文本差异）跳过。超大 diff 若顶到模型
 * 上下文上限，会让上游报错并如实显示在横幅里，不静默截断。
 */
export function buildOracleDiffSections(
  items: readonly OracleReviewDiffItem[],
): OracleDiffSection[] {
  const sections: OracleDiffSection[] = [];
  for (const item of items) {
    if (item.patches.length === 0) continue;
    sections.push({ path: item.path, text: formatOraclePatch(item.path, item.patches) });
  }
  return sections;
}

/** 上次审查的结论卡片内容；跨回合修复核对用。 */
export interface OraclePreviousReviewContext {
  verdict: OracleVerdict;
  summary: string;
  findings: string;
}

/** 注入判定所需的最小状态形状（OracleReviewState 的结构子集）。 */
export interface OracleReviewResultLike {
  status: string;
  turnRowId?: number;
  verdict?: OracleVerdict;
  summary?: string;
  findings?: string;
}

/**
 * 跨回合对照上下文的注入门槛：只在上次审查确有结果、且本次审查的是**其后**的回合
 * 时注入。同回合重审注入自己的旧结论会锚定审查者；回审更早的回合注入"未来"的结论
 * 语义颠倒。与目标回合隔了多少个未审查回合不做判断——文案是中性对照（见
 * buildOracleReviewPrompt），语境错配只损失相关性，不构成捏造主张。
 */
export function resolveOraclePreviousReviewContext(
  previous: OracleReviewResultLike | null | undefined,
  targetTurnRowId: number,
): OraclePreviousReviewContext | null {
  if (!previous || previous.status !== "result" || previous.turnRowId === undefined) {
    return null;
  }
  if (targetTurnRowId <= previous.turnRowId) {
    return null;
  }
  return {
    verdict: previous.verdict ?? "unknown",
    summary: truncateWithEllipsis(previous.summary ?? "", MAX_PREVIOUS_SUMMARY_CHARS),
    findings: truncateWithEllipsis(previous.findings ?? "", MAX_PREVIOUS_FINDINGS_CHARS),
  };
}

/** 提交行：hash 前 7 位 + subject（截断到单行上限，防超长 subject 撑大 prompt）。 */
export function formatOracleCommitLine(hash: string, subject: string): string {
  return truncateWithEllipsis(`${hash.slice(0, 7)} ${subject}`, MAX_COMMIT_LINE_CHARS);
}

/**
 * 上下文注入（仅供对照核验，不是本次 diff 的既定结论）：
 * - previousReview：上次审查的裁决/摘要/问题清单——修复跨回合时，审查者凭它可以核对
 *   「声称已修/不成立」是否与 diff 对得上，而不是按「diff 里没有=没修」臆断；
 * - recentCommits：本仓库最近提交摘要——修复往往落在上一回合的提交里，不在此回合 diff 中。
 */
export function buildOracleReviewPrompt(params: {
  userRequest: string;
  diffSections: readonly OracleDiffSection[];
  projectName: string;
  previousReview?: OraclePreviousReviewContext | null;
  recentCommits?: readonly string[] | null;
  /** deep：追加只读取证指引（审查方配备 Read/Grep/Glob 与只读 Bash）。 */
  depth?: OracleReviewDepth;
  /** 请求文本取不到（窗口裁剪 + 历史翻页失败）：如实告知并禁止臆断任务。 */
  userRequestUnavailable?: boolean;
  /**
   * diff 来源：turn=该回合的工具级改动记录（Edit/Write 产物）；
   * workspace=回合内无工具级记录（改动由脚本/命令完成）时回退的工作区未提交改动。
   */
  diffSource?: "turn" | "workspace";
}): string {
  const userRequest = params.userRequest.trim().slice(0, MAX_USER_REQUEST_CHARS);
  const diffText =
    params.diffSections.length > 0
      ? params.diffSections.map((section) => `### ${section.path}\n${section.text}`).join("\n\n")
      : "（没有可审查的文本差异）";
  // 取证白名单：diff 涉及的文件路径清单。慢渠道实测里审查者顺着对照上下文的
  // 历史发现跑到了与本 diff 无关的工作区目录（对抗复核报告等），必须有明确的
  // 可执行边界而不是一句"要克制"。
  const diffFileManifest =
    params.diffSections.length > 0
      ? [
          "## 本回合改动文件清单（取证白名单）",
          ...params.diffSections.map((section) => `- ${section.path}`),
          "你的取证（Read/Grep/Glob/Bash）只允许落在上述文件及其直接调用方/被调用方上。清单之外的任何文件——包括工作区中的报告、文档、脚本、历史回合产物——一律不得读取或搜索，即使下方对照上下文提到了它们。",
          "",
        ]
      : [];
  // 范围硬约束与白名单绑定引用：无清单时（无可审查文本差异）引用会悬空且把"不读
  // 任何文件"误收紧成"允许读白名单"，这里按有无清单分别给出可执行措辞。
  const forensicScopeLine =
    params.diffSections.length > 0
      ? "取证范围严格限定：只允许读取上方「本回合改动文件清单（取证白名单）」中的文件，以及它们的直接调用方/被调用方。禁止漫游仓库、禁止系统性浏览目录结构、禁止与已确认问题无关的扩展调查。"
      : "本回合没有可读取的文件清单（无可审查文本差异）：不要读取或搜索任何工作区文件，直接基于 diff 内容与工具查询结果（如 git log）给出结论，并如实标注证据受限。";
  const contextSections: string[] = [];
  if (params.recentCommits && params.recentCommits.length > 0) {
    contextSections.push(
      "## 本仓库最近提交（历史已落盘改动；若疑似问题在本 diff 中未见相关改动，先对照这些提交确认是否已在早前处理，仍无法确认的如实标注不确定）",
      params.recentCommits.join("\n"),
      "",
    );
  }
  if (params.previousReview) {
    contextSections.push(
      "## 上一次审查的结论（针对更早的改动，仅供对照，不是对本次 diff 的既定结论；若本回合改动声称处理了其中的问题，请对照下方 diff 与最近提交核验是否属实）",
      "注意：历史发现提到的其他文件不在本回合取证范围内（除非本回合 diff 也触及它们）——不要为验证历史发现去调查与本 diff 无关的文件。",
      `裁决：${params.previousReview.verdict}`,
      `总评：${params.previousReview.summary || "（无）"}`,
      `问题清单：`,
      params.previousReview.findings || "（无）",
      "",
    );
  }
  const depthSections =
    params.depth === "deep"
      ? [
          "## 深度审查指引",
          "你不只有这份 diff：你可以调用只读工具对仓库取证（Read 读文件、Grep 全文搜索、Glob 按模式找文件、Bash 仅限只读命令如 git log/git diff/ls；写命令会被拒绝）。",
          "在给结论前请：①打开 diff 涉及的文件核对改动所在的真实上下文，确认行号与引用关系；②检查改动是否破坏了调用方/被调用方；③用搜索确认声称修复的问题确实已修。下结论必须基于你亲自读到的证据，diff 里看不出来的地方就去读代码，仍无法确认的如实标注不确定。",
          "取证要克制：围绕本次 diff 展开，不要漫无目的地浏览仓库。",
          // 取证范围与预算硬约束：实测无界取证会在慢渠道上把时间烧光且零结论。
          forensicScopeLine,
          "时间预算有限：整个审查预计在少量轮次内完成。一旦掌握足以给出结论的证据就立即停止取证直接输出结论，宁可少取证也不要为边际收益继续消耗轮次。",
          // 只约束"收尾形态"而非"是否用工具"：模型以工具调用收尾会让本轮没有可解析正文。
          "无论是否使用工具，最终必须以文本直接给出 VERDICT 开头的结论，不要以工具调用作为最后一轮的结束。",
          "",
        ]
      : [];
  return [
    "你是资深代码审查者（Oracle）。一位编程智能体刚完成一个回合的代码修改，请你独立把关这次修改的质量。",
    // 角色定位句同样按深度分叉：标准审查的「不执行任何操作」在深度模式下会被
    // 严格模型解读成「不要发起任何调用」，与下方只读工具开放相抵触——措辞必须
    // 一致地指向「不写」而非「不调用」。
    ...(params.depth === "deep"
      ? [
          "只审查：不要修改任何代码、不要执行任何写操作（写类命令会被拒绝）；不要提出与本次 diff 无关的重构建议；发现无法从 diff 判断的地方要如实说不确定，不要臆断。",
        ]
      : [
          "只审查，不执行任何操作；不要提出与本次 diff 无关的重构建议；发现无法从 diff 判断的地方要如实说不确定，不要臆断。",
        ]),
    // "无工具"禁令只对标准审查下发：深度审查开放只读工具（见深度指引），若两句话
    // 同时出现会自相矛盾——实测 deepseek 因此放弃取证直接作答，工具循环完全没跑。
    ...(params.depth === "deep"
      ? []
      : [
          "你没有可用工具，也不要输出任何工具调用：直接以文本给出结论（模型以工具调用收尾会导致本轮审查没有可解析的结果）。",
        ]),
    "",
    `项目目录：${params.projectName}`,
    "",
    "## 用户这回合的要求",
    userRequest ||
      (params.userRequestUnavailable
        ? "（无法从会话历史恢复本回合的原始请求文本。请仅依据下方 diff、最近提交与对照上下文推断改动意图，并在无法确认意图时如实标注不确定——不要臆断本回合的任务。）"
        : "（未找到原始请求文本）"),
    "",
    ...contextSections,
    ...depthSections,
    ...diffFileManifest,
    ...(params.diffSource === "workspace"
      ? [
          "## 工作区改动（相对 HEAD 的未提交改动，unified diff）",
          "注意：本回合没有工具级改动记录——改动可能是经脚本/命令完成的。以下是工作区当前相对 HEAD 的实际改动，可能包含同期其他未提交改动：请结合最近提交判断归属，无法确认归属时如实说明，不要臆断。",
          "",
        ]
      : ["## 本回合改动（unified diff，全量未裁剪）"]),
    diffText,
    "",
    "## 输出格式（严格遵守）",
    "第一行：VERDICT: PASS|WARN|FAIL",
    "- PASS：改动正确且完整，没有需要处理的问题",
    "- WARN：改动可用，但存在值得注意的问题或风险",
    "- FAIL：改动有明显缺陷（错误、遗漏、破坏性行为），必须修复",
    "第二行：SUMMARY: 一句话总评",
    "之后：FINDINGS:",
    "- [高|中|低] 文件:行 — 问题描述与修复建议（每条一行；没有问题时写「无」）",
  ].join("\n");
}

export type OracleVerdict = "pass" | "warn" | "fail" | "unknown";

/**
 * 客户端 deadline 超时判定：协议 client 的 ZCodeProtocolRequestTimeoutError 有专属
 * name，且 RPC 层显式序列化/还原 name（channelServer/channelClient），因此按类型标记
 * 判定而不是匹配 message——AbortError、ETIMEDOUT、服务端自带 "timeout" 字样的错误
 * 都不会被误判进超时分支，原样走通用失败文案展示真实消息。
 */
export function isOracleDeadlineTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "ZCodeProtocolRequestTimeoutError";
}

export interface OracleVerdictParse {
  verdict: OracleVerdict;
  summary: string;
  /** findings 全文（多行）；unknown 时是模型原文，卡片直接展示不硬造结论。 */
  findings: string;
}

const ORACLE_VERDICT_LINE_PATTERN =
  /^\s*(?:\*\*)?(?:VERDICT|结论|判定)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.+?)(?:\*\*)?\s*$/i;
const ORACLE_SUMMARY_LINE_PATTERN =
  /^\s*(?:\*\*)?(?:SUMMARY|总结|总评)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.*?)(?:\*\*)?\s*$/i;
const ORACLE_FINDINGS_LINE_PATTERN = /^\s*(?:\*\*)?(?:FINDINGS|问题清单)(?:\*\*)?\s*[:：]?\s*$/i;

/** 宽松归一：认英文 PASS/WARN/FAIL 与中文同义表达；认不出返回 unknown。 */
function normalizeOracleVerdictWord(word: string): OracleVerdict {
  const w = word.trim().toLowerCase();
  if (!w) return "unknown";
  // 顺序即语义：不通过→fail（含「通过」字样），通过但…→warn，纯通过/PASS→pass。
  if (/^fail\b|失败|需要修复|不通过|不满足/.test(w)) return "fail";
  if (/^warn\b|注意|警告/.test(w)) return "warn";
  if (/^pass\b|通过/.test(w)) return "pass";
  return "unknown";
}

/** 模型偶尔不守格式：剥代码块/加粗包壳、认中文标签、扫前 10 行；解析不出降级 unknown 并保留原文。 */
export function parseOracleVerdict(raw: string): OracleVerdictParse {
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence?.[1]) {
    text = fence[1].trim();
  }
  const lines = text.split("\n");
  let verdict: OracleVerdict = "unknown";
  let summary = "";
  for (const line of lines.slice(0, 10)) {
    const verdictMatch = line.match(ORACLE_VERDICT_LINE_PATTERN);
    if (verdictMatch) {
      verdict = normalizeOracleVerdictWord(verdictMatch[1]!);
      if (verdict !== "unknown") {
        break;
      }
    }
  }
  for (const line of lines.slice(0, 10)) {
    const summaryMatch = line.match(ORACLE_SUMMARY_LINE_PATTERN);
    if (summaryMatch) {
      summary = summaryMatch[1]!.trim();
      break;
    }
  }
  if (verdict === "unknown") {
    return { verdict, summary, findings: text };
  }
  const findingsIndex = lines.findIndex((line) => ORACLE_FINDINGS_LINE_PATTERN.test(line));
  if (findingsIndex >= 0) {
    return {
      verdict,
      summary,
      findings: lines
        .slice(findingsIndex + 1)
        .join("\n")
        .trim(),
    };
  }
  const verdictLineIndex = lines.findIndex(
    (line) => /^\s*(?:\*\*)?VERDICT/i.test(line) || /^\s*(?:\*\*)?结论/i.test(line),
  );
  const rest = lines
    .slice(verdictLineIndex + 1)
    .filter((line) => !ORACLE_SUMMARY_LINE_PATTERN.test(line))
    .join("\n")
    .trim();
  return { verdict, summary, findings: rest };
}

export type OracleReviewRequestMode = "auto" | "manual";

export type OracleReviewFailure =
  | { kind: "no-turn" }
  | { kind: "no-changes" }
  | { kind: "no-model" }
  /** 模型返回空正文：多为输出预算被 reasoning 耗尽（finishReason 可佐证）。 */
  | { kind: "empty-response"; finishReason?: string }
  /** 客户端 deadline 到点：多为渠道限流或深思考无首 token 的重试循环；message 供卡片展示底层错误。 */
  | { kind: "timeout"; message: string }
  | { kind: "request"; message: string };

/** 深度审查已执行的工具调用（横幅展示：读了哪些文件、跑了什么命令）。 */
export interface OracleReviewToolEvent {
  round: number;
  toolName: string;
  /** 展示目标：文件路径 / pattern / 命令；模型未给可提取字段时缺席。 */
  target?: string;
}

// 事件列表上限：横幅只做线索展示，长审查按最近 N 条滚动。
export const ORACLE_REVIEW_TOOL_EVENT_LIMIT = 40;

/** 追加一条工具事件并有界裁剪（保留最近 N 条）。 */
export function appendOracleReviewToolEvent(
  events: readonly OracleReviewToolEvent[],
  next: OracleReviewToolEvent,
): OracleReviewToolEvent[] {
  const appended = [...events, next];
  return appended.length > ORACLE_REVIEW_TOOL_EVENT_LIMIT
    ? appended.slice(appended.length - ORACLE_REVIEW_TOOL_EVENT_LIMIT)
    : appended;
}

export type OracleReviewState =
  | { status: "idle" }
  | {
      status: "pending";
      mode: OracleReviewRequestMode;
      /** 本次审查实际使用的把关模型（providerId/modelId），卡片 pending 时展示。 */
      modelLabel: string;
      /** 标准（单轮全量 diff）或深度（只读子代理多轮取证）。 */
      depth: OracleReviewDepth;
      /** 深度审查的当前轮次（进度通知推送；标准审查缺席）。 */
      round?: number;
      /** 深度审查正在执行的工具名（工具执行阶段；生成阶段清空）。 */
      toolName?: string;
      /** 当前工具调用的展示目标（文件路径 / pattern / 命令）。 */
      toolTarget?: string;
      /** 深度审查已执行的工具调用（有界），供横幅列出已读文件/命令。 */
      toolEvents?: readonly OracleReviewToolEvent[];
    }
  | {
      status: "result";
      mode: OracleReviewRequestMode;
      turnRowId: number;
      verdict: OracleVerdict;
      summary: string;
      findings: string;
      modelLabel: string;
      depth: OracleReviewDepth;
    }
  | {
      status: "error";
      mode: OracleReviewRequestMode;
      failure: OracleReviewFailure;
      /** 发起请求后的把关模型（providerId/modelId）；错误卡片展示，渠道选错一眼可辨。请求前早退（无回合等）缺席。 */
      modelLabel?: string;
      depth: OracleReviewDepth;
    };

/** 一键修复：把 findings 原文注入下一轮请求，由用户亲手触发，不自动循环。 */
export function buildOracleFixPrompt(findings: string): string {
  return [
    "上一回合的代码经过了 Oracle 审查，发现以下问题，请逐条修复：",
    "",
    findings,
    "",
    "完成后逐条说明每个问题的处理方式；如某条经核实不成立，请说明理由而不是静默忽略。",
  ].join("\n");
}

const ORACLE_MODEL_STORAGE_KEY = "zcode-oracle-model";

/** 用户指定的 Oracle 审查模型（全局偏好）；null = 跟随会话模型。 */
export function readStoredOracleModelSelection(): ModelSelection | null {
  try {
    const raw = localStorage.getItem(ORACLE_MODEL_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as ModelSelection).providerId === "string" &&
      typeof (parsed as ModelSelection).modelId === "string" &&
      (parsed as ModelSelection).providerId.trim() &&
      (parsed as ModelSelection).modelId.trim()
    ) {
      return {
        providerId: (parsed as ModelSelection).providerId,
        modelId: (parsed as ModelSelection).modelId,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeStoredOracleModelSelection(selection: ModelSelection | null): void {
  try {
    if (!selection) {
      localStorage.removeItem(ORACLE_MODEL_STORAGE_KEY);
    } else {
      localStorage.setItem(ORACLE_MODEL_STORAGE_KEY, JSON.stringify(selection));
    }
  } catch {
    // localStorage 不可用（隐私模式等）时静默放弃持久化，选择仍在本会话内生效。
  }
}

/**
 * 解析把关请求的执行选项：模型选择（缺推理档时补该模型最高公开档）+ 输出预算。
 *
 * maxOutputTokens 跟随模型声明的上限（optionSpecs.maxOutputTokens.max，与主回合
 * 「打满模型声明上限」同语义）：省略会被 adapters 的 validateOptions 以
 * 「outside the model option range」拒绝；设小了会被思考模型的 reasoning 吃光
 * 导致空正文（实测 2048 上限 GLM 返回空文本）。模型视图缺席该值时才省略并让
 * 错误如实上报。
 */
export function resolveOracleRequestOptions(
  oracleModel: ModelSelection | null,
  modelSelectionView: ModelSelectionView | null | undefined,
): { selection: ModelSelection; maxOutputTokens?: number } | null {
  const selection = oracleModel ?? modelSelectionView?.preferredSelection ?? null;
  if (!selection) {
    return null;
  }
  // 档位跟随用户选择/模型默认，**不再自动升到最高档**：实测把关模型在最高档上
  // 单轮思考可达 10 分钟（慢渠道），多轮深度审查在 20 分钟 deadline 内结构性无法
  // 收敛。要更高强度的把关，请在把关模型下拉里显式选档。
  const provider = modelSelectionView?.providers.find(
    (candidate) => candidate.providerId === selection.providerId,
  );
  const model = provider?.models.find((candidate) => candidate.modelId === selection.modelId);
  const specMax = model?.config.optionSpecs.maxOutputTokens?.max;
  return {
    selection,
    ...(typeof specMax === "number" && Number.isFinite(specMax) && specMax > 0
      ? { maxOutputTokens: specMax }
      : {}),
  };
}

/** SessionPane → composer / 行渲染注入的完整控制面；composer 不再自持 hook 实例。 */
export interface OracleReviewController {
  state: OracleReviewState;
  enabled: boolean;
  /** pending 已等待秒数（每秒跳动）；结果/错误态归零。 */
  pendingElapsedSeconds: number;
  /** pending 期间模型已累计输出的字符数（正文+思考，CLI 流式进度推送）；非 pending 归零。 */
  pendingOutputChars: number;
  manualReview: () => void;
  /** 深度审查（只读子代理多轮取证）：仅手动入口，成本数倍于标准审查。 */
  deepReview: () => void;
  reviewTurnHeader: (header: TurnHeaderRow) => void;
  /** 轮尾工具栏的深度审查入口：与 reviewTurnHeader 同一准入条件。 */
  reviewTurnHeaderDeep: (header: TurnHeaderRow) => void;
  dismiss: () => void;
  /** 把关模型偏好（localStorage 全局）；下拉的受控值。 */
  model: ModelSelection | null;
  onSelectModel: (selection: ModelSelection | null) => void;
}
