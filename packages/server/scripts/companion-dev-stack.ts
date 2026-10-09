// 阶段 4 真机验收本地栈：gateway + 云端 resident + connector + 配对码 一键拉起。
// 手机与电脑同一局域网，App 里填 http://<本机局域网IP>:<端口>。
// 用法：packages/server 下 `npx tsx scripts/companion-dev-stack.ts [--port 18230] [--workspace <dir>]`
// Ctrl+C 停止：依次停 connector、gateway、resident daemon。
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, cpSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCompanionGateway } from "@zcode/companion";
import { startCloudCompanionConnector } from "@zcode/server/companion";

const args = process.argv.slice(2);
const readArg = (name: string, fallback: string): string => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const PORT = Number(readArg("--port", "18230"));
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const stackRoot = join(repoRoot, ".tmp", "companion-dev-stack");
const runtimeRoot = join(stackRoot, "runtime");
const workspaceDir = resolve(readArg("--workspace", join(stackRoot, "workspace")));

/** 本机局域网 IPv4（手机直连地址）；取不到时回退回环，避免打印写死的固定地址。 */
function lanIPv4(): string {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        return info.address;
      }
    }
  }
  return "127.0.0.1";
}

// 工作区准备：真实目录 + 一个演示文件（Agent 可读改）。
rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(workspaceDir, { recursive: true });
cpSync(join(repoRoot, "packages", "companion", "specs", "companion-gateway.md"), join(workspaceDir, "companion-gateway.md"));
mkdirSync(runtimeRoot, { recursive: true });

const bundle = join(repoRoot, "packages", "server", "dist", "remote", "zcode-server.cjs");
const env = { ...process.env, ZCODE_SERVER_RUNTIME_ROOT: runtimeRoot };

// 1) resident daemon（真实运行时，附着模式，不新建执行者）
execFileSync(process.execPath, [bundle, "--resident-start"], { env, stdio: "inherit", timeout: 60_000 });
const daemonStatus = JSON.parse(readFileSync(join(runtimeRoot, "daemon.json"), "utf8")) as {
  pid: number;
  port: number;
};
console.log(`[stack] resident daemon pid=${daemonStatus.pid} port=${daemonStatus.port}`);

// 2) gateway（局域网可达：0.0.0.0；允许 Capacitor 壳与本地 dev 页面的来源）
const gateway = await startCompanionGateway({
  port: PORT,
  host: "0.0.0.0",
  controlDbPath: join(stackRoot, "control.db"),
  allowedOrigins: [
    "http://localhost",
    "https://localhost",
    "http://localhost:5180",
    // 完整 Web UI 浏览器验收：vite dev(5173) / preview(4173) / 静态服务(5190)
    "http://localhost:5173",
    "http://localhost:4173",
    "http://localhost:5190",
  ],
  logger: {
    info: (message, details) => console.log("[gateway]", message, details ?? ""),
    warn: (message, details) => console.warn("[gateway]", message, details ?? ""),
    error: (message, details) => console.error("[gateway]", message, details ?? ""),
  },
});

// 3) 登记云端节点 + 启动 connector
const node = await gateway.owner.registerNode({
  nodeId: "cloud-dev",
  displayName: "本机云端（验收）",
  kind: "cloud",
});
const connector = await startCloudCompanionConnector({
  gatewayUrl: `ws://127.0.0.1:${gateway.port}`,
  nodeToken: node.token,
  runtimeRoot,
  workspaces: [{ workspacePath: workspaceDir, title: "验收工作区" }],
  onDisconnected: (reason) => console.warn("[connector] disconnected:", reason),
  logger: (message, details) => console.log("[connector]", message, details ?? ""),
});

// 4) 配对码
const pairing = await gateway.owner.createPairingCode();

console.log("\n===== 手机端配置 =====");
console.log(`接入服务地址:  http://${lanIPv4()}:${gateway.port}`);
console.log(`配对码:       ${pairing.code}`);
console.log(`验收工作区:    ${workspaceDir}`);
console.log("======================\n");

const shutdown = (): void => {
  console.log("\n[stack] stopping…");
  void (async () => {
    await connector.stop().catch(() => undefined);
    await gateway.stop().catch(() => undefined);
    try {
      execFileSync(process.execPath, [bundle, "--resident-stop"], { env, stdio: "ignore", timeout: 30_000 });
    } catch {
      // daemon 可能已被手动停止
    }
    process.exit(0);
  })();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// 保活
setInterval(() => undefined, 60_000);
void daemonStatus;
