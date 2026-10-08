// 只读任务索引双读路径测试（phase-1 修复：桌面工作区「暂无任务」）。
// 关键回归：sessions-index 在该工作区 agent 运行时未启动时必然不可用
// （Host existing-only 抛 "ZCode Agent runtime is not running."），
// 此时必须回落到同一临时端口上的磁盘任务读面（IZCodeTaskService.listTasks），
// 且两处都不得启动任何执行者。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IChannel } from "@zcode/rpc";
import { IZCodeAgentService, IZCodeTaskService } from "@zcode/services";
import { readWorkspaceTaskSummary } from "../src/companion/ephemeralTaskIndex.js";

type Handler = (...args: unknown[]) => unknown;

function fakeChannel(handlers: Record<string, Handler>): IChannel {
  return {
    async call<T>(command: string, args?: unknown): Promise<T> {
      const handler = handlers[command];
      if (!handler) throw new Error(`Method not found: ${command}`);
      const list = Array.isArray(args) ? args : [];
      return (await handler(...list)) as T;
    },
    listen<T>(): never {
      throw new Error("listen not supported in fake channel");
    },
  } as unknown as IChannel;
}

interface Harness {
  calls: string[];
  /** 磁盘读面被访问次数（断言 sessions-index 成功时不再做多余读取）。 */
  taskListCalls: number;
  summary: Awaited<ReturnType<typeof readWorkspaceTaskSummary>>;
}

async function run(options: {
  agentHandlers?: Record<string, Handler>;
  tasks?: Array<Record<string, unknown>>;
  omitTaskChannel?: boolean;
}): Promise<Harness> {
  const calls: string[] = [];
  const harness = { calls, taskListCalls: 0 } as Harness;
  const channels = new Map<string, IChannel>();
  channels.set(
    IZCodeAgentService.channelName,
    fakeChannel(
      options.agentHandlers ?? {
        helloConversationV4: () => ({}),
        initializeConversationV4: () => undefined,
        subscribeSessionsIndexV4: () => {
          throw new Error("ZCode Agent runtime is not running.");
        },
      },
    ),
  );
  if (!options.omitTaskChannel) {
    channels.set(
      IZCodeTaskService.channelName,
      fakeChannel({
        listTasks: (params: unknown) => {
          harness.taskListCalls += 1;
          calls.push("listTasks");
          const record = params as { workspacePath?: string; workspaceIdentity?: string };
          assert.equal(
            record.workspacePath,
            "C:\\ws",
            "磁盘读面必须带目标工作区路径（不做跨工作区聚合）",
          );
          return options.tasks ?? [];
        },
      }),
    );
  }
  harness.summary = await readWorkspaceTaskSummary({
    workspacePath: "C:\\ws",
    workspaceIdentity: "C:\\ws",
    createUpstream: async () => ({
      channelClient: {
        getChannel: (name: string) => {
          const channel = channels.get(name);
          if (!channel) throw new Error(`unknown channel: ${name}`);
          return channel;
        },
      },
      dispose: () => undefined,
    }),
  });
  return harness;
}

test("运行时未启动时回落到磁盘任务读面，返回历史会话", async () => {
  const harness = await run({
    tasks: [
      {
        taskId: "sess_old",
        title: "较早任务",
        updatedAt: 1_000,
        status: "completed",
        pendingInteraction: { interactionId: "i1", kind: "permission" },
      },
      { taskId: "sess_new", title: "最新任务", updatedAt: 5_000 },
    ],
  });
  assert.equal(harness.summary.available, true);
  assert.equal(harness.taskListCalls, 1);
  assert.deepEqual(
    harness.summary.sessions.map((item) => item.sessionId),
    ["sess_new", "sess_old"],
    "磁盘结果必须按 lastActivityAt 倒序",
  );
  assert.equal(harness.summary.sessions[1].sessionEnded, true, "终态 status 视为会话已结束");
  assert.equal(harness.summary.sessions[0].sessionEnded, false, "running/缺省不得当作已结束");
  assert.equal(harness.summary.sessions[1].pendingCount, 1, "存在待处理交互计入 pendingCount");
  assert.equal(harness.summary.sessions[0].pendingCount, 0);
  assert.equal(harness.summary.sessions[0].lastActivityAt, 5_000, "updatedAt 映射为 lastActivityAt");
});

test("两条读面都不可用时返回 available:false（不抛错、不挂起）", async () => {
  const harness = await run({
    agentHandlers: {
      helloConversationV4: () => {
        throw new Error("ZCode Agent runtime is not running.");
      },
    },
    omitTaskChannel: true,
  });
  assert.equal(harness.summary.available, false);
  assert.deepEqual(harness.summary.sessions, []);
});

test("磁盘读面超量时截断到 20 条且标题截断到 200 字", async () => {
  const tasks = Array.from({ length: 25 }, (_, index) => ({
    taskId: `sess_${index}`,
    title: "x".repeat(300),
    updatedAt: index,
  }));
  const harness = await run({ tasks });
  assert.equal(harness.summary.available, true);
  assert.equal(harness.summary.sessions.length, 20);
  assert.equal(harness.summary.sessions[0].title.length, 200);
  assert.equal(harness.summary.sessions[0].sessionId, "sess_24");
});

test("磁盘读面报错时按不可用处理，不冒泡给控制面", async () => {
  const calls: string[] = [];
  const summary = await readWorkspaceTaskSummary({
    workspacePath: "C:\\ws",
    workspaceIdentity: "C:\\ws",
    createUpstream: async () => ({
      channelClient: {
        getChannel: (name: string) => {
          if (name === IZCodeAgentService.channelName) {
            return fakeChannel({
              helloConversationV4: () => ({}),
              initializeConversationV4: () => undefined,
              subscribeSessionsIndexV4: () => {
                throw new Error("ZCode Agent runtime is not running.");
              },
            });
          }
          return fakeChannel({
            listTasks: () => {
              calls.push("listTasks");
              throw new Error("tasks-index 读取失败");
            },
          });
        },
      },
      dispose: () => undefined,
    }),
  });
  assert.equal(summary.available, false);
  assert.deepEqual(summary.sessions, []);
  assert.deepEqual(calls, ["listTasks"], "磁盘读面必须被尝试过（证明不是未调用即通过）");
});
