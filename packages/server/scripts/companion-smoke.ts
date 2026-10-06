// Companion 云端控制闭环冒烟：真实 resident daemon + 自托管 gateway + 云端连接器
// + CompanionClient（Node 内置 WebSocket 模拟手机端）。
// 验收（specs/companion-gateway.md §9 场景 1/3/7 的机器可测子集）：
//   1) 节点 hello → catalog 可见工作区
//   2) 配对 → 设备 access token → attach → relay 建立通道
//   3) v4 hello 从手机端经 gateway/connector 到 resident runtime 往返
//   4) 断开 relay（模拟手机断开）→ daemon 仍存活（任务不随连接消亡）
// 运行：packages/server 下 `npx tsx scripts/companion-smoke.ts`（先构建 remote bundle）。
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCompanionGateway } from "@zcode/companion";
import { CompanionClient } from "@zcode/companion/client";
import { startCloudCompanionConnector } from "@zcode/server/companion";

const root = mkdtempSync(join(tmpdir(), "zcode-companion-smoke-"));
const workspaceDir = join(root, "workspace");
mkdirSync(workspaceDir, { recursive: true });
const runtimeRoot = join(root, "runtime");
const bundle = join(fileURLToPath(new URL("../dist/remote/zcode-server.cjs", import.meta.url)));
const env = { ...process.env, ZCODE_SERVER_RUNTIME_ROOT: runtimeRoot };
const step = (message: string) => console.log("[step]", message);

const probe = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

const run = async (): Promise<void> => {
  // 1. 启动真实 resident daemon
  execFileSync(process.execPath, [bundle, "--resident-start"], {
    env,
    stdio: "inherit",
    timeout: 60_000,
  });
  const daemonStatus = JSON.parse(fs.readFileSync(join(runtimeRoot, "daemon.json"), "utf8")) as {
    pid: number;
    port: number;
  };
  step(`resident daemon started pid=${daemonStatus.pid} port=${daemonStatus.port}`);

  // 2. 启动 gateway（随机端口）
  const gateway = await startCompanionGateway({
    port: 0,
    controlDbPath: join(root, "control.db"),
    logger: {
      info: (message, details) => console.log("[gateway]", message, details ?? ""),
      warn: (message, details) => console.warn("[gateway]", message, details ?? ""),
      error: (message, details) => console.error("[gateway]", message, details ?? ""),
    },
  });
  step(`gateway listening on ${gateway.port}`);

  // 3. 登记云端节点 + 配对设备（owner 面板）
  const node = await gateway.owner.registerNode({
    nodeId: "cloud-smoke",
    displayName: "冒烟云端",
    kind: "cloud",
  });
  const pairingCode = await gateway.owner.createPairingCode();
  // CSRF 防线：缺 X-ZCode-Companion 头的写请求必须被拒（spec §6）。
  const csrflessResponse = await fetch(`http://127.0.0.1:${gateway.port}/companion/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceName: "缺头设备", code: pairingCode.code }),
  });
  if (csrflessResponse.status !== 403) {
    throw new Error(`missing CSRF header must be rejected with 403, got ${csrflessResponse.status}`);
  }
  step("CSRF header enforced on write endpoints");
  // 模拟手机调用 /companion/pair（等价 owner.pairDevice，走 HTTP 面）。
  const pairResponse = await fetch(`http://127.0.0.1:${gateway.port}/companion/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-ZCode-Companion": "my-zcode" },
    body: JSON.stringify({ deviceName: "冒烟手机", code: pairingCode.code }),
  });
  if (!pairResponse.ok) {
    throw new Error(`pair failed: ${pairResponse.status} ${await pairResponse.text()}`);
  }
  const pairBody = (await pairResponse.json()) as { deviceId: string; accessToken: string };
  step(`device paired deviceId=${pairBody.deviceId}`);

  // 4. 启动云端连接器（附着 daemon，出站连 gateway）
  const connector = await startCloudCompanionConnector({
    gatewayUrl: `ws://127.0.0.1:${gateway.port}`,
    nodeToken: node.token,
    runtimeRoot,
    workspaces: [{ workspacePath: workspaceDir, title: "冒烟工作区" }],
    logger: (message, details) => console.log("[connector]", message, details ?? ""),
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 5. 手机端：连接控制面 → catalog → attach
  const client = new CompanionClient({
    baseUrl: `http://127.0.0.1:${gateway.port}`,
    accessToken: pairBody.accessToken,
  });
  await client.connect();
  const catalog = await client.catalog();
  const cloudNode = catalog.nodes.find((entry) => entry.nodeId === "cloud-smoke");
  if (!cloudNode?.online || cloudNode.workspaces.length !== 1 || !cloudNode.workspaces[0]!.available) {
    throw new Error(`catalog not ready: ${JSON.stringify(catalog)}`);
  }
  step("catalog visible with online cloud node + available workspace");

  const attachResult = await client.attach({
    nodeId: "cloud-smoke",
    workspacePath: workspaceDir,
    workspaceIdentity: workspaceDir,
  });
  step(`attached attachmentId=${attachResult.attachmentId}`);

  // 6. 打开 relay 数据面，走 v4 握手（手机 → gateway → connector → daemon → runtime）
  const channel = await client.openRelayChannel(attachResult);
  const agentService = (channel.accessor as unknown as {
    zcodeAgentService: { helloConversationV4: () => Promise<{ version: string }> };
  }).zcodeAgentService;
  const hello = await Promise.race([
    agentService.helloConversationV4(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("v4 hello round-trip timed out")), 30_000),
    ),
  ]);
  const helloRecord = hello as unknown as { kind?: string; deliveryProfile?: string };
  if (helloRecord?.kind !== "hello") {
    throw new Error(`unexpected v4 hello: ${JSON.stringify(hello).slice(0, 200)}`);
  }
  step(
    `v4 hello round-trip OK (deliveryProfile=${helloRecord.deliveryProfile}, protocolVersion=${(hello as unknown as { protocolVersion: number }).protocolVersion})`,
  );

  // 7. 断开 relay（模拟手机断开）→ daemon 必须仍存活
  channel.close();
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (!(await probe(daemonStatus.port))) {
    throw new Error("resident daemon died after mobile relay closed");
  }
  step("daemon still alive after mobile disconnect");

  // 8. 收尾：gateway/connector/daemon 全部停止
  await connector.stop();
  await client.close();
  await gateway.stop();
  execFileSync(process.execPath, [bundle, "--resident-stop"], {
    env,
    stdio: "inherit",
    timeout: 30_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (await probe(daemonStatus.port)) {
    throw new Error("daemon still alive after --resident-stop");
  }
  step("SMOKE OK");
};

const cleanupRoot = (): void => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows 上 daemon 子进程短暂占用临时目录时清理可失败，留待系统回收。
  }
};

try {
  await run();
} catch (error) {
  console.error("[smoke] FAILED:", error instanceof Error ? error.message : error);
  try {
    const daemonLog = fs.readFileSync(join(runtimeRoot, "daemon.log"), "utf8");
    console.error("[smoke] daemon.log tail:\n" + daemonLog.split("\n").slice(-15).join("\n"));
  } catch {
    // 日志缺席也说明 daemon 没起来过。
  }
  cleanupRoot();
  process.exit(1);
}
cleanupRoot();
process.exit(0);
