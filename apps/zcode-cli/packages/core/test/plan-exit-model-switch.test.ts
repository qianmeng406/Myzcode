import assert from "node:assert/strict";
import test from "node:test";
import type { ToolExecutionResult } from "../src/tool/types.js";
import { withPlanExitApprovedTurnStop } from "../src/tool/executor/turn-control.js";

function approvedResult(output: unknown): ToolExecutionResult {
  return {
    toolCallId: "call-1",
    toolName: "ExitPlanMode",
    success: true,
    output,
    durationMs: 1,
    startedAt: new Date(0),
    completedAt: new Date(0),
  };
}

function baseInput() {
  return { mode: "plan" as const, planEnabled: true, toolName: "ExitPlanMode" };
}

test("批准带执行模型：停回合并经 follow-up 携带模型选择", () => {
  const result = withPlanExitApprovedTurnStop(
    approvedResult({
      approved: true,
      mode: "build",
      plan: "- step",
      executionModelSelection: {
        providerId: "command-code",
        modelId: "deepseek/deepseek-v4.1-flash",
        options: { reasoningLevel: "high" },
      },
    }),
    baseInput(),
  );
  assert.equal(result.turnControl?.reason, "plan_exit_approved_model_switch");
  assert.equal(result.turnControl?.stopTurnAfterResult, true);
  assert.equal(result.followUpUserInput?.reasonSource, "plan_approval_feedback");
  assert.deepEqual(result.followUpUserInput?.modelSelection, {
    providerId: "command-code",
    modelId: "deepseek/deepseek-v4.1-flash",
    options: { reasoningLevel: "high" },
  });
  assert.match(result.followUpUserInput?.input ?? "", /plan was approved/);
});

test("批准不带执行模型：结果原样返回（同回合继续，现行行为）", () => {
  const result = withPlanExitApprovedTurnStop(
    approvedResult({ approved: true, mode: "build", plan: "- step" }),
    baseInput(),
  );
  assert.equal(result.turnControl, undefined);
  assert.equal(result.followUpUserInput, undefined);
});

test("真实时序：handler 已退出计划（planEnabled 显式 false，mode 仍 plan）照常触发", () => {
  const result = withPlanExitApprovedTurnStop(
    approvedResult({
      approved: true,
      mode: "build",
      executionModelSelection: { providerId: "p", modelId: "m" },
    }),
    { mode: "plan", planEnabled: false, toolName: "ExitPlanMode" },
  );
  assert.equal(result.turnControl?.reason, "plan_exit_approved_model_switch");
});

test("非计划模式 / 非本工具 / 失败结果不进换模分支", () => {
  const output = {
    approved: true,
    executionModelSelection: { providerId: "p", modelId: "m" },
  };
  const original = approvedResult(output);
  assert.equal(
    withPlanExitApprovedTurnStop(original, {
      mode: "build",
      planEnabled: false,
      toolName: "ExitPlanMode",
    }),
    original,
  );
  assert.equal(
    withPlanExitApprovedTurnStop(approvedResult(output), {
      mode: "plan",
      planEnabled: true,
      toolName: "Bash",
    }).turnControl,
    undefined,
  );
  const failed: ToolExecutionResult = {
    ...approvedResult(output),
    success: false,
    error: { type: "PermissionDenied", message: "denied" },
  };
  assert.equal(withPlanExitApprovedTurnStop(failed, baseInput()).turnControl, undefined);
});

test("畸形模型选择（缺 providerId/modelId）不触发换模", () => {
  const result = withPlanExitApprovedTurnStop(
    approvedResult({ approved: true, executionModelSelection: { modelId: "m" } }),
    baseInput(),
  );
  assert.equal(result.turnControl, undefined);
});
