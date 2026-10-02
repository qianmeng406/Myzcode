import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelRequest, ModelStreamEvent, ModelUsage } from "../src/deps.js";
import type { ExecutableToolCall, ToolExecutionResult } from "../src/tool/types.js";
import {
  evaluateDeepReviewToolPolicy,
  runDeepReviewAgentLoop,
} from "../src/runtime/methods/workspace-deep-review.js";
import { streamModelTextResult } from "../src/runtime/methods/workspace-generate-text.js";
import { runToolAgentLoop } from "../src/memory/memory-agent-loop.js";

/** evaluateDeepReviewToolPolicy 只需要 workingDirectory/workspaceRoot 两个字段。 */
const fakeRuntime = {
  workingDirectory: "/repo",
  workspaceRoot: "/repo",
} as unknown as Parameters<typeof evaluateDeepReviewToolPolicy>[1];

function toolCall(name: string, input: unknown) {
  return { id: `call-${name}`, name, input };
}

test("深度审查策略：读类工具放行，写工具与非只读 Bash 一律拒绝", () => {
  assert.deepEqual(evaluateDeepReviewToolPolicy(toolCall("Read", {}), fakeRuntime), {
    allowed: true,
  });
  assert.deepEqual(evaluateDeepReviewToolPolicy(toolCall("Grep", {}), fakeRuntime), {
    allowed: true,
  });
  assert.deepEqual(evaluateDeepReviewToolPolicy(toolCall("Glob", {}), fakeRuntime), {
    allowed: true,
  });

  const bashRead = evaluateDeepReviewToolPolicy(
    toolCall("Bash", { command: "ls -la src" }),
    fakeRuntime,
  );
  assert.equal(bashRead.allowed, true);

  const bashWrite = evaluateDeepReviewToolPolicy(
    toolCall("Bash", { command: "rm -rf /tmp/x" }),
    fakeRuntime,
  );
  assert.equal(bashWrite.allowed, false);
  if (!bashWrite.allowed) assert.match(bashWrite.reason, /read-only/i);

  const write = evaluateDeepReviewToolPolicy(toolCall("Write", { file_path: "/repo/a.ts" }), fakeRuntime);
  assert.equal(write.allowed, false);

  const agent = evaluateDeepReviewToolPolicy(toolCall("Agent", {}), fakeRuntime);
  assert.equal(agent.allowed, false);
});

/** 每轮返回固定事件流的假模型（streamText 路径）。 */
function fakeModel(script: ModelStreamEvent[][]): Model {
  let index = 0;
  return {
    // media 投影策略读取 inputFormat；辅助档请求选项读取 optionSpecs。纯文本假模型。
    properties: { inputFormat: "text" },
    optionSpecs: {
      reasoningLevel: { values: ["low"] },
      maxOutputTokens: { min: 1, max: 8192 },
    },
    streamText: async function* () {
      const events = script[Math.min(index, script.length - 1)]!;
      index += 1;
      for (const event of events) {
        yield event;
      }
    },
  } as unknown as Model;
}

const usage: ModelUsage = {
  inputTokens: 5,
  outputTokens: 3,
  totalTokens: 8,
} as unknown as ModelUsage;

const finish = { type: "finish" as const, finishReason: "stop", usage };

test("runToolAgentLoop（深度审查共用骨架）：策略拒绝回填错误消息，工具结果进入下一轮", async () => {
  const executed: string[] = [];
  const executeTool = async (call: ExecutableToolCall): Promise<ToolExecutionResult> => {
    executed.push(call.name);
    return { toolCallId: call.id, toolName: call.name, success: true, output: "ok" };
  };
  const events: Array<{ turn: number; phase: string; toolName?: string }> = [];

  const result = await runToolAgentLoop({
    maxTurns: 5,
    messages: [{ role: "user", content: "review" }],
    generate: async (model, request) => {
      const r = await streamModelTextResult(model, request);
      return { text: r.text, toolCalls: r.toolCalls };
    },
    model: fakeModel([
      [
        { type: "tool_call", toolCall: { id: "call-Write", name: "Write", input: {} } },
        finish,
      ],
      [{ type: "text_delta", text: "VERDICT: PASS" }, finish],
    ]),
    rootDir: "/repo",
    tools: [{ name: "Write", inputSchema: {} }, { name: "Read", inputSchema: {} }] as never,
    workingDirectory: "/repo",
    workspaceRoot: "/repo",
    onTurn: (event) => events.push(event),
    // 全禁策略：任何工具都拒绝（覆盖「拒绝理由回填下一轮」路径）。
    evaluateToolPolicy: () => ({ allowed: false, reason: "denied-by-test" }),
    executeTool,
  });

  assert.deepEqual(executed, []); // 被策略拒绝的工具不落执行面
  // 第二轮请求的消息里应带第一条 assistant(toolCalls) + 拒绝错误 + 收尾正文
  assert.equal(result.turns, 2);
  const eventsByPhase = events.map((event) => event.phase);
  assert.deepEqual(eventsByPhase, ["generate", "tool", "generate"]);
  assert.equal(events[1]?.toolName, "Write");
});

test("runToolAgentLoop：maxTurns 到顶即收，不再发起下一轮生成", async () => {
  let generateCalls = 0;
  const alwaysTool: ModelStreamEvent[] = [
    { type: "tool_call", toolCall: { id: "c1", name: "Read", input: {} } },
    finish,
  ];
  const result = await runToolAgentLoop({
    maxTurns: 3,
    messages: [{ role: "user", content: "review" }],
    generate: async (model, request) => {
      const r = await streamModelTextResult(model, request);
      return { text: r.text, toolCalls: r.toolCalls };
    },
    model: fakeModel([alwaysTool]),
    rootDir: "/repo",
    tools: [{ name: "Read", inputSchema: {} }] as never,
    workingDirectory: "/repo",
    workspaceRoot: "/repo",
    evaluateToolPolicy: () => ({ allowed: true }),
    executeTool: async (call) => ({
      toolCallId: call.id,
      toolName: call.name,
      success: true,
      output: "ok",
    }),
  });
  // maxTurns=3 → 恰好 3 轮（每轮都要求工具），第 4 轮不发生
  assert.equal(result.turns, 3);
  void generateCalls;
});

test("runDeepReviewAgentLoop：端到端聚合 usage/正文，进度携带轮次与工具名", async () => {
  const runtime = {
    workingDirectory: "/repo",
    workspaceRoot: "/repo",
    sessionId: "s",
    config: {},
    registry: {
      // executor 会经 registry.get 取 entry 执行；给最小 handler 假实现。
      get: (name: string) => ({
        metadata: { name },
        name,
        description: "test tool",
        inputSchema: {},
        handler: async () => ({
          toolCallId: "",
          toolName: name,
          success: true,
          output: "ok",
        }),
      }),
      has: () => true,
      list: () => ["Read", "Write"],
      toContracts: () => [
        { name: "Read", description: "read", inputSchema: {} },
        { name: "Write", description: "write", inputSchema: {} },
      ],
    },
    artifactStore: {},
    executionPort: {},
    fileSystemPort: {},
    imageProcessorPort: {},
    pdfDocumentPort: {},
    sessionStore: {},
    skillPort: undefined,
  } as unknown as Parameters<typeof runDeepReviewAgentLoop>[0];

  const progress: Array<{ round?: number; toolName?: string; outputChars: number }> = [];
  const result = await runDeepReviewAgentLoop(runtime, {
    messages: [{ role: "user", content: "review" }],
    model: fakeModel([
      [{ type: "tool_call", toolCall: { id: "r1", name: "Read", input: {} } }, finish],
      [{ type: "text_delta", text: "VERDICT: FAIL" }, finish],
    ]),
    onProgress: (p) => progress.push(p),
  });

  assert.equal(result.text, "VERDICT: FAIL");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.outputTokens, 6); // 两轮各 3，累计
  assert.equal(result.turns, 2);
  // 进度事件：轮 1 工具执行带 round+toolName；轮 2 生成带 round 与产出字符
  assert.ok(progress.some((p) => p.round === 1 && p.toolName === "Read"));
  assert.ok(progress.some((p) => p.round === 2 && p.outputChars > 0));
});
