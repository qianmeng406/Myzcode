// 桌面 companion 连接器集成测试：真实 gateway + 假桌面依赖（开放工作区/端口）。
// 覆盖（连接器侧子集，spec §9.1）：目录白名单过滤、attach 端口选择与消息路径、
// 非白名单拒绝、detach/白名单收缩/窗口关闭拆除。
// 上游端口为测试假体：双端会话事实合流与同时审批一致性未覆盖，归阶段 4 真机验收。
import assert from "node:assert/strict";
import { test } from "node:test";
import { startCompanionGateway } from "@zcode/companion";
import { CompanionClient } from "@zcode/companion/client";
import {
  startDesktopCompanionConnector,
  type CompanionPortLike,
  type OpenWorkspaceEntry,
} from "../src/main/companion/desktopConnector.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface FakePort extends CompanionPortLike {
  closed: boolean;
}

function createFakePort(): FakePort {
  const listeners = new Set<(event: { data: unknown }) => void>();
  return {
    closed: false,
    addEventListener(type, listener) {
      if (type === "message") listeners.add(listener);
    },
    postMessage() {},
    // MessagePortProtocol 构造期无条件调用 start()（真实 MessagePortMain 自带）。
    start() {},
    close() {
      this.closed = true;
    },
  };
}

async function withGateway(run: (port: number, owner: Awaited<ReturnType<typeof startCompanionGateway>>["owner"]) => Promise<void>): Promise<void> {
  const dbRoot = await mkdtemp(join(tmpdir(), "companion-desktop-test-"));
  const gateway = await startCompanionGateway({
    port: 0,
    controlDbPath: join(dbRoot, "control.db"),
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    await run(gateway.port, gateway.owner);
  } finally {
    await gateway.stop();
    await rm(dbRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

const noopLogger = { info() {}, warn() {}, error() {} };

/** detach 是 fire-and-forget 链路（hub → connector → teardown），断言前轮询收敛。 */
async function waitFor(description: string, condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timeout waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("目录只包含白名单工作区；attach 走对端口；非白名单被拒", async () => {
  await withGateway(async (gatewayPort, owner) => {
    const node = await owner.registerNode({
      nodeId: "desktop-test",
      displayName: "测试电脑",
      kind: "desktop",
    });
    const pairingCode = await owner.createPairingCode();
    const paired = await CompanionClient.pair({
      baseUrl: `http://127.0.0.1:${gatewayPort}`,
      deviceName: "测试手机",
      code: pairingCode.code,
    });

    const openWorkspaces: OpenWorkspaceEntry[] = [
      { windowId: 1, workspacePath: "/work/a", workspaceIdentity: "/work/a", title: "A" },
      {
        windowId: 1,
        workspacePath: "/srv/b",
        workspaceIdentity: "remote-b",
        title: "B",
        remoteSessionId: "sess-b",
      },
    ];
    const createdPorts: FakePort[] = [];
    let resolvedIdentity: string | null = null;

    const connector = await startDesktopCompanionConnector({
      gatewayUrl: `ws://127.0.0.1:${gatewayPort}`,
      nodeToken: node.token,
      allowedWorkspaces: ["/work/a"],
      deps: {
        listOpenWorkspaces: () => openWorkspaces,
        resolveAttachmentPort: (entry) => {
          resolvedIdentity = entry.workspaceIdentity;
          const port = createFakePort();
          createdPorts.push(port);
          return port;
        },
        resolveListPort: (entry) => {
          resolvedIdentity = entry.workspaceIdentity;
          const port = createFakePort();
          createdPorts.push(port);
          return port;
        },
        log: noopLogger.info,
      },
    });

    const phone = new CompanionClient({
      baseUrl: `http://127.0.0.1:${gatewayPort}`,
      accessToken: paired.accessToken,
    });
    await phone.connect();
    try {
      const catalog = await phone.catalog();
      const desktopNode = catalog.nodes.find((entry) => entry.nodeId === "desktop-test");
      assert.ok(desktopNode?.online);
      assert.equal(desktopNode.workspaces.length, 1);
      assert.equal(desktopNode.workspaces[0]!.workspaceIdentity, "/work/a");

      // 白名单内：attach 成功并选择本地端口路径。
      const attachResult = await phone.attach({
        nodeId: "desktop-test",
        workspacePath: "/work/a",
        workspaceIdentity: "/work/a",
      });
      assert.ok(attachResult.attachmentId);
      assert.equal(resolvedIdentity, "/work/a");
      assert.equal(createdPorts.length, 1);
      assert.equal(createdPorts[0]!.closed, false);

      // hub 不变量：每设备同时至多一个 attachment —— 先拆 A 再验证白名单外拒绝。
      await phone.detach({ attachmentId: attachResult.attachmentId });
      await waitFor("port closed after detach", () => createdPorts[0]!.closed);

      // 白名单外：拒绝（工作区未开放/未共享 → workspace_unavailable）。
      await assert.rejects(
        () =>
          phone.attach({
            nodeId: "desktop-test",
            workspacePath: "/srv/b",
            workspaceIdentity: "remote-b",
          }),
        (error: unknown) => error instanceof Error && error.message.includes("workspace_unavailable"),
      );
    } finally {
      await phone.close();
      await connector.stop();
    }
  });
});

test("白名单收缩即时拆除已不在名单内的 attachment；窗口关闭同理", async () => {
  await withGateway(async (gatewayPort, owner) => {
    const node = await owner.registerNode({
      nodeId: "desktop-test-2",
      displayName: "测试电脑2",
      kind: "desktop",
    });
    const pairingCode = await owner.createPairingCode();
    const paired = await CompanionClient.pair({
      baseUrl: `http://127.0.0.1:${gatewayPort}`,
      deviceName: "测试手机2",
      code: pairingCode.code,
    });

    const openWorkspaces: OpenWorkspaceEntry[] = [
      { windowId: 7, workspacePath: "/work/x", workspaceIdentity: "/work/x", title: "X" },
    ];
    const createdPorts: FakePort[] = [];
    const connector = await startDesktopCompanionConnector({
      gatewayUrl: `ws://127.0.0.1:${gatewayPort}`,
      nodeToken: node.token,
      allowedWorkspaces: ["/work/x"],
      deps: {
        listOpenWorkspaces: () => openWorkspaces,
        resolveAttachmentPort: () => {
          const port = createFakePort();
          createdPorts.push(port);
          return port;
        },
        resolveListPort: () => {
          const port = createFakePort();
          createdPorts.push(port);
          return port;
        },
        log: noopLogger.info,
      },
    });

    const phone = new CompanionClient({
      baseUrl: `http://127.0.0.1:${gatewayPort}`,
      accessToken: paired.accessToken,
    });
    const closedEvents: string[] = [];
    phone.onEvent((event) => {
      if (event.event === "attachmentClosed") {
        const attachmentId = (event.payload as { attachmentId?: unknown } | undefined)?.attachmentId;
        if (typeof attachmentId === "string") closedEvents.push(attachmentId);
      }
    });
    await phone.connect();
    try {
      const attachResult = await phone.attach({
        nodeId: "desktop-test-2",
        workspacePath: "/work/x",
        workspaceIdentity: "/work/x",
      });
      assert.equal(createdPorts.length, 1);

      // 手机断开 → 手机侧 attachment 拆除（经网关 detach 链路）。
      await phone.detach({ attachmentId: attachResult.attachmentId });
      await waitFor("port closed after detach", () => createdPorts[0]!.closed);

      // 再次 attach 后收缩白名单：connector 侧立即拆除端口。
      const second = await phone.attach({
        nodeId: "desktop-test-2",
        workspacePath: "/work/x",
        workspaceIdentity: "/work/x",
      });
      assert.equal(createdPorts.length, 2);
      await connector.setAllowedWorkspaces([]);
      await waitFor("port closed after allowlist shrink", () => createdPorts[1]!.closed);
      void second;

      // 恢复白名单再 attach，窗口关闭 → 该窗口 attachment 即时拆除、目录刷新。
      await connector.setAllowedWorkspaces(["/work/x"]);
      // connector 侧拆除 → hub 感知 relay 断开是异步收敛：等手机收到对应
      // attachmentClosed 事件后再附着，避免与「每设备至多一个」不变量竞争。
      await waitFor("hub teardown of shrunken attachment", () =>
        closedEvents.includes(second.attachmentId),
      );
      const third = await phone.attach({
        nodeId: "desktop-test-2",
        workspacePath: "/work/x",
        workspaceIdentity: "/work/x",
      });
      assert.equal(createdPorts.length, 3);
      connector.handleWindowClosed(7);
      await waitFor("port closed after window close", () => createdPorts[2]!.closed);
      void third;
    } finally {
      await phone.close();
      await connector.stop();
    }
  });
});
