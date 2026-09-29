import assert from "node:assert/strict";
import test from "node:test";
import { PermissionService } from "../src/permission/service.js";

test("workflow mode allows commands and edits like yolo, with its own rule id", () => {
  const service = new PermissionService();
  const decision = service.checkPermission({
    toolName: "Bash",
    input: { command: "find . -name '*Controller.java' | wc -l" },
    riskLevel: "medium",
    mode: "workflow",
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.workflow");
});

test("workflow mode does not bypass plan-mode restrictions when plan is enabled", () => {
  const service = new PermissionService();
  const decision = service.checkPermission({
    toolName: "Bash",
    input: { command: "npm run build" },
    riskLevel: "medium",
    mode: "workflow",
    planEnabled: true,
  });
  // plan 分支先于模式放行：非只读命令必须仍然拒绝，不能借 workflow 绕过。
  assert.equal(decision.decision, "deny");
});

test("workflow mode still honors user-configured disallowedTools", () => {
  // workflow 的自动执行排在 disallowedTools 之后：用户显式禁用清单是比「完整权限」
  // 更强的意图表达（yolo 的既有位置保持不动，这是 workflow 与 yolo 唯一的语义差）。
  const service = new PermissionService({
    allowedTools: new Set<string>(),
    disallowedTools: new Set(["Bash"]),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
  });
  const decision = service.checkPermission({
    toolName: "Bash",
    input: { command: "ls" },
    riskLevel: "medium",
    mode: "workflow",
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.disallowedTools");
});

test("yolo keeps its own rule id", () => {
  const service = new PermissionService();
  const decision = service.checkPermission({
    toolName: "Bash",
    input: { command: "ls" },
    riskLevel: "medium",
    mode: "yolo",
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.yolo");
});
