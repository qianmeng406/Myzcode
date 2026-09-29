import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { buildRuntimeModeReminderBody } from "../src/runtime/helpers/runtime-reminders.js";

/**
 * 最小历史条目构造。buildRuntimeModeReminderBody 只读 message.role 与
 * metadata.source（real_user 计人类轮、runtime_mode 计 reminder），这里只填这两面，
 * 其余字段用 as unknown as 收窄——比在测试里铺满整个 RuntimeMessageEntry 联合诚实。
 */
function humanTurn(): RuntimeMessageEntry {
  return {
    message: { role: "user", content: "继续" },
    metadata: { source: "real_user" },
  } as unknown as RuntimeMessageEntry;
}

function modeReminder(): RuntimeMessageEntry {
  return {
    kind: "attachment",
    message: { role: "user", content: "<system-reminder>…</system-reminder>" },
    metadata: { source: "runtime_mode" },
  } as unknown as RuntimeMessageEntry;
}

test("workflow mode emits the full SOP on the first reminder", () => {
  const body = buildRuntimeModeReminderBody([], "workflow");
  assert.ok(body);
  assert.ok(body!.includes("# 项目开发模式"));
  assert.ok(body!.includes("workflow/工作台账.md"));
  assert.ok(body!.includes("wf-fe-acceptance"));
  assert.ok(body!.includes("wf-adversarial-audit"));
  assert.ok(body!.includes("std-workflow v1 stage"));
  // 接手已有项目：无台账的存量项目必须先盘点，不能从零重做。
  assert.ok(body!.includes("接手盘点"));
  assert.ok(body!.includes("不要从零重做"));
  assert.ok(body!.includes("代码能跑 ≠ 已通过"));
});

test("workflow mode throttles like research mode within 5 human turns", () => {
  const entries = [modeReminder(), humanTurn(), humanTurn()];
  assert.equal(buildRuntimeModeReminderBody(entries, "workflow"), null);
});

test("workflow mode alternates to the sparse reminder when eligible", () => {
  // 一条已存在的 reminder（count=1 → 下一条是第 2 条，2 % 5 != 1 → sparse），
  // 且距离它已有 5 个未应答的人类轮。
  const entries = [
    modeReminder(),
    humanTurn(),
    humanTurn(),
    humanTurn(),
    humanTurn(),
    humanTurn(),
  ];
  const body = buildRuntimeModeReminderBody(entries, "workflow");
  assert.ok(body);
  assert.ok(!body!.includes("# 项目开发模式"));
  assert.ok(body!.includes("项目开发模式仍处于激活状态"));
});

test("workflow mode cycles back to the full SOP every 5th attachment", () => {
  const fullAgain = [
    ...Array.from({ length: 5 }, () => humanTurn()),
    modeReminder(), // count=1
    ...Array.from({ length: 5 }, () => humanTurn()),
    modeReminder(), // count=2（sparse）
    ...Array.from({ length: 5 }, () => humanTurn()),
    modeReminder(), // count=3
    ...Array.from({ length: 5 }, () => humanTurn()),
    modeReminder(), // count=4
    ...Array.from({ length: 5 }, () => humanTurn()),
    modeReminder(), // count=5 → 下一条是第 6 条？不——见下
  ];
  // 第 5 条已存在时下一条是第 6 条；6 % 5 = 1 → full。这里从 5 条推进到第 6 次附加：
  const entries = [...fullAgain, ...Array.from({ length: 5 }, () => humanTurn())];
  const body = buildRuntimeModeReminderBody(entries, "workflow");
  assert.ok(body);
  assert.ok(body!.includes("# 项目开发模式"));
});

test("research and plan modes are unaffected by the workflow branch", () => {
  const research = buildRuntimeModeReminderBody([], "research");
  assert.ok(research!.includes("# 资料查询模式"));
  const plan = buildRuntimeModeReminderBody([], "plan", true);
  assert.ok(plan!.includes("Plan mode is active"));
  assert.equal(buildRuntimeModeReminderBody([], "build"), null);
});
