// 云端 companion 连接器 CLI 入口（自托管部署用）。
//   node entry-cloud-connector.mjs --gateway-url wss://host \
//     --runtime-root /www/zcode_runtime \
//     --workspace /srv/project-a="项目 A" --workspace /srv/project-b
// 节点令牌从环境变量 ZCODE_COMPANION_NODE_TOKEN 读取（不进 argv/ps）。
import { startCloudCompanionConnector } from "./cloudConnector.js";

interface ParsedArgs {
  gatewayUrl: string;
  runtimeRoot: string;
  workspaces: Array<{ workspacePath: string; title: string }>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const read = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const gatewayUrl = read("--gateway-url");
  const runtimeRoot = read("--runtime-root");
  if (!gatewayUrl || !runtimeRoot) {
    console.error("usage: entry-cloud-connector --gateway-url <url> --runtime-root <dir> [--workspace path[=title]]...");
    process.exit(2);
  }
  const workspaces: Array<{ workspacePath: string; title: string }> = [];
  let index = 0;
  while (index < argv.length) {
    if (argv[index] === "--workspace") {
      const raw = argv[index + 1] ?? "";
      const separator = raw.indexOf("=");
      workspaces.push(
        separator >= 0
          ? { workspacePath: raw.slice(0, separator), title: raw.slice(separator + 1) }
          : { workspacePath: raw, title: raw },
      );
      index += 2;
      continue;
    }
    index += 1;
  }
  return { gatewayUrl, runtimeRoot, workspaces };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const nodeToken = process.env.ZCODE_COMPANION_NODE_TOKEN?.trim();
  if (!nodeToken) {
    console.error("[companion-cloud] missing ZCODE_COMPANION_NODE_TOKEN");
    process.exit(2);
  }
  const handle = await startCloudCompanionConnector({
    gatewayUrl: args.gatewayUrl,
    nodeToken,
    runtimeRoot: args.runtimeRoot,
    workspaces: args.workspaces,
    onDisconnected: (reason) => {
      // 简单监督策略：进程退出交给系统服务（systemd/面板守护）拉起重连。
      console.error(`[companion-cloud] disconnected: ${reason}; exiting for supervisor restart`);
      process.exit(1);
    },
    logger: (message, details) => console.log(`[companion-cloud] ${message}`, details ?? ""),
  });
  console.log(`[companion-cloud] connector started (gateway ${args.gatewayUrl})`);
  const shutdown = (signal: string): void => {
    console.log(`[companion-cloud] received ${signal}, stopping`);
    void handle.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  console.error("[companion-cloud] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
