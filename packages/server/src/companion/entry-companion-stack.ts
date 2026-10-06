// companion 自托管栈生产入口（单 bundle CLI）。部署形态：
//   node zcode-companion.cjs serve            # gateway(127.0.0.1) + resident + 云端连接器
//   node zcode-companion.cjs pair-code        # 铸一次性配对码（跨进程，SQL 级单次消费）
//   node zcode-companion.cjs register-node    # 登记节点，nodeToken 只打印一次
//   node zcode-companion.cjs list-devices | revoke-device --id <id> | revoke-node --id <id>
//   node zcode-companion.cjs stop             # 停 resident daemon（serve 退出不停 daemon）
// 配置全部走环境变量（arg 优先）；serve 监听回环，公网入口由 TLS 反代承担。
import { join } from "node:path";
import { openCompanionControlAdmin } from "@zcode/companion/admin";
import {
  ensureResidentDaemonRunning,
  stopResidentDaemon,
} from "../remote/resident-daemon.js";
import { startCloudCompanionConnector } from "./cloudConnector.js";

interface StackConfig {
  gatewayPort: number;
  gatewayHost: string;
  gatewayUrl: string;
  controlDbPath: string;
  runtimeRoot: string;
  residentScript: string;
  allowedOrigins: string[];
  nodeToken: string;
  nodeId: string;
  nodeDisplayName: string;
  workspaces: Array<{ workspacePath: string; title: string }>;
  trustForwardedProto: boolean;
}

const log = (message: string, details?: Record<string, unknown>): void => {
  const line = details ? `${message} ${JSON.stringify(details)}` : message;
  console.log(`[companion-stack] ${line}`);
};
const errorLog = (message: string, details?: Record<string, unknown>): void => {
  const line = details ? `${message} ${JSON.stringify(details)}` : message;
  console.error(`[companion-stack] ${line}`);
};

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseWorkspaces(spec: string): Array<{ workspacePath: string; title: string }> {
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.indexOf("=");
      return separator >= 0
        ? { workspacePath: entry.slice(0, separator), title: entry.slice(separator + 1) }
        : { workspacePath: entry, title: entry };
    });
}

function loadConfig(): StackConfig {
  const env = process.env;
  const gatewayPort = Number(env.ZCODE_COMPANION_PORT ?? readArg("--port") ?? 18230);
  const controlDbPath = env.ZCODE_COMPANION_CONTROL_DB ?? readArg("--control-db");
  const runtimeRoot = env.ZCODE_SERVER_RUNTIME_ROOT ?? readArg("--runtime-root");
  const argWorkspaces = process.argv
    .map((value, index) => (process.argv[index - 1] === "--workspace" ? value : null))
    .filter((value): value is string => value !== null);
  const workspaceSpec =
    argWorkspaces.length > 0
      ? argWorkspaces.join(",")
      : (env.ZCODE_COMPANION_WORKSPACES ?? "");
  const config: StackConfig = {
    gatewayPort,
    gatewayHost: env.ZCODE_COMPANION_HOST ?? "127.0.0.1",
    gatewayUrl: env.ZCODE_COMPANION_GATEWAY_URL ?? `ws://127.0.0.1:${gatewayPort}`,
    controlDbPath: controlDbPath ?? "",
    runtimeRoot: runtimeRoot ?? "",
    residentScript:
      env.ZCODE_RESIDENT_SCRIPT ?? join(import.meta.dirname, "zcode-server.cjs"),
    allowedOrigins: (env.ZCODE_COMPANION_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    nodeToken: env.ZCODE_COMPANION_NODE_TOKEN ?? "",
    nodeId: env.ZCODE_COMPANION_NODE_ID ?? "cloud-main",
    nodeDisplayName: env.ZCODE_COMPANION_NODE_NAME ?? "本机云端",
    workspaces: parseWorkspaces(workspaceSpec),
    trustForwardedProto: env.ZCODE_COMPANION_TRUST_FORWARDED_PROTO === "1",
  };
  return config;
}

async function runServe(config: StackConfig): Promise<void> {
  if (!config.controlDbPath || !config.runtimeRoot) {
    console.error("serve requires ZCODE_COMPANION_CONTROL_DB and ZCODE_SERVER_RUNTIME_ROOT");
    process.exit(2);
  }
  if (!config.nodeToken) {
    console.error("serve requires ZCODE_COMPANION_NODE_TOKEN (run `register-node` first)");
    process.exit(2);
  }
  if (config.workspaces.length === 0) {
    console.error("serve requires workspaces (ZCODE_COMPANION_WORKSPACES=path=title,...)");
    process.exit(2);
  }

  // 1) resident daemon：幂等拉起（detached 独立进程组；serve 退出不停 daemon，任务不随连接消亡）。
  const daemonStatus = await ensureResidentDaemonRunning({
    runtimeRoot: config.runtimeRoot,
    scriptPath: config.residentScript,
    env: { ...process.env, ZCODE_SERVER_RUNTIME_ROOT: config.runtimeRoot },
    log: (message, ...rest) => log(String(message), rest[0] as Record<string, unknown> | undefined),
  });
  log("resident daemon ready", { pid: daemonStatus.pid, port: daemonStatus.port });

  // 2) gateway：只监听回环，公网由 TLS 反代转发。
  const { startCompanionGateway } = await import("@zcode/companion");
  const gateway = await startCompanionGateway({
    port: config.gatewayPort,
    host: config.gatewayHost,
    controlDbPath: config.controlDbPath,
    allowedOrigins: config.allowedOrigins,
    trustForwardedProto: config.trustForwardedProto,
    logger: { info: log, warn: (m, d) => errorLog(`warn: ${m}`, d), error: (m, d) => errorLog(m, d) },
  });
  log("gateway listening", {
    host: config.gatewayHost,
    port: gateway.port,
    origins: config.allowedOrigins,
    trustForwardedProto: config.trustForwardedProto,
  });

  // 3) 云端连接器：断线内部重连（退避 2s→30s），gateway 重启/网络抖动不需要进程监督兜底。
  let stopping = false;
  let connector: { stop(): Promise<void> } | null = null;
  let backoffMs = 2_000;
  const startConnector = async (): Promise<void> => {
    while (!stopping) {
      try {
        connector = await startCloudCompanionConnector({
          gatewayUrl: config.gatewayUrl,
          nodeToken: config.nodeToken,
          runtimeRoot: config.runtimeRoot,
          workspaces: config.workspaces,
          onDisconnected: (reason) => {
            if (stopping) return;
            errorLog(`connector disconnected: ${reason}; retrying in ${backoffMs}ms`);
            void (async () => {
              await connector?.stop().catch(() => undefined);
              connector = null;
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
              backoffMs = Math.min(backoffMs * 2, 30_000);
              // 独立重入而非 await：避免断线链条无限增长。
              void startConnector();
            })();
          },
          logger: (message, details) => log(`[connector] ${message}`, details),
        });
        backoffMs = 2_000;
        log("connector started", {
          gateway: config.gatewayUrl,
          node: config.nodeId,
          workspaces: config.workspaces.map((workspace) => workspace.workspacePath),
        });
        return;
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        errorLog(`connector start failed: ${message}; retrying in ${backoffMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  };
  await startConnector();

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`received ${signal}, stopping (resident daemon kept running)`);
    void (async () => {
      await connector?.stop().catch(() => undefined);
      await gateway.stop();
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function runControlCommand(action: string): Promise<void> {
  const config = loadConfig();
  if (!config.controlDbPath) {
    console.error("control commands require ZCODE_COMPANION_CONTROL_DB");
    process.exit(2);
  }
  const admin = await openCompanionControlAdmin({ controlDbPath: config.controlDbPath });
  try {
    if (action === "pair-code") {
      const issued = await admin.createPairingCode();
      console.log(`配对码: ${issued.code}`);
      console.log(`有效期至: ${new Date(issued.expiresAt).toISOString()}（一次性，15 分钟）`);
      return;
    }
    if (action === "register-node") {
      // --id/--name/--kind 覆盖环境变量默认；nodeId 是 serve 侧 ZCODE_COMPANION_NODE_ID 的
      // 登记键，两者必须一致，否则 connector 的 token 指纹对不上节点行。
      // kind 影响手机目录分组展示（云端/电脑），按登记对象如实填写。
      const issued = await admin.registerNode({
        nodeId: readArg("--id") ?? config.nodeId,
        displayName: readArg("--name") ?? config.nodeDisplayName,
        kind: readArg("--kind") === "desktop" ? "desktop" : "cloud",
      });
      console.log(`节点已登记: ${issued.nodeId}`);
      console.log(`nodeToken（只显示这一次，写入 serve 环境变量 ZCODE_COMPANION_NODE_TOKEN）:`);
      console.log(issued.token);
      return;
    }
    if (action === "list-devices") {
      for (const device of await admin.listDevices()) {
        const state = device.revokedAt !== undefined ? `已撤销(${new Date(device.revokedAt).toISOString()})` : "在线登记";
        console.log(`${device.deviceId}  ${device.deviceName}  ${state}`);
      }
      return;
    }
    if (action === "revoke-device" || action === "revoke-node") {
      const id = readArg("--id");
      if (!id) {
        console.error(`${action} requires --id <id>`);
        process.exit(2);
      }
      const done =
        action === "revoke-device" ? await admin.revokeDevice(id) : await admin.revokeNode(id);
      console.log(done ? `已撤销: ${id}` : `未找到或已撤销: ${id}`);
      return;
    }
    console.error(`unknown control command: ${action}`);
    process.exit(2);
  } finally {
    await admin.close();
  }
}

async function main(): Promise<void> {
  const action = process.argv[2] ?? "";
  if (action === "serve") return runServe(loadConfig());
  if (action === "pair-code" || action === "register-node" || action === "list-devices" || action === "revoke-device" || action === "revoke-node") {
    return runControlCommand(action);
  }
  if (action === "stop") {
    const config = loadConfig();
    if (!config.runtimeRoot) {
      console.error("stop requires ZCODE_SERVER_RUNTIME_ROOT");
      process.exit(2);
    }
    const stopped = await stopResidentDaemon({
      runtimeRoot: config.runtimeRoot,
      log: (message, ...rest) => log(String(message), rest[0] as Record<string, unknown> | undefined),
    });
    log(stopped ? "resident daemon stopped" : "resident daemon not running");
    return;
  }
  console.error(
    "usage: zcode-companion <serve|pair-code|register-node|list-devices|revoke-device|revoke-node|stop>",
  );
  process.exit(2);
}

void main().catch((failure: unknown) => {
  errorLog(`fatal: ${failure instanceof Error ? failure.message : String(failure)}`);
  process.exit(1);
});
