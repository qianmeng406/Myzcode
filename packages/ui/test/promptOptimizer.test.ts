import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPromptOptimizerRequestPrompt,
  cleanupOptimizedPromptText,
} from "../src/v4/composer/usePromptOptimizer.js";

test("优化 prompt 包含草稿、项目目录、上下文与输出约束", () => {
  const prompt = buildPromptOptimizerOptimizerPromptForTest();
  assert.ok(prompt.includes("草稿：\n修复登录按钮"));
  assert.ok(prompt.includes("项目目录：demo-app"));
  assert.ok(prompt.includes("1. 帮我看看构建为什么失败"));
  assert.ok(prompt.includes("不要用代码块包裹"));
});

function buildPromptOptimizerOptimizerPromptForTest(): string {
  return buildPromptOptimizerRequestPrompt({
    draft: "修复登录按钮",
    history: ["帮我看看构建为什么失败", "把测试跑起来"],
    projectName: "demo-app",
  });
}

test("历史条目超限截断：只取前几条并压每条长度", () => {
  const prompt = buildPromptOptimizerRequestPrompt({
    draft: "x",
    history: Array.from({ length: 10 }, (_, i) => `e${i}`.repeat(150)),
    projectName: "p",
  });
  assert.ok(!prompt.includes("7. "));
  assert.ok(prompt.includes("…"));
});

test("cleanup 剥掉代码块包壳与引导句", () => {
  assert.equal(cleanupOptimizedPromptText("```\n优化后的提示词\n```"), "优化后的提示词");
  assert.equal(cleanupOptimizedPromptText("优化后：修复登录按钮"), "修复登录按钮");
  assert.equal(cleanupOptimizedPromptText('"quoted prompt"'), "quoted prompt");
  assert.equal(cleanupOptimizedPromptText("  plain text  "), "plain text");
});

test("cleanup 保留正文里的正常内容", () => {
  const body = "第一步做 A；引用文件 \"src/a.ts\"";
  assert.equal(cleanupOptimizedPromptText(body), body);
});
