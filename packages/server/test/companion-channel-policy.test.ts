// 频道裁决回归（specs §11）：T1 白名单内放行/外拒绝、T0 全拒、未登记频道默认拒绝。
// 攻击面闸门：宿主写方法永不下发手机。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IChannel } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createPolicyChannel, filterControllerFrameToShared, policyForChannel } from "../src/companion/channelPolicy.js";

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
  assert.equal(policyForChannel("skills").kind, "deny");
  assert.equal(policyForChannel("nonexistent-channel").kind, "deny");
  // window-controller 只读面（列表 + 订阅 + 帧，写面与其它事件拒绝）。
  assert.equal(policyForChannel("window-controller").kind, "controller-readonly");
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

test("zcode-task：共享集合已知时 workspaceScopes 逐项收窄（不坍缩、不放宽）", async () => {
  const { upstream, calls } = createRecordingUpstream();
  const scope = {
    workspacePath: "/srv/ws",
    workspaceIdentity: "/srv/ws",
    sharedWorkspaces: [
      { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" },
      { workspacePath: "/srv/other", workspaceIdentity: "/srv/other" },
    ],
  };
  const channel = createPolicyChannel({
    channelName: "zcode-task",
    upstream,
    policy: { kind: "task-scoped" },
    scope,
  });
  await channel.call("ctx", "listTaskList", {
    workspaceScopes: [
      { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" },
      { workspacePath: "/srv/other", workspaceIdentity: "/srv/other" },
      // 未共享：必须整项丢弃（否则手机能凭任意路径读未共享工作区的任务元数据）
      { workspacePath: "/etc", workspaceIdentity: "/etc" },
    ],
  });
  const forwarded = calls[0]!.arg as { workspaceScopes: Array<{ workspacePath: string }> };
  assert.deepEqual(
    forwarded.workspaceScopes.map((entry) => entry.workspacePath),
    ["/srv/ws", "/srv/other"],
    "共享工作区必须保留原样（跨工作区只读列举），未共享项丢弃",
  );
});

test("zcode-task：只读列表方法可指向共享集合内其它工作区；写方法与未共享目标仍绑回", async () => {
  const { upstream, calls } = createRecordingUpstream();
  const scope = {
    workspacePath: "/srv/ws",
    workspaceIdentity: "/srv/ws",
    sharedWorkspaces: [
      { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" },
      { workspacePath: "/srv/other", workspaceIdentity: "/srv/other" },
    ],
  };
  const channel = createPolicyChannel({
    channelName: "zcode-task",
    upstream,
    policy: { kind: "task-scoped" },
    scope,
  });

  // 只读成员查询：共享工作区保持原目标（否则手机侧其它共享工作区永远空列表）
  await channel.call("ctx", "listTasks", {
    workspacePath: "/srv/other",
    workspaceIdentity: "/srv/other",
  });
  const readArg = calls[0]!.arg as { workspacePath: string };
  assert.equal(readArg.workspacePath, "/srv/other", "共享工作区的只读列表目标必须保留");

  // 未共享目标：改写成绑定工作区（fail-closed，不放宽读取范围）
  await channel.call("ctx", "listTasks", { workspacePath: "/etc", workspaceIdentity: "/etc" });
  assert.equal((calls[1]!.arg as { workspacePath: string }).workspacePath, "/srv/ws");

  // 写方法即使是共享工作区也必须绑回绑定工作区（只读索引不等于跨工作区写入）
  await channel.call("ctx", "createTask", {
    workspacePath: "/srv/other",
    workspaceIdentity: "/srv/other",
  });
  assert.equal(
    (calls[2]!.arg as { workspacePath: string }).workspacePath,
    "/srv/ws",
    "跨工作区创建任务必须被绑回 attachment 工作区",
  );
});

test("window-controller：只读列表/订阅放行；写方法与其它事件仍 T0", async () => {
  const { upstream, calls } = createRecordingUpstream();
  const scope = {
    workspacePath: "/srv/ws",
    workspaceIdentity: "/srv/ws",
    sharedWorkspaces: [
      { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" },
      { workspacePath: "/srv/other", workspaceIdentity: "/srv/other" },
    ],
  };
  const channel = createPolicyChannel({
    channelName: "window-controller",
    upstream,
    policy: policyForChannel("window-controller"),
    scope,
  });

  await channel.call("ctx", "listTaskList", {
    workspaceScopes: [
      { workspacePath: "/srv/other", workspaceIdentity: "/srv/other" },
      { workspacePath: "/etc", workspaceIdentity: "/etc" },
    ],
  });
  const forwarded = calls[0]!.arg as { workspaceScopes: Array<{ workspacePath: string }> };
  assert.deepEqual(
    forwarded.workspaceScopes.map((entry) => entry.workspacePath),
    ["/srv/other"],
  );

  // 订阅参数是 strict schema：必须原样透传（注入 workspace 键会让订阅解析失败）。
  const subscribeParams = { topic: "controller/tasks-index", visibility: "foreground" };
  await channel.call("ctx", "subscribeControllerV4", subscribeParams);
  assert.deepEqual(calls[1]!.arg, subscribeParams, "订阅参数不得被注入/改写");
  await channel.call("ctx", "resyncControllerV4", {
    subscriptionId: "sub-1",
    base: { logEpoch: "e", seq: 3 },
    forceSnapshot: true,
  });
  await channel.call("ctx", "unsubscribeControllerV4", { subscriptionId: "sub-1" });

  // 写面永不下发手机。
  await assert.rejects(
    () => channel.call("ctx", "mutateTask", { address: { workspacePath: "/srv/ws", taskId: "t1" } }),
    (error: unknown) => error instanceof Error && error.message.includes("not allowed"),
  );
  await assert.rejects(
    () => channel.call("ctx", "deleteArchivedTasks", { taskIds: ["t1"] }),
    (error: unknown) => error instanceof Error && error.message.includes("not allowed"),
  );
  assert.equal(calls.length, 4, "仅四个只读方法到达上游");
  // 其它事件面关闭。
  const listener = channel.listen("ctx", "onSomethingElse", undefined) as unknown as {
    (fn: (value: unknown) => void): { dispose(): void };
  };
  let fired = false;
  listener(() => {
    fired = true;
  }).dispose();
  assert.equal(fired, false);
});

test("window-controller：没有共享集合时拒绝订阅（宁可不订阅也不下发全量投影）", async () => {
  const { upstream, calls } = createRecordingUpstream();
  const channel = createPolicyChannel({
    channelName: "window-controller",
    upstream,
    policy: policyForChannel("window-controller"),
    scope: { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" },
  });
  await assert.rejects(
    () => channel.call("ctx", "subscribeControllerV4", { topic: "controller/tasks-index" }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("controller frames require a shared workspace set"),
  );
  assert.equal(calls.length, 0);
});

test("controller 帧过滤：未共享工作区的任务/事实不下发，seq 封套保持连续", async () => {
  const scope = {
    workspacePath: "/srv/ws",
    workspaceIdentity: "/srv/ws",
    sharedWorkspaces: [
      { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" },
      { workspacePath: "/srv/other", workspaceIdentity: "/srv/other" },
    ],
  };
  const rejects: string[] = [];
  const logReject = (message: string): void => rejects.push(message);

  // 快照：共享工作区的行保留，未共享的被滤掉；封套字段原样。
  const snapshotFrame = {
    topic: "controller/tasks-index",
    subscriptionId: "sub-1",
    logEpoch: "epoch-1",
    fromSeq: 0,
    toSeq: 5,
    sentAt: 123,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        logEpoch: "epoch-1",
        tasks: [
          { address: { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws", taskId: "t1" } },
          { address: { workspacePath: "/srv/other", workspaceIdentity: "/srv/other", taskId: "t2" } },
          { address: { workspacePath: "/etc", workspaceIdentity: "/etc", taskId: "t3" } },
        ],
      },
    },
  };
  const filteredSnapshot = filterControllerFrameToShared(snapshotFrame, scope, logReject);
  assert.ok(filteredSnapshot);
  assert.equal(filteredSnapshot.payload.snapshot.tasks.length, 2);
  assert.deepEqual(
    filteredSnapshot.payload.snapshot.tasks.map((row: { address: { taskId: string } }) => row.address.taskId),
    ["t1", "t2"],
  );
  assert.equal(filteredSnapshot.toSeq, 5, "seq 封套不得因过滤改变");
  assert.equal(filteredSnapshot.logEpoch, "epoch-1");

  // 增量：task.upserted/task.removed 按 address 过滤；全被滤掉仍转发空增量（保 seq 连续）。
  const deltaFrame = {
    topic: "controller/tasks-index",
    subscriptionId: "sub-1",
    logEpoch: "epoch-1",
    fromSeq: 5,
    toSeq: 8,
    sentAt: 456,
    payload: {
      kind: "deltas",
      deltas: [
        { op: "task.upserted", task: { address: { workspacePath: "/etc", taskId: "t3" } } },
        { op: "task.removed", address: { workspacePath: "/srv/ws", taskId: "t1" } },
      ],
    },
  };
  const filteredDeltas = filterControllerFrameToShared(deltaFrame, scope, logReject);
  assert.ok(filteredDeltas);
  assert.equal(filteredDeltas.payload.deltas.length, 1);
  assert.equal(filteredDeltas.payload.deltas[0].op, "task.removed");
  assert.equal(filteredDeltas.toSeq, 8);

  const allForeignFrame = {
    topic: "controller/tasks-index",
    subscriptionId: "sub-1",
    logEpoch: "epoch-1",
    fromSeq: 8,
    toSeq: 9,
    sentAt: 789,
    payload: { kind: "deltas", deltas: [{ op: "task.upserted", task: { address: { workspacePath: "/etc", taskId: "t9" } } }] },
  };
  const filteredAllForeign = filterControllerFrameToShared(allForeignFrame, scope, logReject);
  assert.ok(filteredAllForeign, "空增量帧仍要转发（客户端按 no-op 处理，seq 不断链）");
  assert.deepEqual(filteredAllForeign.payload.deltas, []);

  // workspace facts 快照/增量同样收窄。
  const workspaceFrame = {
    topic: "controller/workspaces",
    subscriptionId: "sub-2",
    logEpoch: "epoch-1",
    fromSeq: 0,
    toSeq: 2,
    sentAt: 1,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        logEpoch: "epoch-1",
        workspaces: [
          { workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws", sourceAvailability: "online", connectionState: "online" },
          { workspacePath: "/home/x", workspaceIdentity: "/home/x", sourceAvailability: "online", connectionState: "online" },
        ],
      },
    },
  };
  const filteredWorkspaces = filterControllerFrameToShared(workspaceFrame, scope, logReject);
  assert.ok(filteredWorkspaces);
  assert.equal(filteredWorkspaces.payload.snapshot.workspaces.length, 1);

  // 未识别形状整体丢弃并留痕。
  assert.equal(filterControllerFrameToShared({ topic: "controller/unknown", payload: { kind: "x" } }, scope, logReject), null);
  assert.equal(filterControllerFrameToShared({ nonsense: true }, scope, logReject), null);
  assert.equal(filterControllerFrameToShared({ topic: "controller/tasks-index", payload: { kind: "snapshot", snapshot: {} } }, scope, logReject), null);
  assert.ok(rejects.length >= 3, "丢弃必须留痕");
});

test("controller 帧事件：订阅方只收到过滤后的帧", async () => {
  const scope = {
    workspacePath: "/srv/ws",
    workspaceIdentity: "/srv/ws",
    sharedWorkspaces: [{ workspacePath: "/srv/ws", workspaceIdentity: "/srv/ws" }],
  };
  const received: unknown[] = [];
  let pushFrame: ((frame: unknown) => void) | null = null;
  const upstream: IChannel = {
    async call<T>(): Promise<T> {
      return {} as T;
    },
    listen(_event: string) {
      return ((listener: (frame: unknown) => void) => {
        pushFrame = listener;
        return { dispose: () => undefined };
      }) as never;
    },
  };
  const channel = createPolicyChannel({
    channelName: "window-controller",
    upstream,
    policy: policyForChannel("window-controller"),
    scope,
  });
  const disposable = channel.listen("ctx", "onDynamicControllerFrame", undefined) as unknown as {
    (fn: (value: unknown) => void): { dispose(): void };
  };
  disposable((frame: unknown) => received.push(frame));
  assert.ok(pushFrame, "上游事件必须被订阅");

  pushFrame?.({
    topic: "controller/tasks-index",
    subscriptionId: "s",
    logEpoch: "e",
    fromSeq: 0,
    toSeq: 1,
    sentAt: 1,
    payload: { kind: "deltas", deltas: [{ op: "task.removed", address: { workspacePath: "/elsewhere", taskId: "t" } }] },
  });
  pushFrame?.({
    topic: "controller/tasks-index",
    subscriptionId: "s",
    logEpoch: "e",
    fromSeq: 1,
    toSeq: 2,
    sentAt: 2,
    payload: { kind: "deltas", deltas: [{ op: "task.removed", address: { workspacePath: "/srv/ws", taskId: "t1" } }] },
  });
  pushFrame?.({ garbage: true });
  assert.equal(received.length, 2, "被完全过滤的帧与垃圾帧都不得下发");
  const first = received[0] as { payload: { deltas: unknown[] }; toSeq: number };
  assert.deepEqual(first.payload.deltas, [], "全外部增量仍以空增量下发（保 seq）");
  assert.equal((received[1] as { payload: { deltas: unknown[] } }).payload.deltas.length, 1);
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
