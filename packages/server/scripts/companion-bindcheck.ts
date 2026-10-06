// 审查探针：验证 T1/T2 频道是否强制 attachment 的 workspace 绑定。
import { CompanionClient } from "@zcode/companion/client";

const [baseUrl, token] = process.argv.slice(2);
const client = new CompanionClient({ baseUrl, accessToken: token });
await client.connect();
const catalog = await client.catalog();
const node = catalog.nodes.find((entry) => entry.online && entry.workspaces[0]?.available);
if (!node?.workspaces[0]) throw new Error("no workspace");
const attach = await client.attach({
  nodeId: node.nodeId,
  workspacePath: node.workspaces[0].workspacePath,
  workspaceIdentity: node.workspaces[0].workspaceIdentity,
});
const channel = await client.openRelayChannel(attach);
const accessor = channel.accessor as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>;

// 1) file.readdir 读工作区外（宿主用户目录）
try {
  const outside = await accessor.fileService.readdir({ path: "C:/Users/qianmengyys/Desktop" });
  console.log("[BIND-CHECK] file.readdir OUTSIDE workspace: LEAK — entries:",
    JSON.stringify(outside).slice(0, 150));
} catch (e) {
  console.log("[BIND-CHECK] file.readdir outside rejected:", e instanceof Error ? e.message : e);
}
// 2) git 查其他仓库
try {
  const other = await accessor.gitService.getRepositorySummary({
    workspacePath: "C:/Users/qianmengyys/Desktop/agent",
  } as never);
  console.log("[BIND-CHECK] git OUTSIDE workspace: LEAK —", JSON.stringify(other).slice(0, 150));
} catch (e) {
  console.log("[BIND-CHECK] git outside rejected:", e instanceof Error ? e.message : e);
}
// 3) broadcast publish（跨会话注入面）
const broadcastMethods = Object.keys(accessor.broadcastService ?? {});
console.log("[BIND-CHECK] broadcast methods:", broadcastMethods.join(","));
channel.close();
client.close();
process.exit(0);
