// gateway HTTP 面的无状态小工具：refresh cookie 形态、TLS 反代协议裁决、
// /companion/pair 每来源限速。从 gatewayServer 抽出以满足单文件行数上限。
import type { Context } from "hono";

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
      // 个人自托管面：来源数极小；只做防泄漏上限，超限整体重置。
      attempts.clear();
    }
    return true;
  };
}
