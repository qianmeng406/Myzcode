// 配对会话恢复（App 重启后免重配对），按优先级：
// 1) HttpOnly refresh Cookie（WebView 持久化；force-stop 可能丢未 flush 的
//    Cookie，故不能只依赖它）→ 静默换新 access；
// 2) 上次配对的 access token（12h 短时、服务端可即时撤销）+ 端点——
//    有效期内恢复，过期则回配对页。长期 refresh 凭证不落 localStorage。
import { CompanionClient } from "@zcode/companion/client";

const ENDPOINT_KEY = "zcode-companion-endpoint";
const PERSIST_KEY = "zcode-companion-persist";
const CONFIG_KEY = "zcode-companion-config";

export interface CompanionConfig {
  baseUrl: string;
  accessToken: string;
}

export { ENDPOINT_KEY, PERSIST_KEY, CONFIG_KEY };

export function loadPersistedConfig(): { baseUrl: string; accessToken: string } | null {
  try {
    const raw = window.localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CompanionConfig>;
    if (typeof parsed.baseUrl === "string" && typeof parsed.accessToken === "string") {
      return { baseUrl: parsed.baseUrl, accessToken: parsed.accessToken };
    }
  } catch {
    // 坏数据按未配置处理。
  }
  return null;
}

export async function tryRecoverSession(): Promise<CompanionConfig | null> {
  const baseUrl = window.localStorage.getItem(ENDPOINT_KEY);
  if (baseUrl) {
    try {
      const result = await CompanionClient.refresh({ baseUrl });
      const config: CompanionConfig = { baseUrl, accessToken: result.accessToken };
      window.sessionStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      // 同步刷新持久回退：否则 Cookie 再次丢失时会退回更旧的（可能已过期的）
      // token，白白多走一次配对。
      window.localStorage.setItem(PERSIST_KEY, JSON.stringify(config));
      return config;
    } catch {
      // Cookie 不在（force-stop 丢失/过期）→ 回退持久 token。
    }
  }
  const persisted = loadPersistedConfig();
  if (!persisted) return null;
  try {
    const client = new CompanionClient({
      baseUrl: persisted.baseUrl,
      accessToken: persisted.accessToken,
    });
    await client.connect();
    const result = await client.catalog();
    client.close();
    if (!result.nodes.length) return null;
    window.sessionStorage.setItem(CONFIG_KEY, JSON.stringify(persisted));
    return persisted;
  } catch {
    return null;
  }
}
