// 桌面侧配对码签发：用已保存的节点令牌向 gateway 索取一次性 6 位配对码，
// 供"My zcode 桌面直连"弹窗直接展示，用户在手机端输入即可完成配对。
// 令牌只出现在本进程内存与 Authorization 头，不写日志、不回传 renderer。
export interface CompanionPairingCode {
  code: string;
  expiresAt: number;
  displayName: string;
}

const CSRF_HEADERS: Record<string, string> = { "x-zcode-companion": "my-zcode" };

/** wss://host → https://host；ws:// → http://（LAN 调试路径）。 */
export function gatewayHttpBase(gatewayUrl: string): string {
  return gatewayUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://");
}

export async function requestCompanionPairingCode(options: {
  gatewayUrl: string;
  nodeToken: string;
  /** 当前勾选共享的工作区身份；随码声明范围，配对后的 grants 精确到此列表。 */
  scopeWorkspaceIdentities?: string[];
  fetchImpl?: typeof fetch;
}): Promise<CompanionPairingCode> {
  const base = gatewayHttpBase(options.gatewayUrl);
  if (base === "" || options.nodeToken === "") {
    throw new Error("桌面直连未配置");
  }
  const doFetch = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    ...CSRF_HEADERS,
    authorization: `Bearer ${options.nodeToken}`,
  };
  const init: RequestInit = { method: "POST", headers };
  if (options.scopeWorkspaceIdentities) {
    // 随码声明共享范围：配对后的 grants 精确到当前勾选的工作区。
    headers["content-type"] = "application/json";
    init.body = JSON.stringify({
      workspaceIdentities: options.scopeWorkspaceIdentities.slice(0, 32),
    });
  }
  const response = await doFetch(`${base}/companion/nodes/pair-code`, init);
  const body = (await response.json().catch(() => null)) as
    | {
        code?: unknown;
        expiresAt?: unknown;
        displayName?: unknown;
        error?: { message?: unknown };
      }
    | null;
  if (!response.ok || body === null || typeof body.code !== "string") {
    const message =
      typeof body?.error?.message === "string" ? body.error.message : `HTTP ${response.status}`;
    throw new Error(`配对码获取失败：${message}`);
  }
  return {
    code: body.code,
    expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : Date.now() + 15 * 60 * 1000,
    displayName: typeof body.displayName === "string" ? body.displayName : "",
  };
}
