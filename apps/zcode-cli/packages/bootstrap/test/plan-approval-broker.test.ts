import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionBrokerRequest } from "@zcode/contracts";
import { planApprovalResponseToBrokerResult } from "../src/zcode-protocol/interaction-broker.js";

function brokerRequest(input: unknown): PermissionBrokerRequest {
  return {
    requestId: "perm_1",
    sessionId: "sess-1",
    traceId: "trace-1",
    toolCallId: "call-1",
    toolName: "ExitPlanMode",
    input,
    mode: "plan",
    ruleId: "rule.plan.exit",
    reason: "Review this implementation plan.",
    riskLevel: "low",
    requestedAt: new Date(0),
  };
}

function approveResponse(content?: Record<string, unknown>) {
  return {
    action: "accept" as const,
    ...(content ? { content } : {}),
  };
}

test("批准不带执行模型：allow 决策（现行行为不变）", () => {
  const result = planApprovalResponseToBrokerResult(
    brokerRequest({ plan: "- step" }),
    approveResponse({ answer: "approve" }),
  );
  assert.equal(result.decision, "allow");
  assert.equal(result.modifiedInput, undefined);
});

test("批准附带执行模型：modify 决策把选择合并进工具输入（含推理档）", () => {
  const selection = {
    providerId: "command-code",
    modelId: "deepseek/deepseek-v4.1-flash",
    options: { reasoningLevel: "high" },
  };
  const result = planApprovalResponseToBrokerResult(
    brokerRequest({ plan: "- step", allowedPrompts: [] }),
    approveResponse({ answer: "approve", executionModelSelection: selection }),
  );
  assert.equal(result.decision, "modify");
  assert.deepEqual(result.modifiedInput, {
    plan: "- step",
    allowedPrompts: [],
    executionModelSelection: selection,
  });
});

test("非法模型选择形状不进 modify 分支（回落 allow）", () => {
  const result = planApprovalResponseToBrokerResult(
    brokerRequest({ plan: "- step" }),
    approveResponse({
      answer: "approve",
      executionModelSelection: { providerId: 1, modelId: "m" },
    }),
  );
  assert.equal(result.decision, "allow");
});

test("反馈文本仍走 plan_approval_feedback deny；拒绝走普通 deny", () => {
  const feedback = planApprovalResponseToBrokerResult(
    brokerRequest({ plan: "- step" }),
    approveResponse({ answer: "请把步骤 2 拆细" }),
  );
  assert.equal(feedback.decision, "deny");
  assert.equal(feedback.reasonSource, "plan_approval_feedback");

  const decline = planApprovalResponseToBrokerResult(brokerRequest({ plan: "- step" }), {
    action: "decline",
  });
  assert.equal(decline.decision, "deny");
  assert.equal(decline.reasonSource, undefined);
});
