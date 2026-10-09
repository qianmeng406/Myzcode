// B3 调试：经 relay 逐个调用三分名单里的 T1/T2 只读方法，定位 "Method not found"。
// 用法: npx tsx scripts/companion-policy-probe.ts <baseUrl> <accessToken>
import { CompanionClient } from "@zcode/companion/client";

const [baseUrl, token] = process.argv.slice(2);
if (!baseUrl || !token) {
  console.error("usage: companion-policy-probe <baseUrl> <accessToken>");
  process.exit(2);
}

const client = new CompanionClient({ baseUrl, accessToken: token });
await client.connect();
const catalog = await client.catalog();
const node = catalog.nodes.find((entry) => entry.online && entry.workspaces[0]?.available);
if (!node?.workspaces[0]) throw new Error("no available workspace");
const attach = await client.attach({
  nodeId: node.nodeId,
  workspacePath: node.workspaces[0].workspacePath,
  workspaceIdentity: node.workspaces[0].workspaceIdentity,
});
const channel = await client.openRelayChannel(attach);
const accessor = channel.accessor as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>;

const probes: Array<[string, string, unknown[]]> = [
  ["setting", "get", []],
  ["system", "info", []],
  ["model-selection", "getView", []],
  ["file", "readdir", [{ path: node.workspaces[0]!.workspacePath }]],
  ["git", "getRepositorySummary", [{ workspacePath: node.workspaces[0]!.workspacePath }]],
  ["provider-settings", "getView", []],
  ["coding-plan-subscription", "getDynamicWorkflowClientConfig", []],
  ["bots", "getStatus", []],
  ["zcode-session", "readWorkspacePresentation", [{ workspacePath: node.workspaces[0]!.workspacePath }]],
  ["zcode-task", "initialize", [{ workspacePath: node.workspaces[0]!.workspacePath }]],
];

// RemoteServiceAccess 按 xxxService 属性名暴露，这里映射到频道裁决名。
const SERVICE_PROPERTY_BY_CHANNEL: Record<string, string> = {
  setting: "settingService",
  system: "systemService",
  "model-selection": "modelSelectionService",
  file: "fileService",
  git: "gitService",
  "provider-settings": "providerSettingsService",
  "coding-plan-subscription": "codingPlanSubscriptionService",
  bots: "botsService",
  "zcode-task": "zcodeTaskService",
  "zcode-session": "zcodeSessionService",
  broadcast: "broadcastService",
  "file-watcher": "fileWatcherService",
  "media-preview": "mediaPreviewService",
};

for (const [channelName, method, args] of probes) {
  const propertyName = SERVICE_PROPERTY_BY_CHANNEL[channelName];
  const service = propertyName ? accessor[propertyName] : undefined;
  if (!service) {
    console.log(`[probe] ${channelName}.${method}: (no service on accessor)`);
    continue;
  }
  try {
    const result = await service[method]?.(args[0]);
    console.log(
      `[probe] ${channelName}.${method}: OK ${JSON.stringify(result).slice(0, 120)}`,
    );
  } catch (error) {
    console.log(`[probe] ${channelName}.${method}: FAIL ${error instanceof Error ? error.message : String(error)}`);
  }
}

channel.close();
client.close();
process.exit(0);
