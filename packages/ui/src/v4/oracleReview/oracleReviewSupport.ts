import type { ModelSelection } from "@zcode/shared";

/**
 * Oracle 双模型把关的纯函数层：prompt 构建 / 裁决解析 / diff 预算 / 模型偏好存取。
 *
 * 与 usePromptOptimizer 同构：一次**会话外的** workspace generateText 请求，
 * 不产生消息、不进历史；这里是其中所有可脱离 React 单测的部分。
 */

export const ORACLE_TURN_REVIEW_QUERY_SOURCE = "oracle_turn_review";
// 无输出上限 + 深审大 diff 时思考可能很久；5 分钟是客户端 deadline，横幅不阻塞输入。
export const ORACLE_REVIEW_REQUEST_TIMEOUT_MS = 300_000;
// maxOutputTokens 由 useOracleReview 按模型声明的上限（optionSpecs.maxOutputTokens.max）
// 传入：省略会被 adapters 校验拒绝（outside the model option range），设小了会被
// 思考模型的 reasoning 吃光导致空正文（实测 2048 上限 GLM 返回空文本）。

const MAX_USER_REQUEST_CHARS = 4_000;

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

export function buildOracleReviewPrompt(params: {
  userRequest: string;
  diffSections: readonly OracleDiffSection[];
  projectName: string;
}): string {
  const userRequest = params.userRequest.trim().slice(0, MAX_USER_REQUEST_CHARS);
  const diffText =
    params.diffSections.length > 0
      ? params.diffSections.map((section) => `### ${section.path}\n${section.text}`).join("\n\n")
      : "（没有可审查的文本差异）";
  return [
    "你是资深代码审查者（Oracle）。一位编程智能体刚完成一个回合的代码修改，请你独立把关这次修改的质量。",
    "只审查，不执行任何操作；不要提出与本次 diff 无关的重构建议；发现无法从 diff 判断的地方要如实说不确定，不要臆断。",
    "",
    `项目目录：${params.projectName}`,
    "",
    "## 用户这回合的要求",
    userRequest || "（未找到原始请求文本）",
    "",
    "## 本回合改动（unified diff，全量未裁剪）",
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
