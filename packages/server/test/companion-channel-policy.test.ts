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
    scope: { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" },
  });

  const result = await channel.call("ctx", "readdir", { path: "/srv/ws/sub" });
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
    scope: { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" },
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
    scope: { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" },
  });
  const system = createPolicyChannel({
    channelName: "system",
    upstream,
    policy: policyForChannel("system"),
    scope: { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" },
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
    scope: { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" },
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
  assert.equal(policyForChannel("zcode-task").kind, "task-scoped");
  assert.equal(policyForChannel("bots").kind, "allow-calls");
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
    scope: { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" },
  });
  channel.listen("ctx", "onDidChange", undefined);
  assert.equal(listens.length, 1);
});


test("workspace 绑定：path 越界拒绝、workspacePath 强制覆写、paths 数组校验", async () => {
  const { upstream, calls } = createRecordingUpstream();
  const scope = { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" };
  const channel = createPolicyChannel({
    channelName: "file",
    upstream,
    policy: policyForChannel("file"),
    scope,
  });

  // 越界 path 拒绝
  await assert.rejects(
    () => channel.call("ctx", "readdir", { path: "C:/Users/other" }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("path escapes workspace"),
  );
  // 反斜杠归一后仍越界：UNC 风格的 `\\srv\ws-evildir` 经 normalizePath 统一为
  // `/srv/ws-evildir`，与工作区 `/srv/ws` 同级（前缀边界），必须拒绝。
  // 用 String.raw 表达字面反斜杠，避免 `\s`/`\w` 这类无效转义触发 lint。
  await assert.rejects(
    () => channel.call("ctx", "readdir", { path: String.raw`\\srv\ws-evildir` }),
    (error: unknown) => error instanceof Error && error.message.includes("escapes workspace"),
  );
  // paths 数组包含越界项 → 整体拒绝
  await assert.rejects(
    () => channel.call("ctx", "checkFilesExist", { paths: ["/srv/ws/a.txt", "/srv/other.txt"] }),
    (error: unknown) => error instanceof Error && error.message.includes("escapes workspace"),
  );

  // 界内调用：workspacePath 被覆写为绑定值（客户端声明一律覆盖）
  await channel.call("ctx", "searchWorkspaceFiles", {
    workspacePath: "/somewhere/else",
    workspaceIdentity: "fake",
    query: "x",
  });
  assert.equal(calls.length, 1);
  const forwarded = calls[0]!.arg as Record<string, unknown>;
  assert.equal(forwarded.workspacePath, "/srv/ws");
  assert.equal(forwarded.workspaceIdentity, "/srv/ws");
});

test("broadcast 调用侧拒绝（仅监听），事件放行", async () => {
  const { upstream } = createRecordingUpstream();
  const channel = createPolicyChannel({
    channelName: "broadcast",
    upstream,
    policy: policyForChannel("broadcast"),
    scope: { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" },
  });
  await assert.rejects(
    () => channel.call("ctx", "publish", []),
    (error: unknown) =>
      error instanceof Error && error.message.includes("not allowed: broadcast.publish"),
  );
  channel.listen("ctx", "onMessage", undefined);
});

// ── 审查修复回归：`..` 消解 / 嵌套 scopes / taskId 归属 / 秘钥脱敏 ──

test("路径围栏：`..` 段必须消解后比对（防词法前缀绕过）", async () => {
  const { upstream, calls } = createRecordingUpstream();
  const scope = { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" };
  const channel = createPolicyChannel({
    channelName: "file",
    upstream,
    policy: policyForChannel("file"),
    scope,
  });

  // 词法上以 root 前缀开头、实际越界 → 必须拒绝
  await assert.rejects(
    () => channel.call("ctx", "readTextFile", { path: "/srv/ws/../../etc/passwd" }),
    (error: unknown) => error instanceof Error && error.message.includes("escapes workspace"),
  );
  await assert.rejects(
    () => channel.call("ctx", "readTextFile", { path: "/srv/ws/sub/../../../etc/shadow" }),
    (error: unknown) => error instanceof Error && error.message.includes("escapes workspace"),
  );
  // Windows 盘符相对与反斜杠混合的 `..` 同样拦截
  await assert.rejects(
    () => channel.call("ctx", "readTextFile", { path: "C:\\srv\\ws\\..\\..\\Users\\x\\id_rsa" }),
    (error: unknown) => error instanceof Error && error.message.includes("escapes workspace"),
  );
  // 界内 `..`（消解后仍在工作区内）放行
  await channel.call("ctx", "readdir", { path: "/srv/ws/sub/../pkg" });
  assert.equal(calls.length, 1);
  assert.equal((calls[0]!.arg as Record<string, unknown>).path, "/srv/ws/sub/../pkg");
});

test("zcode-task：嵌套 workspaceScopes 逐项覆写为绑定工作区", async () => {
  const { upstream, calls } = createRecordingUpstream();
  const scope = { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" };
  const channel = createPolicyChannel({
    channelName: "zcode-task",
    upstream,
    policy: { kind: "task-scoped" },
    scope,
  });
  await channel.call("ctx", "listTaskList", {
    workspaceScopes: [
      { workspacePath: "/etc", workspaceIdentity: "/etc" },
      { workspacePath: "/home/other", workspaceIdentity: "/home/other" },
    ],
  });
  const forwarded = calls[0]!.arg as { workspaceScopes: Array<{ workspacePath: string }> };
  assert.equal(forwarded.workspaceScopes.length, 2);
  for (const entry of forwarded.workspaceScopes) {
    assert.equal(entry.workspacePath, "/srv/ws");
  }
});

test("zcode-task：taskId 必须先经列表学习（跨工作区注入拒绝）", async () => {
  const calls: Array<{ command: string; arg: unknown }> = [];
  let listReturned = false;
  const upstream: IChannel = {
    async call<T>(command: string, arg?: unknown): Promise<T> {
      calls.push({ command, arg });
      if (command === "listTaskList") {
        listReturned = true;
        return {
          items: [
            { taskId: "task-in-ws", workspacePath: "/srv/ws", title: "hello" },
          ],
        } as T;
      }
      return {} as T;
    },
    listen() {
      return { dispose: () => undefined } as never;
    },
  };
  const scope = { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" };
  const channel = createPolicyChannel({
    channelName: "zcode-task",
    upstream,
    policy: { kind: "task-scoped" },
    scope,
  });

  // 未学习直接按 taskId 操作 → 拒绝
  await assert.rejects(
    () => channel.call("ctx", "sendPrompt", { taskId: "task-foreign", prompt: "hi" }),
    (error: unknown) => error instanceof Error && error.message.includes("task not in attached workspace"),
  );
  // 列表（被强制绑定到挂载工作区）学习到 task → 放行
  await channel.call("ctx", "listTaskList", { workspaceScopes: [] });
  assert.ok(listReturned);
  await channel.call("ctx", "sendPrompt", { taskId: "task-in-ws", prompt: "hi" });
  assert.equal(calls[calls.length - 1]!.command, "sendPrompt");
});

test("zcode-task：数组参数形态（真实 ProxyChannel 传输形）同样过 taskId 门禁", async () => {
  // ProxyChannel.toService 把方法调用序列化为 channel.call(command, [param1, ...])；
  // 门禁若只读 arg.taskId 会整体跳过——这里按真实传输形态回归。
  const upstream: IChannel = {
    async call<T>(command: string): Promise<T> {
      if (command === "listTaskList") {
        return {
          items: [
            { taskId: "task-in-ws", workspacePath: "/srv/ws", title: "hello" },
          ],
        } as T;
      }
      return {} as T;
    },
    listen() {
      return { dispose: () => undefined } as never;
    },
  };
  const scope = { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" };
  const channel = createPolicyChannel({
    channelName: "zcode-task",
    upstream,
    policy: { kind: "task-scoped" },
    scope,
  });

  // 数组包裹的陌生 taskId → 拒绝（修复前直接放行）
  await assert.rejects(
    () => channel.call("ctx", "sendPrompt", [{ taskId: "task-foreign", content: "hi" }]),
    (error: unknown) => error instanceof Error && error.message.includes("task not in attached workspace"),
  );
  // 学习后数组形态放行，且 workspace 绑定注入到数组首元素
  await channel.call("ctx", "listTaskList", [{ workspaceScopes: [] }]);
  await channel.call("ctx", "sendPrompt", [{ taskId: "task-in-ws", content: "hi" }]);
  // 多元素数组：任一元素携带陌生 taskId 都拒绝
  await assert.rejects(
    () => channel.call("ctx", "sendPrompt", [{ taskId: "task-in-ws" }, { taskId: "task-foreign" }]),
    (error: unknown) => error instanceof Error && error.message.includes("task not in attached workspace"),
  );
});

test("provider-settings：响应中的明文 apiKey 脱敏后下发", async () => {
  const upstream: IChannel = {
    async call<T>(): Promise<T> {
      return {
        personalConfig: { access: { apiKey: "sk-live-secret", baseUrl: "https://api" } },
        effectiveConfig: { apiKey: "sk-live-2" },
      } as T;
    },
    listen() {
      return { dispose: () => undefined } as never;
    },
  };
  const channel = createPolicyChannel({
    channelName: "provider-settings",
    upstream,
    policy: policyForChannel("provider-settings"),
    scope: { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" },
  });
  const view = await channel.call<Record<string, { access?: { apiKey?: string }; apiKey?: string }>>(
    "ctx",
    "getView",
  );
  assert.equal(view.personalConfig?.access?.apiKey, "••••••••");
  assert.equal(view.effectiveConfig?.apiKey, "••••••••");
  assert.equal(view.personalConfig?.access?.baseUrl, "https://api");
});
