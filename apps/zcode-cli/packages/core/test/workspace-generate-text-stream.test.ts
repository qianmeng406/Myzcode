import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelRequest, ModelStreamEvent, ModelUsage } from "../src/deps.js";
import { streamModelTextResult } from "../src/runtime/methods/workspace-generate-text.js";

/**
 * streamModelTextResult 的事件聚合单测。Model 只需提供 streamText：
 * 聚合函数只消费事件流，不触碰 provider/端点。
 */
function fakeModel(events: ModelStreamEvent[]): Model {
  return {
    streamText: async function* () {
      for (const event of events) {
        yield event;
      }
    },
  } as unknown as Model;
}

const usage: ModelUsage = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
} as unknown as ModelUsage;

const request = { messages: [] } as unknown as ModelRequest;

test("聚合 text_delta 与 finish，产出与 generateText 同形结果", async () => {
  const result = await streamModelTextResult(
    fakeModel([
      { type: "start" },
      { type: "text_delta", text: "VERDICT: PASS" },
      { type: "text_delta", text: "\nSUMMARY: ok" },
      { type: "finish", finishReason: "stop", usage },
    ]),
    request,
  );
  assert.equal(result.text, "VERDICT: PASS\nSUMMARY: ok");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage, usage);
  assert.equal(result.toolCalls, undefined);
});

test("完整 tool_call 与增量 tool_input 序列都聚合；同 id 去重", async () => {
  const result = await streamModelTextResult(
    fakeModel([
      { type: "tool_call", toolCall: { id: "call-1", name: "read", input: { path: "a.ts" } } },
      // 同 id 的完整事件重复投递 → 只收一次
      { type: "tool_call", toolCall: { id: "call-1", name: "read", input: { path: "a.ts" } } },
      // 增量序列 → end 时解析 JSON 输入
      { type: "tool_input_start", id: "call-2", toolName: "bash" },
      { type: "tool_input_delta", id: "call-2", delta: '{"command":' },
      { type: "tool_input_delta", id: "call-2", delta: '"ls"}' },
      { type: "tool_input_end", id: "call-2" },
      { type: "finish", finishReason: "tool_calls", usage },
    ]),
    request,
  );
  assert.equal(result.toolCalls?.length, 2);
  assert.equal(result.toolCalls?.[0]?.id, "call-1");
  assert.deepEqual(result.toolCalls?.[1]?.input, { command: "ls" });
});

test("增量 JSON 损坏时不丢调用（降级为 _raw），缺 finish 抛错并带聚合进度", async () => {
  const broken = await streamModelTextResult(
    fakeModel([
      { type: "tool_input_start", id: "t", toolName: "bash" },
      { type: "tool_input_delta", id: "t", delta: "not-json{" },
      { type: "tool_input_end", id: "t" },
      { type: "finish", finishReason: "stop", usage },
    ]),
    request,
  );
  assert.equal(broken.toolCalls?.[0]?.name, "bash");
  assert.ok("_raw" in (broken.toolCalls?.[0]?.input as Record<string, unknown>));

  await assert.rejects(
    streamModelTextResult(
      fakeModel([{ type: "text_delta", text: "partial" }]),
      request,
    ),
    (error: Error) => {
      assert.match(error.message, /finish 事件前结束/);
      assert.match(error.message, /textLength=7/);
      return true;
    },
  );
});
