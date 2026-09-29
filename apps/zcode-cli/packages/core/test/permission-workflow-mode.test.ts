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

test("zcodeUpdate mode allows commands and edits with its own rule id", () => {
  const service = new PermissionService();
  const decision = service.checkPermission({
    toolName: "Bash",
    input: { command: "git fetch origin --tags" },
    riskLevel: "medium",
    mode: "zcodeUpdate",
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.zcodeUpdate");
});

test("zcodeUpdate mode does not bypass plan-mode restrictions when plan is enabled", () => {
  const service = new PermissionService();
  const decision = service.checkPermission({
    toolName: "Bash",
    input: { command: "git fetch origin" },
    riskLevel: "medium",
    mode: "zcodeUpdate",
    planEnabled: true,
  });
  // 与 workflow 同口径：plan 分支先于模式放行，非只读命令仍必须拒绝。
  assert.equal(decision.decision, "deny");
});

test("zcodeUpdate mode still honors user-configured disallowedTools", () => {
  // 放行排在 disallowedTools 之后：用户显式禁用清单是比「完整权限」更强的意图表达。
  const service = new PermissionService({
    allowedTools: new Set<string>(),
    disallowedTools: new Set(["Bash"]),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
  });
  const decision = service.checkPermission({
    toolName: "Bash",
    input: { command: "git fetch origin" },
    riskLevel: "medium",
    mode: "zcodeUpdate",
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.disallowedTools");
});

test("minimal mode executes commands and edits with its own rule id", () => {
  // 极简模式的权限与上下文一样极简：自动执行、不逐次确认（与 workflow/zcodeUpdate 同姿态）。
  const service = new PermissionService();
  const decision = service.checkPermission({
    toolName: "Bash",
    input: { command: "ls" },
    riskLevel: "medium",
    mode: "minimal",
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.minimal");
});

test("minimal mode does not bypass plan-mode restrictions when plan is enabled", () => {
  const service = new PermissionService();
  const decision = service.checkPermission({
    toolName: "Bash",
    input: { command: "npm run build" },
    riskLevel: "medium",
    mode: "minimal",
    planEnabled: true,
  });
  // plan 分支先于模式放行：非只读命令必须仍然拒绝，不能借极简模式绕过。
  assert.equal(decision.decision, "deny");
});

test("minimal mode still honors user-configured disallowedTools", () => {
  // 放行排在 disallowedTools 之后：用户显式禁用清单是比「完整权限」更强的意图表达。
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
    mode: "minimal",
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.disallowedTools");
});
