// gateway HTTP 面的无状态小工具：refresh cookie 形态、TLS 反代协议裁决、
// /companion/pair 每来源限速。从 gatewayServer 抽出以满足单文件行数上限。
import type { Context } from "hono";

/** 控制面单帧字节上限（ws 库默认 maxPayload 100MiB，应用层在此收紧）。 */
export const CONTROL_FRAME_MAX_BYTES = 256 * 1024;

/** TLS 反代后：反代回源是 http，直连 URL 协议判断会丢 Secure；须按转发头裁决。 */
export function isSecureRequest(c: Context, trustForwardedProto: boolean): boolean {
  if (trustForwardedProto) {
    return c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  }
  return new URL(c.req.url).protocol === "https:";
}

export function refreshCookieHeader(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `zc_comp_rt=${encodeURIComponent(token)}; Path=/companion; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** 每来源滑动计数（内存级，进程重启即清零）：只压 /companion/pair 的爆破面。 */
export function createPairRateLimiter(windowMs: number, maxAttempts: number) {
  const attempts = new Map<string, number[]>();
  return (sourceKey: string, now: number): boolean => {
    const hits = (attempts.get(sourceKey) ?? []).filter((time) => now - time < windowMs);
    if (hits.length >= maxAttempts) {
      attempts.set(sourceKey, hits);
      return false;
    }
    hits.push(now);
    attempts.set(sourceKey, hits);
    if (attempts.size > 1024) {
      // 个人自托管面：来源数极小；只做防泄漏上限，超限按最旧键淘汰——
      // 整体 clear 会被攻击者用海量伪造来源键一键清空真实 IP 的计数。
      const overflow = attempts.size - 1024;
      let evicted = 0;
      for (const key of attempts.keys()) {
        if (evicted >= overflow) break;
        attempts.delete(key);
        evicted += 1;
      }
    }
    return true;
  };
}

/** 限速来源键：X-Real-IP（覆盖式）→ XFF 最后一跳 → socket 对端 → "direct"。
 * 绝不取 XFF 第一跳——nginx 追加语义下那是客户端可任意伪造的值。 */
export function resolveClientSourceKey(c: Context): string {
  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  const remote = incoming?.socket?.remoteAddress?.trim();
  return remote || "direct";
}

/** 读取 Cookie 值（畸形百分号编码降级为原值，不让 /companion/refresh 500）。 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      const raw = part.slice(separator + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

export type AuthParams = unknown;

export function readAuthAccessToken(params: AuthParams): string | null {
  const token = (params as { accessToken?: unknown } | null)?.accessToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

export function readNodeToken(params: AuthParams): string | null {
  const token = (params as { nodeToken?: unknown } | null)?.nodeToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** 浏览器 Origin 白名单比对（非浏览器客户端无 Origin 头，直接放行）。 */
export function buildOriginChecker(
  allowedOrigins: string[],
): (origin: string | undefined) => boolean {
  const normalized = allowedOrigins.map((origin) => origin.replace(/\/+$/, ""));
  return (origin) => {
    if (origin === undefined) return true;
    return normalized.includes(origin.replace(/\/+$/, ""));
  };
}
