import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOracleDiffSections,
  buildOracleFixPrompt,
  buildOracleReviewPrompt,
  formatOracleCommitLine,
  formatOraclePatch,
  isOracleDeadlineTimeoutError,
  parseOracleVerdict,
  readStoredOracleModelSelection,
  resolveOraclePreviousReviewContext,
  writeStoredOracleModelSelection,
  type OracleReviewDiffHunk,
} from "../src/v4/oracleReview/oracleReviewSupport.js";
import {
  getOracleReviewState,
  invalidateOracleReviewSeq,
  isCurrentOracleReviewSeq,
  nextOracleReviewSeq,
  setOracleReviewState,
  subscribeOracleReviewState,
} from "../src/v4/oracleReview/oracleReviewStore.js";

function hunk(lines: string[], newStart = 1): OracleReviewDiffHunk {
  return { oldStart: newStart, oldLines: lines.length, newStart, newLines: lines.length, lines };
}

test("审查 prompt 含用户请求、项目目录、diff 与输出格式约束", () => {
  const prompt = buildOracleReviewPrompt({
    userRequest: "修复登录按钮",
    diffSections: [{ path: "src/a.ts", text: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@" }],
    projectName: "demo-app",
  });
  assert.ok(prompt.includes("修复登录按钮"));
  assert.ok(prompt.includes("项目目录：demo-app"));
  assert.ok(prompt.includes("### src/a.ts"));
  assert.ok(prompt.includes("VERDICT: PASS|WARN|FAIL"));
  assert.ok(prompt.includes("全量未裁剪"));
  assert.ok(!prompt.includes("已截断"));
});

test("审查 prompt 在空请求与空 diff 时给出明示", () => {
  const prompt = buildOracleReviewPrompt({
    userRequest: "  ",
    diffSections: [],
    projectName: "p",
  });
  assert.ok(prompt.includes("未找到原始请求文本"));
  assert.ok(prompt.includes("没有可审查的文本差异"));
});

test("审查 prompt 注入上次结论与最近提交供跨回合对照", () => {
  const prompt = buildOracleReviewPrompt({
    userRequest: "逐条修复",
    diffSections: [{ path: "src/fix.ts", text: "--- a/src/fix.ts\n+++ b/src/fix.ts" }],
    projectName: "demo",
    previousReview: {
      verdict: "fail",
      summary: "有两处问题",
      findings: "- [高] src/a.ts:12 — 空指针",
    },
    recentCommits: ["abc1234 fix(oracle): 空指针", "def5678 fix(oracle): 命名"],
  });
  assert.ok(prompt.includes("上一次审查的结论"));
  assert.ok(prompt.includes("裁决：fail"));
  assert.ok(prompt.includes("- [高] src/a.ts:12 — 空指针"));
  assert.ok(prompt.includes("abc1234 fix(oracle): 空指针"));
  // 上下文必须中性且标注为对照信息：不得捏造用户主张（如「用户称已修复」），
  // 也不得让审查者把它当成对本次 diff 的既定结论
  assert.ok(prompt.includes("仅供对照"));
  assert.ok(!prompt.includes("用户称"));
  // diff 段落在上下文段之后：方位词必须说「下方」
  assert.ok(prompt.includes("对照下方 diff"));
  assert.ok(prompt.indexOf("上一次审查的结论") < prompt.indexOf("## 本回合改动"));
});

test("审查 prompt 未提供上下文时不出现对照段落", () => {
  const prompt = buildOracleReviewPrompt({
    userRequest: "新功能",
    diffSections: [{ path: "src/a.ts", text: "--- a/src/a.ts" }],
    projectName: "demo",
  });
  assert.ok(!prompt.includes("上一次审查的结论"));
  assert.ok(!prompt.includes("本仓库最近提交"));
});

test("深度审查 prompt 追加只读取证指引，标准审查不含", () => {
  const deep = buildOracleReviewPrompt({
    userRequest: "修复登录按钮",
    diffSections: [{ path: "src/a.ts", text: "--- a/src/a.ts" }],
    projectName: "demo",
    depth: "deep",
  });
  assert.ok(deep.includes("深度审查指引"));
  assert.ok(deep.includes("只读工具"));
  assert.ok(deep.includes("git log"));
  assert.ok(deep.includes("VERDICT: PASS|WARN|FAIL")); // 输出格式与标准审查一致

  const standard = buildOracleReviewPrompt({
    userRequest: "修复登录按钮",
    diffSections: [{ path: "src/a.ts", text: "--- a/src/a.ts" }],
    projectName: "demo",
  });
  assert.ok(!standard.includes("深度审查指引"));
});

test("注入门槛：只向其后回合的审查注入上次结论", () => {
  const result = {
    status: "result",
    turnRowId: 5,
    verdict: "warn" as const,
    summary: "s",
    findings: "f",
  };
  // 目标回合在上次审查之后 → 注入
  assert.deepEqual(resolveOraclePreviousReviewContext(result, 9), {
    verdict: "warn",
    summary: "s",
    findings: "f",
  });
  // 同回合重审（防锚定）与回审更早回合（时序颠倒）→ 不注入
  assert.equal(resolveOraclePreviousReviewContext(result, 5), null);
  assert.equal(resolveOraclePreviousReviewContext(result, 3), null);
  // 上次审查非结果态（pending/error/idle）→ 不注入
  assert.equal(resolveOraclePreviousReviewContext({ status: "pending" }, 9), null);
  assert.equal(resolveOraclePreviousReviewContext({ status: "error" }, 9), null);
  assert.equal(resolveOraclePreviousReviewContext(null, 9), null);
  // 结果态但缺 turnRowId（不应出现，防御）→ 不注入
  assert.equal(resolveOraclePreviousReviewContext({ status: "result" }, 9), null);
});

test("注入内容截断：上次结论超长时按上限截断", () => {
  const context = resolveOraclePreviousReviewContext(
    {
      status: "result",
      turnRowId: 1,
      verdict: "warn" as const,
      summary: "长".repeat(300),
      findings: "问".repeat(3000),
    },
    2,
  );
  assert.ok(context);
  assert.equal(context.summary.length, 201); // 200 + 省略号
  assert.equal(context.findings.length, 2001);
  assert.ok(context.summary.endsWith("…"));
  assert.ok(context.findings.endsWith("…"));
});

test("提交行格式：hash 截 7 位，超长 subject 截断", () => {
  assert.equal(formatOracleCommitLine("abc1234567890", "修复空指针"), "abc1234 修复空指针");
  const longLine = formatOracleCommitLine("abc1234", "x".repeat(200));
  assert.equal(longLine.length, 121); // 120 + 省略号
  assert.ok(longLine.endsWith("…"));
});

test("审查卡片 store：按会话键控、跨切换存活、通知订阅者", () => {
  const seen: string[] = [];
  const unsubscribe = subscribeOracleReviewState("sess-a", (state) => seen.push(state.status));
  // 未写入前是 idle 缺省；null 会话恒 idle
  assert.deepEqual(getOracleReviewState("sess-a"), { status: "idle" });
  assert.deepEqual(getOracleReviewState(null), { status: "idle" });

  setOracleReviewState("sess-a", { status: "pending", mode: "manual", modelLabel: "m/x" });
  assert.deepEqual(getOracleReviewState("sess-a").status, "pending");
  assert.deepEqual(seen, ["pending"]);

  // 另一会话互不可见；null 会话不落存储
  assert.deepEqual(getOracleReviewState("sess-b"), { status: "idle" });

  // 退订后不再收到通知，但状态仍在（跨切换存活）
  unsubscribe();
  unsubscribe(); // 重复退订安全
  setOracleReviewState("sess-a", {
    status: "result",
    mode: "manual",
    turnRowId: 3,
    verdict: "pass",
    summary: "ok",
    findings: "无",
    modelLabel: "m/x",
  });
  assert.deepEqual(seen, ["pending"]);
  assert.equal(getOracleReviewState("sess-a").status, "result");

  // 回到 idle 删除条目（内存收敛），读取回到缺省 idle
  setOracleReviewState("sess-a", { status: "idle" });
  assert.deepEqual(getOracleReviewState("sess-a"), { status: "idle" });
});

test("审查卡片 store：请求代次守卫跨重挂载有效", () => {
  const first = nextOracleReviewSeq("sess-g");
  assert.equal(isCurrentOracleReviewSeq("sess-g", first), true);
  // 后发请求使先发请求的写回失效（模拟用户再次触发审查）
  const second = nextOracleReviewSeq("sess-g");
  assert.equal(isCurrentOracleReviewSeq("sess-g", first), false);
  assert.equal(isCurrentOracleReviewSeq("sess-g", second), true);
  // 代次按会话隔离
  assert.equal(isCurrentOracleReviewSeq("sess-h", second), false);
  // dismiss 作废：invalidate 只推代号次，在飞请求的写回失效，也不开启新请求
  invalidateOracleReviewSeq("sess-g");
  assert.equal(isCurrentOracleReviewSeq("sess-g", second), false);
});

test("parseOracleVerdict 解析标准输出", () => {
  const parsed = parseOracleVerdict(
    "VERDICT: FAIL\nSUMMARY: 有一个明显错误\nFINDINGS:\n- [高] src/a.ts:12 — 空指针\n- [低] src/b.ts:3 — 命名",
  );
  assert.equal(parsed.verdict, "fail");
  assert.equal(parsed.summary, "有一个明显错误");
  assert.ok(parsed.findings.includes("src/a.ts:12"));
  assert.ok(parsed.findings.includes("src/b.ts:3"));
  assert.ok(!parsed.findings.startsWith("FINDINGS"));
});

test("parseOracleVerdict 宽松兼容：全角冒号、小写、无 FINDINGS 段", () => {
  assert.equal(parseOracleVerdict("verdict：pass\nsummary：ok").verdict, "pass");
  assert.equal(
    parseOracleVerdict("VERDICT: WARN\nSUMMARY: 注意\n其余正文直接跟在后面").findings,
    "其余正文直接跟在后面",
  );
});

test("parseOracleVerdict 认中文标签、加粗与代码块包壳", () => {
  assert.equal(parseOracleVerdict("结论：通过\n总结：没问题").verdict, "pass");
  assert.equal(parseOracleVerdict("**VERDICT:** FAIL\n**SUMMARY:** 有错误").verdict, "fail");
  assert.equal(parseOracleVerdict("```verdict\nVERDICT: PASS\nSUMMARY: ok\n```").verdict, "pass");
  assert.equal(parseOracleVerdict("判定：不通过，缺少测试").verdict, "fail");
  assert.equal(parseOracleVerdict("结论：通过，但要注意边界情况").verdict, "warn");
  assert.equal(parseOracleVerdict("结论：警告，临时方案").verdict, "warn");
});

test("parseOracleVerdict 正文前有多行铺垫时仍能命中 VERDICT", () => {
  const parsed = parseOracleVerdict(
    "让我逐个文件分析这个 diff。\n\n第一个文件改动合理。\n第二个文件有问题。\n\nVERDICT: WARN\nSUMMARY: 基本可用\nFINDINGS:\n- [中] a.ts:2 — 边界",
  );
  assert.equal(parsed.verdict, "warn");
  assert.equal(parsed.summary, "基本可用");
  assert.ok(parsed.findings.includes("a.ts:2"));
});

test("parseOracleVerdict 无法解析时降级 unknown 并保留原文", () => {
  const parsed = parseOracleVerdict("这个改动看起来没问题。");
  assert.equal(parsed.verdict, "unknown");
  assert.equal(parsed.findings, "这个改动看起来没问题。");
});

function makeItems(count: number, linesPerFile: number) {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/f${index}.ts`,
    additions: linesPerFile,
    deletions: 0,
    patches: [hunk(Array.from({ length: linesPerFile }, (_, i) => `+line${i}`))],
  }));
}

test("diff 全量输入：空 patch 跳过、文件数不再受限", () => {
  const sections = buildOracleDiffSections([
    { path: "empty.ts", additions: 0, deletions: 0, patches: [] },
    ...makeItems(15, 10),
  ]);
  assert.equal(sections.length, 15);
  assert.ok(sections.every((section) => section.text.length > 0));
});

test("diff 全量输入：单文件超长不再截断", () => {
  const longLines = Array.from({ length: 200 }, (_, i) => `+${"x".repeat(60)}${i}`);
  const sections = buildOracleDiffSections([
    { path: "big.ts", additions: 200, deletions: 0, patches: [hunk(longLines)] },
    ...makeItems(30, 5),
  ]);
  assert.equal(sections.length, 31);
  assert.ok(!sections[0]!.text.includes("已截断"));
  assert.ok(sections[0]!.text.length > 12000);
});

test("formatOraclePatch 拼 unified diff 头", () => {
  const patch = formatOraclePatch("a.ts", [hunk(["+x"], 3)]);
  assert.ok(patch.startsWith("--- a/a.ts\n+++ b/a.ts\n@@ -3,1 +3,1 @@\n+x"));
  assert.equal(formatOraclePatch("a.ts", []), "");
});

test("一键修复 prompt 引用 findings 原文并要求逐条复述", () => {
  const prompt = buildOracleFixPrompt("- [高] a.ts:1 — 空");
  assert.ok(prompt.includes("- [高] a.ts:1 — 空"));
  assert.ok(prompt.includes("逐条修复"));
});

test("超时判定只认协议超时错误类型，不匹配消息字样", () => {
  const protocolTimeout = new Error("ZCode Protocol request timed out: workspace/generateText");
  protocolTimeout.name = "ZCodeProtocolRequestTimeoutError";
  assert.equal(isOracleDeadlineTimeoutError(protocolTimeout), true);
  // AbortError（消息不含 timeout 字样）→ 不误判
  const abort = new DOMException("This operation was aborted", "AbortError");
  assert.equal(isOracleDeadlineTimeoutError(abort), false);
  // ETIMEDOUT 系统错误（name 非 protocol 超时类）→ 不误判
  const etimedout = new Error("connect ETIMEDOUT 1.2.3.4:443");
  etimedout.name = "Error";
  assert.equal(isOracleDeadlineTimeoutError(etimedout), false);
  // 普通错误恰好包含 timeout 字样（如服务端 60s 超时文案）→ 不误判为客户端 deadline
  assert.equal(isOracleDeadlineTimeoutError(new Error("upstream timeout after 60s")), false);
  assert.equal(isOracleDeadlineTimeoutError("not an error"), false);
});

test("Oracle 模型偏好：存取对称、非法形状拒收、null 即清除", () => {
  const store = new Map<string, string>();
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  try {
    writeStoredOracleModelSelection({
      providerId: "command-code",
      modelId: "deepseek/deepseek-v4.1-flash",
    });
    assert.deepEqual(readStoredOracleModelSelection(), {
      providerId: "command-code",
      modelId: "deepseek/deepseek-v4.1-flash",
    });
    store.set("zcode-oracle-model", JSON.stringify({ providerId: 42, modelId: "x" }));
    assert.equal(readStoredOracleModelSelection(), null);
    store.set("zcode-oracle-model", "not json");
    assert.equal(readStoredOracleModelSelection(), null);
    writeStoredOracleModelSelection(null);
    assert.equal(store.has("zcode-oracle-model"), false);
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: original,
    });
  }
});
