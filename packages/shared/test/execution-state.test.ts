import assert from "node:assert/strict";
import test from "node:test";
import { executionPermissionModeSchema, resolveExecutionState } from "../src/execution-state.js";
import {
  deriveStdWorkflowStageStrip,
  parseStdWorkflowStageMarker,
  STD_WORKFLOW_ADVERSARIAL_WORKFLOWS,
  STD_WORKFLOW_LEDGER_RELATIVE_PATH,
} from "../src/std-workflow-stages.js";

test("executionPermissionModeSchema accepts workflow", () => {
  assert.equal(executionPermissionModeSchema.safeParse("workflow").success, true);
});

test("resolveExecutionState keeps workflow and resets planEnabled", () => {
  const state = resolveExecutionState(
    { mode: "workflow" },
    { mode: "research", planEnabled: true },
  );
  assert.deepEqual(state, { mode: "workflow", planEnabled: false });
});

test("resolveExecutionState falls back to current mode on unknown input", () => {
  const state = resolveExecutionState(
    { mode: "pair-programming" },
    { mode: "workflow", planEnabled: false },
  );
  assert.equal(state.mode, "workflow");
});

test("resolveExecutionState still maps legacy plan to planEnabled", () => {
  const state = resolveExecutionState({ mode: "plan" }, { mode: "workflow", planEnabled: false });
  assert.equal(state.mode, "workflow");
  assert.equal(state.planEnabled, true);
});

test("executionPermissionModeSchema accepts minimal and zcodeUpdate", () => {
  assert.equal(executionPermissionModeSchema.safeParse("minimal").success, true);
  assert.equal(executionPermissionModeSchema.safeParse("zcodeUpdate").success, true);
});

test("resolveExecutionState keeps the two new custom modes", () => {
  const minimal = resolveExecutionState({ mode: "minimal" }, { mode: "build", planEnabled: false });
  assert.deepEqual(minimal, { mode: "minimal", planEnabled: false });

  const update = resolveExecutionState(
    { mode: "zcodeUpdate" },
    { mode: "build", planEnabled: false },
  );
  assert.deepEqual(update, { mode: "zcodeUpdate", planEnabled: false });
});

test("parseStdWorkflowStageMarker reads the canonical marker line", () => {
  const text = ["# 工作台账", "", "<!-- std-workflow v1 stage:W2-F -->", "", "## 记录"].join("\n");
  assert.deepEqual(parseStdWorkflowStageMarker(text), { version: 1, stage: "W2-F" });
});

test("parseStdWorkflowStageMarker prefers the last marker over earlier examples", () => {
  // 台账顶部常出现模板/示例标记（wf-start 生成的台账自带说明行），活标记是被改写的那条。
  const text = [
    "标记行格式：`<!-- std-workflow v1 stage:W0 -->`（每次推进更新）",
    "",
    "<!-- std-workflow v1 stage:W2-F -->",
  ].join("\n");
  assert.deepEqual(parseStdWorkflowStageMarker(text), { version: 1, stage: "W2-F" });
});

test("parseStdWorkflowStageMarker rejects unknown marker versions", () => {
  // v2 格式未知：按 v1 规则推导比诚实说没认出更糟，必须返回 null。
  assert.equal(parseStdWorkflowStageMarker("<!-- std-workflow v2 stage:W2-F -->"), null);
});

test("parseStdWorkflowStageMarker returns null without a marker", () => {
  assert.equal(parseStdWorkflowStageMarker("# 工作台账\n\n没有标记行"), null);
});

test("deriveStdWorkflowStageStrip marks same-lane ordering only", () => {
  const strip = deriveStdWorkflowStageStrip("W2-F");
  assert.equal(strip.known, true);
  assert.deepEqual(
    strip.frontend.map((entry) => [entry.stage, entry.state]),
    [
      ["W1-F", "done"],
      ["W2-F", "current"],
      ["W3-F", "pending"],
      ["W4-F", "pending"],
    ],
  );
  // 双轨当前：主线只判定 W0/W0.5 为 done；后端轨不做跨轨推断。
  assert.deepEqual(
    strip.main.map((entry) => entry.state),
    ["done", "done", "pending", "pending", "pending", "pending", "pending", "pending", "pending"],
  );
  assert.deepEqual(
    strip.backend.map((entry) => entry.state),
    ["pending", "pending"],
  );
  assert.deepEqual(strip.nextAdversarial, {
    stage: "W3-F",
    workflow: STD_WORKFLOW_ADVERSARIAL_WORKFLOWS["W3-F"],
  });
  assert.equal(strip.adversarialInProgress, undefined);
});

test("deriveStdWorkflowStageStrip reports an in-progress adversarial round at its own stage", () => {
  const strip = deriveStdWorkflowStageStrip("W3-F");
  assert.deepEqual(strip.adversarialInProgress, {
    stage: "W3-F",
    workflow: STD_WORKFLOW_ADVERSARIAL_WORKFLOWS["W3-F"],
  });
  // 「下一个」必须严格晚于当前，不能指向自己。
  assert.equal(strip.nextAdversarial?.stage, "W6");

  const final = deriveStdWorkflowStageStrip("W10");
  assert.deepEqual(final.adversarialInProgress, {
    stage: "W10",
    workflow: STD_WORKFLOW_ADVERSARIAL_WORKFLOWS["W10"],
  });
  assert.equal(final.nextAdversarial, undefined);
});

test("deriveStdWorkflowStageStrip treats tracks as done once the main line reaches W5", () => {
  const strip = deriveStdWorkflowStageStrip("W6");
  assert.deepEqual(
    strip.main.map((entry) => [entry.stage, entry.state]),
    [
      ["W0", "done"],
      ["W0.5", "done"],
      ["W5", "done"],
      ["W6", "current"],
      ["W7", "pending"],
      ["W8", "pending"],
      ["W9", "pending"],
      ["W10", "pending"],
      ["W11", "pending"],
    ],
  );
  assert.equal(
    strip.frontend.every((entry) => entry.state === "done"),
    true,
  );
  assert.equal(
    strip.backend.every((entry) => entry.state === "done"),
    true,
  );
  assert.equal(strip.nextAdversarial?.stage, "W8");
});

test("deriveStdWorkflowStageStrip degrades honestly on unknown stages", () => {
  const strip = deriveStdWorkflowStageStrip("W99");
  assert.equal(strip.known, false);
  assert.equal(strip.stage, "W99");
  assert.equal(
    strip.main.every((entry) => entry.state === "pending"),
    true,
  );
  // 未知阶段零推断：对抗轮口径同样缺席，不与「不做先后推断」横幅自相矛盾。
  assert.equal(strip.nextAdversarial, undefined);
  assert.equal(strip.adversarialInProgress, undefined);
});

test("adversarial workflows point at the two saved engines", () => {
  assert.equal(STD_WORKFLOW_ADVERSARIAL_WORKFLOWS["W3-F"], "wf-fe-acceptance");
  assert.equal(STD_WORKFLOW_ADVERSARIAL_WORKFLOWS["W6"], "wf-adversarial-audit");
  assert.equal(STD_WORKFLOW_LEDGER_RELATIVE_PATH, "workflow/工作台账.md");
});
