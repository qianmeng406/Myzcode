// 频道裁决回归（specs §11）：T1 白名单内放行/外拒绝、T0 全拒、未登记频道默认拒绝。
// 攻击面闸门：宿主写方法永不下发手机。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IChannel } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createPolicyChannel, policyForChannel } from "../src/companion/channelPolicy.js";

function createRecordingUpstream() {
  const calls: Array<{ command: string; arg: unknown }> = [];
  const listens: Array<{ event: string; arg: unknown }> = [];
  const upstream: IChannel = {
    async call<T>(command: string, arg?: unknown): Promise<T> {
      calls.push({ command, arg });
      return { echoed: command } as T;
    },
    listen(event: string) {
      listens.push({ event, arg: undefined });
      return { dispose: () => undefined } as never;
    },
  };
  return { upstream, calls, listens };
}

test("T1 file：白名单内放行，写方法拒绝", async () => {
  const { upstream, calls } = createRecordingUpstream();
  const channel = createPolicyChannel({
    channelName: "file",
    upstream,
    policy: policyForChannel("file"),
  });

  const result = await channel.call("ctx", "readdir", { path: "/srv" });
  assert.deepEqual(result, { echoed: "readdir" });
  assert.equal(calls.length, 1);

  await assert.rejects(
    () => channel.call("ctx", "writeWorkspaceFileSearchIgnore", []),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("method not allowed: file.writeWorkspaceFileSearchIgnore"),
  );
  await assert.rejects(
    () => channel.call("ctx", "createScratchWorkspace", []),
    (error: unknown) => error instanceof Error && error.message.includes("not allowed"),
  );
  assert.equal(calls.length, 1);
});

test("T1 git：读放行，commit/push/discard 拒绝", async () => {
  const { upstream, calls } = createRecordingUpstream();
  const channel = createPolicyChannel({
    channelName: "git",
    upstream,
    policy: policyForChannel("git"),
  });

  await channel.call("ctx", "getChanges", {});
  await assert.rejects(() => channel.call("ctx", "commit", []), /not allowed: git\.commit/);
  await assert.rejects(() => channel.call("ctx", "push", []), /not allowed: git\.push/);
  await assert.rejects(
    () => channel.call("ctx", "discardPaths", []),
    /not allowed: git\.discardPaths/,
  );
  assert.equal(calls.length, 1);
});

test("T1 setting/system：只读白名单", async () => {
  const { upstream } = createRecordingUpstream();
  const setting = createPolicyChannel({
    channelName: "setting",
    upstream,
    policy: policyForChannel("setting"),
  });
  const system = createPolicyChannel({
    channelName: "system",
    upstream,
    policy: policyForChannel("system"),
  });

  await setting.call("ctx", "get", undefined);
  await assert.rejects(() => setting.call("ctx", "update", []), /not allowed: setting\.update/);
  await assert.rejects(
    () => setting.call("ctx", "updateDataBaseDir", []),
    /not allowed: setting\.updateDataBaseDir/,
  );

  await system.call("ctx", "info", undefined);
  await assert.rejects(
    () => system.call("ctx", "probeIntranet", []),
    /not allowed: system\.probeIntranet/,
  );
});

test("T0 全拒：call 快速失败、listen 永不触发", async () => {
  const { upstream, calls } = createRecordingUpstream();
  const channel = createPolicyChannel({
    channelName: ServiceChannels.Terminal,
    upstream,
    policy: policyForChannel(ServiceChannels.Terminal),
  });

  await assert.rejects(
    () => channel.call("ctx", "create", []),
    (error: unknown) =>
      error instanceof Error && error.message.includes("channel not allowed: terminal"),
  );
  let fired = false;
  const disposable = channel.listen("ctx", "onDynamicData", undefined) as never as {
    (listener: () => void): { dispose(): void };
  };
  disposable(() => {
    fired = true;
  }).dispose();
  assert.equal(fired, false);
  assert.equal(calls.length, 0);
});

test("未登记频道默认 T0；裁决表覆盖既定频道", () => {
  assert.equal(policyForChannel("credential").kind, "deny");
  assert.equal(policyForChannel("window-controller").kind, "deny");
  assert.equal(policyForChannel("skills").kind, "deny");
  assert.equal(policyForChannel("nonexistent-channel").kind, "deny");
  assert.equal(policyForChannel("zcode-task").kind, "passthrough");
  assert.equal(policyForChannel("model-selection").kind, "passthrough");
  assert.equal(policyForChannel("file").kind, "allow-calls");
  assert.equal(policyForChannel("git-checkpoint").kind, "allow-calls");
});

test("T2/T1 事件监听放行（只读事实）", () => {
  const { upstream, listens } = createRecordingUpstream();
  const channel = createPolicyChannel({
    channelName: "file",
    upstream,
    policy: policyForChannel("file"),
  });
  channel.listen("ctx", "onDidChange", undefined);
  assert.equal(listens.length, 1);
});
