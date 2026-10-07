// 会话状态纯逻辑回归：多题答案构造 / 快照权威替换 / 交互解析（questions/plan 标记）。
// 运行：packages/mobile 下 `npx tsx --test test/*.test.ts`（node:test，与仓库其他包一致）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFrame,
  buildElicitationAnswer,
  INITIAL_STATE,
  type ConversationState,
} from "../src/conversationState.js";

function frameWithSnapshot(snapshot: Record<string, unknown>): Parameters<typeof applyFrame>[1] {
  return {
    topic: "conversation/s1",
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq: 10,
    sentAt: 1,
    payload: { kind: "snapshot", snapshot },
  } as unknown as Parameters<typeof applyFrame>[1];
}

function frameWithDeltas(toSeq: number, deltas: unknown[]): Parameters<typeof applyFrame>[1] {
  return {
    topic: "conversation/s1",
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq,
    sentAt: 1,
    payload: { kind: "deltas", deltas },
  } as unknown as Parameters<typeof applyFrame>[1];
}

test("buildElicitationAnswer：与桌面同语义的 content 构造", () => {
  const questions = [
    {
      question: "采用哪个方案？",
      header: "方案",
      multiSelect: false,
      options: [
        { value: "a", label: "方案 A" },
        { value: "b", label: "方案 B" },
      ],
    },
    {
      question: "附带哪些模块？",
      header: "范围",
      multiSelect: true,
      options: [
        { value: "x", label: "X" },
        { value: "y", label: "Y" },
      ],
    },
  ];
  const answer = buildElicitationAnswer(questions, {
    "采用哪个方案？": ["b"],
    "附带哪些模块？": ["x", "y"],
    // 未作答的第三题不存在于 content。
  });
  assert.equal(answer.action, "accept");
  assert.deepEqual(answer.content.answers, {
    "采用哪个方案？": "b",
    "附带哪些模块？": "x, y",
  });
  assert.equal(answer.content.answer_0, "b");
  assert.deepEqual(answer.content.answer_1, ["x", "y"]);
  assert.equal("answer" in answer.content, false); // 多题不写单题兼容键
});

test("buildElicitationAnswer：单题写 answer 兼容键；全空题 content 只有空 answers", () => {
  const single = [
    { question: "继续吗？", header: "", multiSelect: false, options: [{ value: "y", label: "是" }] },
  ];
  const answered = buildElicitationAnswer(single, { "继续吗？": ["y"] });
  assert.equal(answered.content.answer, "y");
  assert.equal(answered.content.answer_0, "y");

  const empty = buildElicitationAnswer(single, {});
  assert.deepEqual(empty.content.answers, {});
  assert.equal("answer" in empty.content, false);
});

test("applyFrame：快照权威替换（残留行/会话被清除）+ revision 游标推进", () => {
  const seeded = applyFrame(INITIAL_STATE, frameWithSnapshot({
    sessionId: "s1",
    logEpoch: "epoch-1",
    revision: 7,
    config: { mode: "build" },
    rows: { window: [{ rowId: 1, entityId: "e1", kind: "assistantText", text: "旧内容" }] },
    pendingInteractions: [],
  }));
  assert.equal(seeded.revision, 7);
  assert.equal(seeded.logEpoch, "epoch-1");
  assert.equal(seeded.rows.length, 1);

  // 增量帧推进 revision；全新快照（不含旧行）整体替换。
  const withDelta = applyFrame(seeded, frameWithDeltas(11, []));
  assert.equal(withDelta.revision, 11);
  const replaced = applyFrame(withDelta, frameWithSnapshot({
    sessionId: "s1",
    logEpoch: "epoch-1",
    revision: 12,
    rows: { window: [{ rowId: 2, entityId: "e2", kind: "assistantText", text: "新内容" }] },
    pendingInteractions: [],
  }));
  assert.equal(replaced.revision, 12);
  assert.equal(replaced.rows.length, 1);
  assert.equal(replaced.rows[0]!.rowId, 2);
});

test("describeInteraction：多题 userInput 解析 questions 与 plan_approval 标记", () => {
  const state: ConversationState = applyFrame(INITIAL_STATE, frameWithSnapshot({
    sessionId: "s1",
    logEpoch: "e",
    revision: 1,
    rows: { window: [] },
    pendingInteractions: [
      {
        interactionId: "i1",
        kind: "userInput",
        payload: {
          kind: "userInput",
          prompt: "请确认计划",
          freeText: false,
          schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
          questions: [
            {
              question: "批准该计划？",
              header: "计划",
              multiSelect: false,
              options: [{ value: "yes", label: "批准" }],
            },
          ],
        },
      },
    ],
  }));
  assert.equal(state.interactions.length, 1);
  const interaction = state.interactions[0]!;
  assert.equal(interaction.isPlanApproval, true);
  assert.equal(interaction.questions.length, 1);
  assert.equal(interaction.questions[0]!.options[0]!.label, "批准");
});
