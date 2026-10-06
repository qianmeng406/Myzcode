// 窄化 facade 单测：方法白名单、v4 命令 payload 类型门禁、workspace 绑定注入。
// 这是手机攻击面的核心闸门：任何未列入白名单的方法与命令类型必须被拒绝。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNarrowingAgentFacade } from "../src/companion/narrowingFacade.js";
import type { IChannel } from "@zcode/rpc";

function createRecordingUpstream() {
  const calls: Array<{ command: string; arg: unknown }> = [];
  const upstream: IChannel = {
    async call<T>(command: string, arg?: unknown): Promise<T> {
      calls.push({ command, arg });
      return { echoed: command } as T;
    },
    listen() {
      return { dispose: () => undefined } as never;
    },
  };
  return { upstream, calls };
}

const SCOPE = { workspacePath: "/srv/demo", workspaceIdentity: "/srv/demo" };

test("白名单方法放行并注入绑定 workspace；未列方法拒绝", async () => {
  const { upstream, calls } = createRecordingUpstream();
  const facade = createNarrowingAgentFacade({ upstream, scope: SCOPE });

  const result = await facade.call("ctx", "conversationPlansV4", [{}]);
  assert.deepEqual(result, { echoed: "conversationPlansV4" });
  assert.equal(calls.length, 1);
  const injected = (calls[0]!.arg as Array<Record<string, unknown>>)[0]!;
  assert.equal(injected.workspacePath, "/srv/demo");
  assert.equal(injected.workspaceIdentity, "/srv/demo");

  await assert.rejects(
    () => facade.call("ctx", "credentialLoad" as string, []),
    (error: unknown) => error instanceof Error && error.message.includes("not allowed"),
  );
  await assert.rejects(
    () => facade.call("ctx", "setConnectionFlowStateV4", []),
    (error: unknown) => error instanceof Error && error.message.includes("not allowed"),
  );
});

test("sendConversationCommandV4 只放行四种命令类型", async () => {
  const { upstream, calls } = createRecordingUpstream();
  const facade = createNarrowingAgentFacade({ upstream, scope: SCOPE });

  await facade.call("ctx", "sendConversationCommandV4", [
    { command: { type: "sendText", payload: { text: "hi" } } },
  ]);
  assert.equal(calls.length, 1);

  await assert.rejects(
    () =>
      facade.call("ctx", "sendConversationCommandV4", [
        { command: { type: "applyFileRewind", payload: { target: { rowId: 1, entityId: "e" } } } },
      ]),
    (error: unknown) => error instanceof Error && error.message.includes("not allowed"),
  );
  await assert.rejects(
    () => facade.call("ctx", "sendConversationCommandV4", [{ command: {} }]),
    (error: unknown) => error instanceof Error && error.message.includes("not allowed"),
  );
});

test("setModel/setMode/setThoughtLevel 放行（会话级设置面）", async () => {
  const { upstream, calls } = createRecordingUpstream();
  const facade = createNarrowingAgentFacade({ upstream, scope: SCOPE });

  for (const method of ["setModel", "setMode", "setThoughtLevel"] as const) {
    await facade.call("ctx", method, [{ mode: "plan" }]);
  }
  assert.equal(calls.length, 3);
  for (const call of calls) {
    const first = (call.arg as Array<Record<string, unknown>>)[0]!;
    assert.equal(first.workspaceIdentity, "/srv/demo");
  }
});

test("非数组参数透传（无参调用不注入）", async () => {
  const { upstream, calls } = createRecordingUpstream();
  const facade = createNarrowingAgentFacade({ upstream, scope: SCOPE });
  await facade.call("ctx", "helloConversationV4");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.arg, undefined);
});
