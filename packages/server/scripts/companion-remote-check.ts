// A2 外网验证：从开发机经 HTTPS 公网入口走完整云端控制闭环。
// 用法: npx tsx scripts/companion-remote-check.ts <baseUrl> <pairingCode>
// 验证: pair → catalog → attach → relay → clientHello → sessions-index 订阅
// （start-if-needed 会在服务器上拉起 agent CLI —— A2 的关键验证点）。
import { CompanionClient } from "@zcode/companion/client";
import { RemoteServiceAccess } from "@zcode/client";
import { ChannelClient, SocketProtocol } from "@zcode/rpc";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";

const [baseUrl, code] = process.argv.slice(2);
if (!baseUrl || !code) {
  console.error("usage: companion-remote-check <baseUrl> <pairingCode>");
  process.exit(2);
}

const pairResult = await CompanionClient.pair({
  baseUrl,
  deviceName: "remote-check",
  code,
});
console.log("[check] paired deviceId=", pairResult.deviceId);
const client = new CompanionClient({ baseUrl, accessToken: pairResult.accessToken });

await client.connect();
const catalog = await client.catalog();
const node = catalog.nodes.find((entry) => entry.online);
if (!node?.workspaces[0]?.available) {
  throw new Error(`catalog not ready: ${JSON.stringify(catalog).slice(0, 300)}`);
}
console.log("[check] catalog node=", node.nodeId, "workspace=", node.workspaces[0]!.title);

const attach = await client.attach({
  nodeId: node.nodeId,
  workspacePath: node.workspaces[0]!.workspacePath,
  workspaceIdentity: node.workspaces[0]!.workspaceIdentity,
});
console.log("[check] attached", attach.attachmentId);

const channel = await client.openRelayChannel(attach);
const agentService = (
  channel.accessor as unknown as {
    zcodeAgentService: Record<string, (...args: never[]) => unknown>;
  }
).zcodeAgentService;

await agentService.helloConversationV4();
await agentService.initializeConversationV4({
  kind: "clientHello",
  protocolVersion: V4_WIRE_PROTOCOL_VERSION,
  clientId: "remote-check",
  clientKind: "web",
  appVersion: "unknown",
  capabilities: { workspaceHookReviewUi: true },
});
console.log("[check] handshake OK");

const subscribeResult = (await agentService.subscribeSessionsIndexV4({
  workspacePath: node.workspaces[0]!.workspacePath,
  workspaceIdentity: node.workspaces[0]!.workspaceIdentity,
  runtimePolicy: "start-if-needed",
  visibility: "foreground",
})) as { ack: { subscriptionId: string } };
console.log("[check] subscribe OK subscriptionId=", subscribeResult.ack.subscriptionId);

channel.close();
client.close();
console.log("[check] REMOTE CHECK OK");
process.exit(0);
