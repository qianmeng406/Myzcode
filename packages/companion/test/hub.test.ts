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

test("同一设备重复 attach 被拒", async () => {
  const { hub } = await makeHub();
  await attachOnlineNode(hub);
  await attachAndJoin(hub);
  const mobile = new FakeMobileLink("dev-1");
  hub.handleMobileOpened(mobile);
  await hub.handleMobileRequest(mobile, "a3", "attach", {
    nodeId: "cloud-1",
    workspacePath: "/srv/demo",
    workspaceIdentity: "/srv/demo",
  });
  const response = (await mobile.waitForResponse("a3")) as { ok: boolean };
  assert.equal(response.ok, false);
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
