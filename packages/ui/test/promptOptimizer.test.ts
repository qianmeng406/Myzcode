import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  MAX_PROMPT_OPTIMIZER_DRAFT_CHARS,
  buildPromptOptimizerMessages,
  buildPromptOptimizerSystemPrompt,
  parsePromptOptimizerResult,
  validateOptimizedPrompt,
} from "../src/v4/composer/promptOptimizerPrompt.js";
import { buildPromptOptimizerContext } from "../src/v4/composer/promptOptimizerContext.js";
import {
  getPromptOptimizerState,
  invalidatePromptOptimizerScope,
  isCurrentPromptOptimizerRequest,
  isPromptOptimizerPending,
  nextPromptOptimizerRequestId,
  patchPromptOptimizerState,
  resetPromptOptimizerStoreForTest,
  setPromptOptimizerState,
} from "../src/v4/composer/promptOptimizerStore.js";

const EMPTY_CONTEXT = { text: "", truncated: false, missing: true };

function userRow(
  turnId: string,
  text: string,
  extra: { epilogueStart?: number; guided?: boolean; origin?: string } = {},
): ConversationRow {
  return {
    kind: "userInput",
    turnId,
    rowId: 1,
    createdAt: 0,
    createdAtSeq: 0,
    text,
    origin: extra.origin ?? "realUser",
    ...(extra.epilogueStart === undefined ? {} : { epilogueStart: extra.epilogueStart }),
    ...(extra.guided ? { guided: true } : {}),
  } as unknown as ConversationRow;
}

function assistantRow(turnId: string, text: string): ConversationRow {
  return {
    kind: "assistantText",
    turnId,
    rowId: 2,
    createdAt: 0,
    createdAtSeq: 0,
    text,
    state: "complete",
  } as unknown as ConversationRow;
}

// ── 规则与请求装配 ──

test("规则明确保护任务类型、否定条件与授权范围", () => {
  const rules = buildPromptOptimizerSystemPrompt("polish");
  assert.ok(rules.includes("任务类型"));
  assert.ok(rules.includes("不得新增需求、功能、技术栈、权限或工期"));
  assert.ok(rules.includes("材料"));
});

test("两种优化方式给出不同规则，且都要求严格 JSON 输出", () => {
  const polish = buildPromptOptimizerSystemPrompt("polish");
  const structure = buildPromptOptimizerSystemPrompt("structure");
  assert.notEqual(polish, structure);
  assert.ok(polish.includes("轻量润色"));
  assert.ok(structure.includes("执行化整理"));
  assert.ok(structure.includes("optimizedPrompt"));
});

test("请求把规则与材料分成 system / user 两条消息", () => {
  const messages = buildPromptOptimizerMessages({
    draft: "修复登录按钮",
    projectName: "demo-app",
    mode: "polish",
    contextRange: "conversation",
    context: { text: "[用户] 先看构建失败", truncated: true, missing: false },
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "system");
  assert.equal(messages[1]!.role, "user");
  const payload = JSON.parse(messages[1]!.content) as Record<string, unknown>;
  assert.equal(payload.draft, "修复登录按钮");
  assert.equal(payload.projectName, "demo-app");
  assert.equal(payload.contextTruncated, true);
  assert.ok(String(payload.conversationContext).includes("先看构建失败"));
});

test("仅当前输入模式下不携带会话上下文", () => {
  const messages = buildPromptOptimizerMessages({
    draft: "x",
    projectName: "p",
    mode: "polish",
    contextRange: "draft",
    context: { text: "[用户] 不该出现", truncated: false, missing: false },
  });
  const payload = JSON.parse(messages[1]!.content) as Record<string, unknown>;
  assert.equal(payload.conversationContext, "");
  assert.equal(payload.contextMissing, false);
});

// ── 结果解析（严格结构，不靠清洗） ──

test("解析标准 JSON 并保留正文里的引号与围栏", () => {
  const body = '第一步做 A；引用 "src/a.ts"\n```ts\nconst a = 1;\n```';
  const parsed = parsePromptOptimizerResult(JSON.stringify({ optimizedPrompt: body }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.optimizedPrompt : "", body.trim());
});

test("解析被单层代码围栏包裹的 JSON", () => {
  const parsed = parsePromptOptimizerResult(
    '```json\n{"optimizedPrompt":"修复登录按钮"}\n```',
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok ? parsed.optimizedPrompt : "", "修复登录按钮");
});

test("unresolved 过滤非字符串、去空并限量", () => {
  const parsed = parsePromptOptimizerResult(
    JSON.stringify({
      optimizedPrompt: "x",
      unresolved: ["  待确认目标平台  ", "", 42, null, "y".repeat(400)],
    }),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.unresolved[0], "待确认目标平台");
  assert.equal(parsed.unresolved.length, 2);
  assert.ok(parsed.unresolved[1]!.length < 400);
});

test("非 JSON / 缺字段 / unresolved 类型错误一律解析失败", () => {
  assert.equal(parsePromptOptimizerResult("优化后：修复登录").ok, false);
  assert.equal(parsePromptOptimizerResult("").ok, false);
  assert.equal(parsePromptOptimizerResult('{"unresolved":[]}').ok, false);
  assert.equal(parsePromptOptimizerResult('{"optimizedPrompt":"  "}').ok, false);
  assert.equal(
    parsePromptOptimizerResult('{"optimizedPrompt":"x","unresolved":"nope"}').ok,
    false,
  );
  assert.equal(parsePromptOptimizerResult("[1,2]").ok, false);
});

// ── 保真检查（只警告，不阻断） ──

test("无变化与空结果被识别", () => {
  assert.deepEqual(validateOptimizedPrompt("修复登录按钮", "  修复登录按钮  "), ["unchanged"]);
  assert.deepEqual(validateOptimizedPrompt("修复登录按钮", "   "), ["empty"]);
});

test("异常膨胀与字面量疑似丢失给出警告", () => {
  const draft = "把 `src/a.ts` 里的 main 修复，跑 node --test，版本 v1.2.3";
  const rewritten = "请修复登录流程中的问题，并确认相关测试可以正常通过。";
  const warnings = validateOptimizedPrompt(draft, rewritten);
  assert.ok(warnings.includes("literal-mismatch"));
  assert.ok(!warnings.includes("unchanged"));
  const expanded = validateOptimizedPrompt("修复按钮", "x".repeat(5000));
  assert.ok(expanded.includes("expanded"));
});

test("字面量完整保留时不误报", () => {
  const draft = "把 `src/a.ts` 里的 main 修复，跑 node --test";
  const optimized = "请修复 `src/a.ts` 中的 main 逻辑，并运行 node --test 验证。";
  assert.deepEqual(validateOptimizedPrompt(draft, optimized), []);
});

// ── 会话上下文抽取 ──

test("上下文只取最近轮次的用户原话与助手正文，排除工具与思考", () => {
  const rows: ConversationRow[] = [
    userRow("t1", "最早的请求"),
    assistantRow("t1", "t1 结论"),
    { kind: "reasoning", turnId: "t2", rowId: 3, createdAt: 0, createdAtSeq: 0, text: "思考", state: "complete" } as unknown as ConversationRow,
    userRow("t2", "第二请求"),
    assistantRow("t2", "t2 结论"),
    userRow("t3", "第三请求"),
    assistantRow("t3", "t3 结论"),
    userRow("t4", "第四请求"),
  ];
  const context = buildPromptOptimizerContext(rows);
  assert.equal(context.missing, false);
  assert.ok(!context.text.includes("最早的请求"));
  assert.ok(!context.text.includes("思考"));
  assert.ok(context.text.includes("第四请求"));
});

test("epilogue 引擎附加文本被切掉，guided 输入单独标注", () => {
  const rows: ConversationRow[] = [
    userRow("t1", "真正的需求/workflow 尾注", { epilogueStart: 5 }),
    userRow("t1", "顺带改个名字", { guided: true }),
  ];
  const context = buildPromptOptimizerContext(rows);
  assert.ok(context.text.includes("真正的需求"));
  assert.ok(!context.text.includes("workflow 尾注"));
  assert.ok(context.text.includes("中途指导"));
});

test("窗口为空时标 missing，不编造上下文", () => {
  const context = buildPromptOptimizerContext([]);
  assert.equal(context.missing, true);
  assert.equal(context.text, "");
});

// ── 作用域状态与序号防回写 ──

test("requestId 递增后旧请求不再 current", () => {
  resetPromptOptimizerStoreForTest();
  const first = nextPromptOptimizerRequestId("s");
  assert.equal(isCurrentPromptOptimizerRequest("s", first), true);
  invalidatePromptOptimizerScope("s");
  assert.equal(isCurrentPromptOptimizerRequest("s", first), false);
  const second = nextPromptOptimizerRequestId("s");
  assert.equal(isCurrentPromptOptimizerRequest("s", second), true);
});

test("patch 只接受当前 requestId，迟到结果被丢弃", () => {
  resetPromptOptimizerStoreForTest();
  const id = nextPromptOptimizerRequestId("s");
  setPromptOptimizerState("s", {
    status: "pending",
    requestId: id,
    operationId: "op",
    baseDraft: "d",
    baseVersion: "d",
    mode: "polish",
    contextRange: "draft",
    startedAt: 0,
  });
  assert.equal(isPromptOptimizerPending("s"), true);
  assert.equal(patchPromptOptimizerState("s", id + 1, { status: "ready" }), null);
  assert.equal(getPromptOptimizerState("s")?.status, "pending");
  assert.equal(patchPromptOptimizerState("s", id, { status: "ready" })?.status, "ready");
  assert.equal(isPromptOptimizerPending("s"), false);
});

test("不同 scope 状态互不影响", () => {
  resetPromptOptimizerStoreForTest();
  const idA = nextPromptOptimizerRequestId("a");
  nextPromptOptimizerRequestId("b");
  setPromptOptimizerState("a", {
    status: "ready",
    requestId: idA,
    operationId: null,
    baseDraft: "d",
    baseVersion: "d",
    mode: "polish",
    contextRange: "draft",
    startedAt: 0,
    optimized: "结果 A",
  });
  assert.equal(getPromptOptimizerState("a")?.optimized, "结果 A");
  assert.equal(getPromptOptimizerState("b"), null);
  setPromptOptimizerState("a", null);
  assert.equal(getPromptOptimizerState("a"), null);
});

test("草稿输入预算常量对外可见（超限由上层提示，不静默截断）", () => {
  assert.ok(MAX_PROMPT_OPTIMIZER_DRAFT_CHARS >= 8_000);
  assert.deepEqual(EMPTY_CONTEXT.text, "");
});
