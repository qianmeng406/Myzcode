import assert from "node:assert/strict";
import test from "node:test";
import {
  executionPermissionModeSchema,
  resolveExecutionState,
} from "../src/execution-state.js";
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

test("parseStdWorkflowStageMarker reads the canonical marker line", () => {
  const text = [
    "# 工作台账",
    "",
    "<!-- std-workflow v1 stage:W2-F -->",
    "",
    "## 记录",
  ].join("\n");
  assert.deepEqual(parseStdWorkflowStageMarker(text), { version: 1, stage: "W2-F" });
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
  assert.equal(strip.frontend.every((entry) => entry.state === "done"), true);
  assert.equal(strip.backend.every((entry) => entry.state === "done"), true);
  assert.equal(strip.nextAdversarial?.stage, "W8");
});

test("deriveStdWorkflowStageStrip degrades honestly on unknown stages", () => {
  const strip = deriveStdWorkflowStageStrip("W99");
  assert.equal(strip.known, false);
  assert.equal(strip.stage, "W99");
  assert.equal(strip.main.every((entry) => entry.state === "pending"), true);
  assert.equal(strip.nextAdversarial?.stage, "W3-F");
});

test("adversarial workflows point at the two saved engines", () => {
  assert.equal(STD_WORKFLOW_ADVERSARIAL_WORKFLOWS["W3-F"], "wf-fe-acceptance");
  assert.equal(STD_WORKFLOW_ADVERSARIAL_WORKFLOWS["W6"], "wf-adversarial-audit");
  assert.equal(STD_WORKFLOW_LEDGER_RELATIVE_PATH, "workflow/工作台账.md");
});
