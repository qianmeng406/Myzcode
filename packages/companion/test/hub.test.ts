import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompanionWorkspaceEntry } from "@zcode/shared/companion-protocol";
import { CompanionHub } from "../src/app/hub.js";
import type {
  ControlStore,
  HubLogger,
  MobileLink,
  NodeLink,
  RelayJoin,
} from "../src/app/ports.js";
import { COMPANION_GATEWAY_DEFAULTS } from "../src/app/ports.js";
import { MemoryControlStore } from "./memoryControlStore.js";

const noopLogger: HubLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const WORKSPACE: CompanionWorkspaceEntry = {
  nodeId: "cloud-1",
  workspacePath: "/srv/demo",
  workspaceIdentity: "/srv/demo",
  title: "Demo",
  available: true,
};

function makeClock() {
  return { now: () => 1_000_000 };
}

function makeSecrets() {
  let counter = 0;
  return {
    randomToken: (byteLength: number) => `tok-${++counter}-${byteLength}`,
    randomInt: (maxExclusive: number) => counter % maxExclusive,
    sha256Hex: (value: string) => `h(${value})`,
  };
}

/** 假节点链路：记录收到的 hub 请求，允许测试注入响应与断开。 */
class FakeNodeLink implements NodeLink {
  requests: Array<{ op: string; params: unknown }> = [];
  closed = false;
  private responder: (op: string, params: unknown) => { ok: true; result?: unknown } | { ok: false; code: string; message: string } = () => ({
    ok: true,
  });

  request(
    op: string,
    params: unknown,
    _timeoutMs: number,
  ): Promise<{ ok: true; result?: unknown } | { ok: false; code: string; message: string }> {
    this.requests.push({ op, params });
    return Promise.resolve(this.responder(op, params));
  }

  close(): void {
    this.closed = true;
  }

  onAttach(responder: (op: string, params: unknown) => { ok: true; result?: unknown } | { ok: false; code: string; message: string }): void {
    this.responder = responder;
  }
}

/** 假手机链路：记录响应与事件。 */
class FakeMobileLink implements MobileLink {
  deviceId: string;
  responses = new Map<string, { ok: boolean; value: unknown }>();
  events: Array<{ event: string; payload?: unknown }> = [];
  closed = false;

  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  respond(id: string, result: { ok: true; result?: unknown } | { ok: false; code: string; message: string }): void {
    this.responses.set(id, { ok: result.ok, value: result });
  }

  sendEvent(event: { v: number; event: string; payload?: unknown }): void {
    this.events.push(event);
  }

  close(): void {
    this.closed = true;
  }

  waitForResponse(id: string): Promise<{ ok: boolean; value: unknown }> {
    const existing = this.responses.get(id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const entry = this.responses.get(id);
        if (entry) {
          clearInterval(timer);
          resolve(entry);
        }
      }, 5);
    });
  }
}

/** 假 relay join：双向内存管道，测试断言透传与关闭。 */
class FakeRelayJoin implements RelayJoin {
  attachmentId: string;
  capability: string;
  received: Uint8Array[] = [];
  closedCode: number | null = null;
  private binaryListeners = new Set<(data: Uint8Array) => void>();
  private closedListeners = new Set<() => void>();

  constructor(attachmentId: string, capability: string) {
    this.attachmentId = attachmentId;
    this.capability = capability;
  }

  onBinary(listener: (data: Uint8Array) => void): void {
    this.binaryListeners.add(listener);
  }

  onClosed(listener: () => void): void {
    this.closedListeners.add(listener);
  }

  sendBinary(data: Uint8Array): void {
    this.received.push(data);
  }

  close(code: number, _reason: string): void {
    if (this.closedCode !== null) return;
    this.closedCode = code;
    for (const listener of this.closedListeners) listener();
  }

  /** 从本端推入一帧（模拟网络方向进入 hub 透传管线）。 */
  pushIncoming(data: Uint8Array): void {
    for (const listener of this.binaryListeners) listener(data);
  }
}

async function makeHub(store?: ControlStore): Promise<{ hub: CompanionHub; store: MemoryControlStore }> {
  const controlStore = store ?? new MemoryControlStore();
  await controlStore.saveNode({
    nodeId: "cloud-1",
    kind: "cloud",
    displayName: "云端节点",
    tokenFingerprint: "f".repeat(64),
    createdAt: 1,
  });
  await controlStore.saveDevice({ deviceId: "dev-1", deviceName: "手机", createdAt: 2 });
  await controlStore.saveGrants({
    deviceId: "dev-1",
    nodes: [{ nodeId: "cloud-1", workspaceIdentities: [] }],
  });
  const hub = new CompanionHub({
    store: controlStore,
    clock: makeClock(),
    secrets: makeSecrets(),
    defaults: COMPANION_GATEWAY_DEFAULTS,
    logger: noopLogger,
  });
  return { hub, store: controlStore };
}

async function attachOnlineNode(hub: CompanionHub): Promise<FakeNodeLink> {
  const link = new FakeNodeLink();
  const hello = await hub.handleNodeHello(link, {
    nodeId: "cloud-1",
    displayName: "云端节点",
    kind: "cloud",
  });
  assert.deepEqual(hello, { ok: true });
  hub.handleNodeWorkspaces("cloud-1", [WORKSPACE]);
  return link;
}

async function attachAndJoin(hub: CompanionHub): Promise<{
  mobile: FakeMobileLink;
  mobileRelay: FakeRelayJoin;
  connectorRelay: FakeRelayJoin;
  attachResult: { attachmentId: string; relayCapability: string; connectorCapability: string };
}> {
  const mobile = new FakeMobileLink("dev-1");
  hub.handleMobileOpened(mobile);
  await hub.handleMobileRequest(mobile, "r1", "catalog", undefined);
  const catalogResponse = mobile.responses.get("r1");
  assert.ok(catalogResponse?.ok);

  const nodeLink = hub["nodeLinks"].get("cloud-1") as FakeNodeLink | undefined;
  assert.ok(nodeLink);
  const attachPromise = hub.handleMobileRequest(mobile, "r2", "attach", {
    nodeId: "cloud-1",
    workspacePath: "/srv/demo",
    workspaceIdentity: "/srv/demo",
  });
  await attachPromise;
  const attachResponse = (await mobile.waitForResponse("r2")) as {
    ok: boolean;
    value: { result?: { attachmentId: string; relayCapability: string } };
  };
  assert.ok(attachResponse.ok);
  const result = attachResponse.value.result!;
  const attachRequest = nodeLink.requests.find((entry) => entry.op === "attach");
  assert.ok(attachRequest);
  const connectorCapability = (attachRequest.params as { relayCapability: string }).relayCapability;
  assert.notEqual(connectorCapability, result.relayCapability);

  const mobileRelay = new FakeRelayJoin(result.attachmentId, result.relayCapability);
  const connectorRelay = new FakeRelayJoin(result.attachmentId, connectorCapability);
  assert.equal(hub.handleRelayJoin(mobileRelay, Date.now()), true);
  assert.equal(hub.handleRelayJoin(connectorRelay, Date.now()), true);
  return {
    mobile,
    mobileRelay,
    connectorRelay,
    attachResult: {
      attachmentId: result.attachmentId,
      relayCapability: result.relayCapability,
      connectorCapability,
    },
  };
}

test("节点 hello → catalog 可见工作区", async () => {
  const { hub } = await makeHub();
  await attachOnlineNode(hub);
  const mobile = new FakeMobileLink("dev-1");
  hub.handleMobileOpened(mobile);
  await hub.handleMobileRequest(mobile, "c1", "catalog", undefined);
  const response = (await mobile.waitForResponse("c1")) as {
    ok: boolean;
    value: { result?: { nodes: Array<{ online: boolean; workspaces: unknown[] }> } };
  };
  assert.ok(response.ok);
  assert.equal(response.value.result!.nodes.length, 1);
  assert.equal(response.value.result!.nodes[0]!.online, true);
  assert.equal(response.value.result!.nodes[0]!.workspaces.length, 1);
});

test("attach → 双侧 relay join → binary 帧双向透传", async () => {
  const { hub } = await makeHub();
  await attachOnlineNode(hub);
  const { mobileRelay, connectorRelay } = await attachAndJoin(hub);

  const payload = new Uint8Array([1, 2, 3, 9, 8, 7]);
  mobileRelay.pushIncoming(payload);
  assert.deepEqual(connectorRelay.received[0], payload);

  const reply = new Uint8Array([42, 0, 1]);
  connectorRelay.pushIncoming(reply);
  assert.deepEqual(mobileRelay.received[0], reply);
});

test("错误 capability 被拒绝", async () => {
  const { hub } = await makeHub();
  await attachOnlineNode(hub);
  const { attachResult } = await attachAndJoin(hub);
  const impostor = new FakeRelayJoin(attachResult.attachmentId, "wrong-capability");
  assert.equal(hub.handleRelayJoin(impostor, Date.now()), false);
  assert.equal(impostor.closedCode, null); // 未被 hub 关闭（适配器自行断开）
});

test("未授权工作区 attach 被拒", async () => {
  const { hub, store } = await makeHub();
  await attachOnlineNode(hub);
  await store.saveGrants({
    deviceId: "dev-1",
    nodes: [{ nodeId: "cloud-1", workspaceIdentities: ["/srv/other"] }],
  });
  const mobile = new FakeMobileLink("dev-1");
  hub.handleMobileOpened(mobile);
  await hub.handleMobileRequest(mobile, "a1", "attach", {
    nodeId: "cloud-1",
    workspacePath: "/srv/demo",
    workspaceIdentity: "/srv/demo",
  });
  const response = (await mobile.waitForResponse("a1")) as {
    ok: boolean;
    value: { code?: string };
  };
  assert.equal(response.ok, false);
  assert.equal(response.value.code, "forbidden_workspace");
});

test("节点离线 attach 返回 node_offline", async () => {
  const { hub } = await makeHub();
  const mobile = new FakeMobileLink("dev-1");
  hub.handleMobileOpened(mobile);
  await hub.handleMobileRequest(mobile, "a2", "attach", {
    nodeId: "cloud-1",
    workspacePath: "/srv/demo",
    workspaceIdentity: "/srv/demo",
  });
  const response = (await mobile.waitForResponse("a2")) as {
    ok: boolean;
    value: { code?: string };
  };
  assert.equal(response.ok, false);
  assert.equal(response.value.code, "node_offline");
});

test("节点断开 → attachment 关闭并通知手机", async () => {
  const { hub } = await makeHub();
  const nodeLink = await attachOnlineNode(hub);
  const { mobile, mobileRelay, connectorRelay } = await attachAndJoin(hub);

  hub.handleNodeClosed("cloud-1", nodeLink);
  // 状态广播按 grants 异步过滤后发送：等一拍再断言事件到达。
  await new Promise((resolve) => setTimeout(resolve, 20));
  // hub 不反向 close 节点链路（ws 已死亡由适配器清理），但 attachment 必须拆除。
  assert.notEqual(mobileRelay.closedCode, null);
  assert.notEqual(connectorRelay.closedCode, null);
  const closedEvent = mobile.events.find((event) => event.event === "attachmentClosed");
  assert.ok(closedEvent);
  const statusEvent = mobile.events.find((event) => event.event === "nodeStatus");
  assert.ok(statusEvent);
});

test("撤销设备 → 立即关闭连接与 attachment", async () => {
  const { hub } = await makeHub();
  await attachOnlineNode(hub);
  const { mobile, mobileRelay, connectorRelay } = await attachAndJoin(hub);
  hub.closeDeviceConnections("dev-1");
  assert.ok(mobile.closed);
  assert.notEqual(mobileRelay.closedCode, null);
  assert.notEqual(connectorRelay.closedCode, null);
});

test("同链路重复 attach 被拒；新链路 attach 接管旧 attachment", async () => {
  const { hub } = await makeHub();
  await attachOnlineNode(hub);
  const first = await attachAndJoin(hub);

  // 同一条链路重复 attach：仍是编程错误，拒绝。
  await hub.handleMobileRequest(first.mobile, "dup", "attach", {
    nodeId: "cloud-1",
    workspacePath: "/srv/demo",
    workspaceIdentity: "/srv/demo",
  });
  const dupResponse = (await first.mobile.waitForResponse("dup")) as { ok: boolean };
  assert.equal(dupResponse.ok, false);

  // 新控制链路（旧页面关闭后新页面/完整 UI 接管）：旧 attachment 拆除、新 attach 成功。
  const second = new FakeMobileLink("dev-1");
  hub.handleMobileOpened(second);
  await hub.handleMobileRequest(second, "takeover", "attach", {
    nodeId: "cloud-1",
    workspacePath: "/srv/demo",
    workspaceIdentity: "/srv/demo",
  });
  const takeoverResponse = (await second.waitForResponse("takeover")) as {
    ok: boolean;
    value: { result?: { attachmentId: string } };
  };
  assert.equal(takeoverResponse.ok, true);
  assert.notEqual(takeoverResponse.value.result!.attachmentId, first.attachResult.attachmentId);
  const closedEvent = first.mobile.events.find(
    (event) => event.event === "attachmentClosed" && event.payload?.reason === "mobile_replaced",
  );
  assert.ok(closedEvent);
  assert.notEqual(first.mobileRelay.closedCode, null);
  assert.notEqual(first.connectorRelay.closedCode, null);
  // 收尾拆掉新 attachment：不留 joinTimer 拖住测试进程事件循环。
  hub.handleMobileClosed(second);
});

test("迟到的旧链路 close 不拆新链路的 attachment", async () => {
  const { hub } = await makeHub();
  await attachOnlineNode(hub);
  const first = await attachAndJoin(hub);

  const second = new FakeMobileLink("dev-1");
  hub.handleMobileOpened(second);
  await hub.handleMobileRequest(second, "takeover", "attach", {
    nodeId: "cloud-1",
    workspacePath: "/srv/demo",
    workspaceIdentity: "/srv/demo",
  });
  const takeoverResponse = (await second.waitForResponse("takeover")) as {
    ok: boolean;
    value: { result?: { attachmentId: string; relayCapability: string } };
  };
  assert.ok(takeoverResponse.ok);

  // 旧链路此刻才断开（迟到 close）：只清自己，新 attachment 不受影响。
  hub.handleMobileClosed(first.mobile);
  const secondRelay = new FakeRelayJoin(
    takeoverResponse.value.result!.attachmentId,
    takeoverResponse.value.result!.relayCapability,
  );
  assert.equal(hub.handleRelayJoin(secondRelay, Date.now()), true);
  // 新 attachment 仍然存活：binary 帧能进入透传（单侧等待不误拆）。
  const connectorCapability = (
    (hub["nodeLinks"].get("cloud-1") as FakeNodeLink).requests.findLast(
      (entry) => entry.op === "attach",
    )!.params as { relayCapability: string }
  ).relayCapability;
  const secondConnectorRelay = new FakeRelayJoin(
    takeoverResponse.value.result!.attachmentId,
    connectorCapability,
  );
  assert.equal(hub.handleRelayJoin(secondConnectorRelay, Date.now()), true);
  const payload = new Uint8Array([7, 7, 7]);
  secondRelay.pushIncoming(payload);
  assert.deepEqual(secondConnectorRelay.received[0], payload);
});

test("pending 计入 attachment 配额（并发 attach 不得绕过限额）", async () => {
  const controlStore = new MemoryControlStore();
  await controlStore.saveNode({
    nodeId: "cloud-1",
    kind: "cloud",
    displayName: "云端节点",
    tokenFingerprint: "f".repeat(64),
    createdAt: 1,
  });
  for (const deviceId of ["dev-1", "dev-2"]) {
    await controlStore.saveDevice({ deviceId, deviceName: deviceId, createdAt: 2 });
    await controlStore.saveGrants({
      deviceId,
      nodes: [{ nodeId: "cloud-1", workspaceIdentities: [] }],
    });
  }
  const hub = new CompanionHub({
    store: controlStore,
    clock: makeClock(),
    secrets: makeSecrets(),
    defaults: { ...COMPANION_GATEWAY_DEFAULTS, maxAttachments: 1, attachRequestTimeoutMs: 150 },
    logger: noopLogger,
  });
  await attachOnlineNode(hub);
  // 节点挂起 attach 响应 → 第一个请求停留在 pending（占用配额）。
  (hub["nodeLinks"].get("cloud-1") as FakeNodeLink).onAttach(() => new Promise(() => undefined));

  const first = new FakeMobileLink("dev-1");
  hub.handleMobileOpened(first);
  // 不 await：handleAttach 停在挂起的节点请求上；轮询等 pending 落地即可。
  void hub.handleMobileRequest(first, "p1", "attach", {
    nodeId: "cloud-1",
    workspacePath: "/srv/demo",
    workspaceIdentity: "/srv/demo",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    (hub["nodeLinks"].get("cloud-1") as FakeNodeLink).requests.some((entry) => entry.op === "attach"),
  );

  const second = new FakeMobileLink("dev-2");
  hub.handleMobileOpened(second);
  await hub.handleMobileRequest(second, "p2", "attach", {
    nodeId: "cloud-1",
    workspacePath: "/srv/demo",
    workspaceIdentity: "/srv/demo",
  });
  const response = (await second.waitForResponse("p2")) as {
    ok: boolean;
    value: { code?: string };
  };
  assert.equal(response.ok, false);
  assert.equal(response.value.code, "attachment_limit");
  // 等 pending 超时兜底走完，测试进程不留挂起计时器。
  await new Promise((resolve) => setTimeout(resolve, 250));
});

test("attach 超时：回复手机并同步请求节点清理（防孤儿 attachment）", async () => {
  const controlStore = new MemoryControlStore();
  await controlStore.saveNode({
    nodeId: "cloud-1",
    kind: "cloud",
    displayName: "云端节点",
    tokenFingerprint: "f".repeat(64),
    createdAt: 1,
  });
  await controlStore.saveDevice({ deviceId: "dev-1", deviceName: "手机", createdAt: 2 });
  await controlStore.saveGrants({
    deviceId: "dev-1",
    nodes: [{ nodeId: "cloud-1", workspaceIdentities: [] }],
  });
  const hub = new CompanionHub({
    store: controlStore,
    clock: makeClock(),
    secrets: makeSecrets(),
    defaults: { ...COMPANION_GATEWAY_DEFAULTS, attachRequestTimeoutMs: 20 },
    logger: noopLogger,
  });
  await attachOnlineNode(hub);
  (hub["nodeLinks"].get("cloud-1") as FakeNodeLink).onAttach(() => new Promise(() => undefined));

  const mobile = new FakeMobileLink("dev-1");
  hub.handleMobileOpened(mobile);
  // 不 await：handleAttach 停在挂起的节点请求上；响应由 20ms 超时兜底发出。
  void hub.handleMobileRequest(mobile, "t1", "attach", {
    nodeId: "cloud-1",
    workspacePath: "/srv/demo",
    workspaceIdentity: "/srv/demo",
  });
  const response = (await mobile.waitForResponse("t1")) as {
    ok: boolean;
    value: { code?: string };
  };
  assert.equal(response.ok, false);
  assert.equal(response.value.code, "node_offline");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const nodeRequests = (hub["nodeLinks"].get("cloud-1") as FakeNodeLink).requests;
  const detach = nodeRequests.findLast((entry) => entry.op === "detach");
  assert.ok(detach);
  assert.equal(detach.op, "detach");
});

test("workspace-tasks：grants 校验 + 节点转发 + 30s TTL 缓存", async () => {
  const { hub, store } = await makeHub();
  const nodeLink = await attachOnlineNode(hub);
  // 节点侧应答任务摘要（带调用计数，验证缓存命中不再透传）。
  let summaryCalls = 0;
  nodeLink.onAttach(() => ({ ok: true }));
  nodeLink.request = async (op: string, params: unknown) => {
    if (op === "workspace-tasks") {
      summaryCalls += 1;
      return {
        ok: true,
        result: {
          generatedAt: 1,
          available: true,
          sessions: [
            { sessionId: "s1", title: "修复登录", sessionEnded: false, pendingCount: 2, lastActivityAt: 9 },
          ],
        },
      } as never;
    }
    return { ok: true } as never;
  };
  void store;
  const mobile = new FakeMobileLink("dev-1");
  hub.handleMobileOpened(mobile);

  const request = (requestId: string): Promise<{ ok: boolean; value: { result?: { sessions: unknown[] }; code?: string } }> =>
    hub
      .handleMobileRequest(mobile, requestId, "workspace-tasks", {
        nodeId: "cloud-1",
        workspaceIdentity: "/srv/demo",
      })
      .then(() => mobile.waitForResponse(requestId)) as never;

  const first = (await request("t1")) as never as { ok: boolean; value: { result?: { sessions: unknown[] } } };
  assert.ok(first.ok);
  assert.equal(first.value.result!.sessions.length, 1);
  assert.equal(summaryCalls, 1);

  // TTL 内第二次请求：缓存命中，节点不再被调用。
  const second = (await request("t2")) as never as { ok: boolean; value: { result?: { sessions: unknown[] } } };
  assert.ok(second.ok);
  assert.equal(summaryCalls, 1);
});

test("workspace-tasks：未授权工作区拒绝、离线节点拒绝", async () => {
  const { hub, store } = await makeHub();
  await attachOnlineNode(hub);
  await store.saveGrants({
    deviceId: "dev-1",
    nodes: [{ nodeId: "cloud-1", workspaceIdentities: ["/srv/other"] }],
  });
  const mobile = new FakeMobileLink("dev-1");
  hub.handleMobileOpened(mobile);
  await hub.handleMobileRequest(mobile, "t3", "workspace-tasks", {
    nodeId: "cloud-1",
    workspaceIdentity: "/srv/demo",
  });
  const denied = (await mobile.waitForResponse("t3")) as { ok: boolean; value: { code?: string } };
  assert.equal(denied.ok, false);
  assert.equal(denied.value.code, "forbidden_workspace");

  // 离线节点（先授权后断开 node 链路）。
  await store.saveGrants({
    deviceId: "dev-1",
    nodes: [{ nodeId: "cloud-1", workspaceIdentities: [] }],
  });
  const nodeLink = hub["nodeLinks"].get("cloud-1");
  if (nodeLink) hub.handleNodeClosed("cloud-1", nodeLink as FakeNodeLink);
  await hub.handleMobileRequest(mobile, "t4", "workspace-tasks", {
    nodeId: "cloud-1",
    workspaceIdentity: "/srv/demo",
  });
  const offline = (await mobile.waitForResponse("t4")) as { ok: boolean; value: { code?: string } };
  assert.equal(offline.ok, false);
  assert.equal(offline.value.code, "node_offline");
});

test("未知节点 hello 被拒", async () => {
  const { hub } = await makeHub();
  const link = new FakeNodeLink();
  const hello = await hub.handleNodeHello(link, {
    nodeId: "ghost",
    displayName: "幽灵",
    kind: "cloud",
  });
  assert.equal(hello.ok, false);
});

test("catalog 按设备 grants 过滤（未授权节点/工作区不可见）", async () => {
  const { hub, store } = await makeHub();
  await store.saveNode({
    nodeId: "cloud-2",
    kind: "cloud",
    displayName: "别的节点",
    tokenFingerprint: "e".repeat(64),
    createdAt: 3,
  });
  await attachOnlineNode(hub);
  hub.handleNodeWorkspaces("cloud-1", [
    WORKSPACE,
    {
      nodeId: "",
      workspacePath: "/srv/secret",
      workspaceIdentity: "/srv/secret",
      title: "Secret",
      available: true,
    },
  ]);
  // 设备只被授予 cloud-1 的 /srv/demo：cloud-2 与 /srv/secret 都不可见。
  await store.saveGrants({
    deviceId: "dev-1",
    nodes: [{ nodeId: "cloud-1", workspaceIdentities: ["/srv/demo"] }],
  });
  const mobile = new FakeMobileLink("dev-1");
  hub.handleMobileOpened(mobile);
  await hub.handleMobileRequest(mobile, "c9", "catalog", undefined);
  const response = (await mobile.waitForResponse("c9")) as {
    ok: boolean;
    value: { result?: { nodes: Array<{ nodeId: string; workspaces: Array<{ workspacePath: string }> }> } };
  };
  assert.ok(response.ok);
  const nodes = response.value.result!.nodes;
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.nodeId, "cloud-1");
  assert.equal(nodes[0]!.workspaces.length, 1);
  assert.equal(nodes[0]!.workspaces[0]!.workspacePath, "/srv/demo");
});

test("grants 收缩 sweep 拆除越权存量 attachment", async () => {
  const { hub, store } = await makeHub();
  await attachOnlineNode(hub);
  const { mobileRelay, connectorRelay } = await attachAndJoin(hub);
  assert.equal(mobileRelay.closedCode, null);
  // 授权收缩到别的工作区 → sweep 周期内拆除存量 attachment。
  await store.saveGrants({
    deviceId: "dev-1",
    nodes: [{ nodeId: "cloud-1", workspaceIdentities: ["/srv/other"] }],
  });
  await hub.revalidateRevocations();
  assert.notEqual(mobileRelay.closedCode, null);
  assert.notEqual(connectorRelay.closedCode, null);
});
