import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOracleDiffSections,
  buildOracleFixPrompt,
  buildOracleReviewPrompt,
  formatOraclePatch,
  parseOracleVerdict,
  readStoredOracleModelSelection,
  writeStoredOracleModelSelection,
  type OracleReviewDiffHunk,
} from "../src/v4/oracleReview/oracleReviewSupport.js";

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
