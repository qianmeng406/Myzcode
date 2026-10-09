// 配对/刷新 HTTP 路由（从 gatewayServer 拆出，保持单文件架构门禁内）：
// /companion/pair（限速 + 一次性码消费）、/companion/nodes/pair-code（节点令牌
// 签发绑定）、/companion/refresh（HttpOnly Cookie 轮换）。鉴权与限速语义见 spec §6。
import type { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { CompanionNodeRecord } from "@zcode/shared/companion-protocol";
import type { CompanionPairingService } from "../app/pairing.js";
import type { ControlStore, SecretBox, HubLogger } from "../app/ports.js";
import { isSecureRequest, readCookie, refreshCookieHeader, resolveClientSourceKey } from "./httpGuards.js";

const REFRESH_COOKIE = "zc_comp_rt";

export interface PairingRouteDeps {
  app: Hono;
  pairing: CompanionPairingService;
  store: ControlStore;
  secrets: SecretBox;
  logger: HubLogger;
  requireCsrf: MiddlewareHandler;
  trustForwardedProto: boolean;
  allowPairAttempt: (sourceKey: string, now: number) => boolean;
}

export function registerPairingHttpRoutes(deps: PairingRouteDeps): void {
  const { app, pairing, store, secrets, logger, requireCsrf, trustForwardedProto } = deps;

  app.post("/companion/pair", requireCsrf, async (c) => {
    // 限速在 CSRF 之后、业务之前：无有效 CSRF 的请求同样计数（都不该出现）。
    // 来源键取可信代理写入的覆盖式头（X-Real-IP 由 nginx 用 $remote_addr 覆盖，
    // 客户端伪造无效）；退化链：XFF 最后一跳（追加语义下右端最可信）→ socket
    // 对端地址。绝不能取 XFF 第一跳——那是客户端可随意伪造的值，会让限速失效。
    const sourceKey = resolveClientSourceKey(c);
    if (!deps.allowPairAttempt(sourceKey, Date.now())) {
      logger.warn("companion pair rate limited", { sourceKey });
      return c.json({ error: { code: "rate_limited", message: "too many pairing attempts" } }, 429);
    }
    const body = (await c.req.json().catch(() => null)) as
      | { deviceName?: unknown; code?: unknown }
      | null;
    if (typeof body?.deviceName !== "string" || typeof body?.code !== "string") {
      return c.json({ error: { code: "bad_request", message: "deviceName and code required" } }, 400);
    }
    try {
      const result = await pairing.pairDevice(body.deviceName, body.code);
      c.header(
        "Set-Cookie",
        refreshCookieHeader(result.refreshToken, 365 * 24 * 60 * 60, isSecureRequest(c, trustForwardedProto)),
      );
      return c.json({
        deviceId: result.device.deviceId,
        deviceName: result.device.deviceName,
        accessToken: result.accessToken,
        accessExpiresAt: result.accessExpiresAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "pairing failed";
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "bad_request";
      return c.json({ error: { code, message } }, 400);
    }
  });

  // 节点侧配对码签发：桌面连接器用节点令牌（Bearer）为用户索取 6 位配对码，
  // 免去在桌面 UI 手工保管/粘贴令牌。令牌只比对 sha256 指纹，日志不落明文。
  // 签发绑定：码只授予该节点；body 可声明 workspaceIdentities 进一步收窄范围
  // （桌面 UI 传当前勾选共享的工作区）。owner 在 gateway 主机签发的码才授予全部节点。
  app.post("/companion/nodes/pair-code", requireCsrf, async (c) => {
    const authorization = c.req.header("authorization") ?? "";
    const rawToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (rawToken === "") {
      return c.json({ error: { code: "unauthorized", message: "missing node token" } }, 401);
    }
    const fingerprint = secrets.sha256Hex(rawToken);
    const nodes = await store.listNodes();
    const node = nodes.find(
      (candidate: CompanionNodeRecord) =>
        candidate.tokenFingerprint === fingerprint && candidate.revokedAt === undefined,
    );
    if (!node) {
      logger.warn("companion node pair-code rejected", { fingerprint });
      return c.json({ error: { code: "unauthorized", message: "node token rejected" } }, 401);
    }
    const body = (await c.req.json().catch(() => ({}))) as { workspaceIdentities?: unknown };
    let scopeWorkspaceIdentities: string[] | undefined;
    if (body.workspaceIdentities !== undefined) {
      if (
        !Array.isArray(body.workspaceIdentities) ||
        body.workspaceIdentities.length > 32 ||
        !body.workspaceIdentities.every((item) => typeof item === "string" && item.length > 0 && item.length <= 512)
      ) {
        return c.json(
          { error: { code: "bad_request", message: "workspaceIdentities must be a string array (≤32)" } },
          400,
        );
      }
      scopeWorkspaceIdentities = body.workspaceIdentities as string[];
    }
    const issued = await pairing.createPairingCode({
      issuedByNodeId: node.nodeId,
      ...(scopeWorkspaceIdentities !== undefined ? { scopeWorkspaceIdentities } : {}),
    });
    logger.info("companion node pair-code issued", { nodeId: node.nodeId });
    return c.json({
      code: issued.code,
      expiresAt: issued.expiresAt,
      nodeId: node.nodeId,
      displayName: node.displayName,
    });
  });

  app.post("/companion/refresh", requireCsrf, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { refreshToken?: unknown };
    const cookieToken = readCookie(c.req.header("cookie"), REFRESH_COOKIE);
    const rawToken = typeof body.refreshToken === "string" ? body.refreshToken : cookieToken ?? "";
    if (!rawToken) {
      return c.json({ error: { code: "unauthorized", message: "missing refresh token" } }, 401);
    }
    const result = await pairing.refreshAccess(rawToken);
    if (!result.ok) {
      return c.json({ error: { code: "unauthorized", message: "refresh rejected" } }, 401);
    }
    c.header(
      "Set-Cookie",
      refreshCookieHeader(result.refreshToken, 365 * 24 * 60 * 60, isSecureRequest(c, trustForwardedProto)),
    );
    return c.json({
      deviceId: result.deviceId,
      accessToken: result.accessToken,
      accessExpiresAt: result.accessExpiresAt,
    });
  });
}
