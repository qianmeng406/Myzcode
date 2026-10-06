// gateway HTTP/WS 装配（Hono + @hono/node-ws）：pairing/refresh 端点、
// 三类 WS 升级（mobile/node/relay）与 owner 管理端口。
// 生产部署要求置于 TLS 反代之后；此处只保证应用层鉴权与帧限制。
import { Hono, type Context } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import type {
  CompanionGatewayHandle,
  CompanionGatewayOptions,
  CompanionOwnerPort,
} from "../contract.js";
import { COMPANION_GATEWAY_DEFAULTS } from "../app/ports.js";
import { CompanionHub } from "../app/hub.js";
import { CompanionPairingService } from "../app/pairing.js";
import { NodeSecretBox, systemClock } from "./secrets.js";
import { SqliteControlStore } from "./sqliteControlStore.js";
import { attachRelaySocket, createMobileLink, createNodeLink } from "./wsLinks.js";

const REFRESH_COOKIE = "zc_comp_rt";
const FIRST_AUTH_TIMEOUT_MS = 10_000;
/** CSRF 防线：跨站表单无法携带自定义头；POST 控制端点必须携带（spec §6）。 */
const COMPANION_CSRF_HEADER = "x-zcode-companion";
const COMPANION_CSRF_VALUE = "my-zcode";

function consoleLogger(level: "info" | "warn" | "error") {
  return (message: string, details?: Record<string, unknown>): void => {
    const line = details ? `${message} ${JSON.stringify(details)}` : message;
    if (level === "error") console.error(`[companion] ${line}`);
    else if (level === "warn") console.warn(`[companion] ${line}`);
    else console.log(`[companion] ${line}`);
  };
}

function buildOriginChecker(allowedOrigins: string[]): (origin: string | undefined) => boolean {
  const normalized = allowedOrigins.map((origin) => origin.replace(/\/+$/, ""));
  return (origin) => {
    if (origin === undefined) return true; // 非浏览器客户端不携带 Origin
    return normalized.includes(origin.replace(/\/+$/, ""));
  };
}

function refreshCookieHeader(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${REFRESH_COOKIE}=${encodeURIComponent(token)}; Path=/companion; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export async function startCompanionGatewayServer(
  options: CompanionGatewayOptions,
): Promise<CompanionGatewayHandle> {
  const logger = options.logger ?? {
    info: consoleLogger("info"),
    warn: consoleLogger("warn"),
    error: consoleLogger("error"),
  };
  const store = new SqliteControlStore(options.controlDbPath);
  const secrets = new NodeSecretBox();
  const defaults = {
    ...COMPANION_GATEWAY_DEFAULTS,
    ...(options.maxAttachments !== undefined ? { maxAttachments: options.maxAttachments } : {}),
    ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
  };
  const hub = new CompanionHub({ store, clock: systemClock, secrets, defaults, logger });
  const pairing = new CompanionPairingService({ store, secrets, clock: systemClock, logger });
  const originAllowed = buildOriginChecker(options.allowedOrigins ?? []);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.use("/companion/*", async (c, next) => {
    if (!originAllowed(c.req.header("origin"))) {
      return c.json({ error: { code: "unauthorized", message: "origin not allowed" } }, 403);
    }
    await next();
  });

  // 写端点 CSRF 防线：Origin 白名单之外，再要求自定义头（跨站表单发不出自定义头）。
  const requireCsrf = async (c: Context, next: () => Promise<void>): Promise<Response | undefined> => {
    if (c.req.header(COMPANION_CSRF_HEADER) !== COMPANION_CSRF_VALUE) {
      return c.json(
        { error: { code: "unauthorized", message: "missing X-ZCode-Companion header" } },
        403,
      );
    }
    await next();
    return undefined;
  };

  app.post("/companion/pair", requireCsrf, async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { deviceName?: unknown; code?: unknown }
      | null;
    if (typeof body?.deviceName !== "string" || typeof body?.code !== "string") {
      return c.json({ error: { code: "bad_request", message: "deviceName and code required" } }, 400);
    }
    try {
      const result = await pairing.pairDevice(body.deviceName, body.code);
      const secure = new URL(c.req.url).protocol === "https:";
      c.header(
        "Set-Cookie",
        refreshCookieHeader(result.refreshToken, 365 * 24 * 60 * 60, secure),
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
    const secure = new URL(c.req.url).protocol === "https:";
    c.header("Set-Cookie", refreshCookieHeader(result.refreshToken, 365 * 24 * 60 * 60, secure));
    return c.json({
      deviceId: result.deviceId,
      accessToken: result.accessToken,
      accessExpiresAt: result.accessExpiresAt,
    });
  });

  // 手机控制面 WS：首帧 = {op:"auth", params:{accessToken}}，失败即关闭。
  app.get(
    "/companion/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        const raw = ws.raw as WebSocket;
        wireFirstFrameAuth(raw, async (params) => {
          const token = readAuthAccessToken(params);
          if (!token) return null;
          return pairing.authenticateAccessToken(token);
        }).then((deviceId) => {
          if (!deviceId) {
            raw.close(4401, "unauthorized");
            return;
          }
          hub.handleMobileOpened(createMobileLink({ ws: raw, deviceId, hub, logger }));
        });
      },
    })),
  );

  // 节点连接器 WS：首帧 = {op:"auth", params:{nodeToken}}；身份取自服务端登记，不采信客户端声明。
  app.get(
    "/companion/node",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        const raw = ws.raw as WebSocket;
        wireFirstFrameAuth(raw, async (params) => {
          const nodeToken = readNodeToken(params);
          if (!nodeToken) return null;
          const fingerprint = secrets.sha256Hex(nodeToken);
          const nodes = await store.listNodes();
          const hit = nodes.find((node) => node.tokenFingerprint === fingerprint && node.revokedAt === undefined);
          return hit?.nodeId ?? null;
        }).then((nodeId) => {
          if (!nodeId) {
            raw.close(4401, "unauthorized");
            return;
          }
          void (async () => {
            const record = await store.getNode(nodeId);
            if (!record) {
              raw.close(4401, "unauthorized");
              return;
            }
            // 先建链路适配，再走 hub 的 hello（含撤销校验与同节点旧连接接管）。
            const link = createNodeLink({ ws: raw, nodeId, hub, logger });
            const hello = await hub.handleNodeHello(link, {
              nodeId,
              displayName: record.displayName,
              kind: record.kind,
            });
            if (!hello.ok) {
              raw.close(4402, hello.message);
              return;
            }
          })().catch(() => raw.close(4500, "node registration failed"));
        });
      },
    })),
  );

  // 数据面 relay：首个文本帧 = 各自的一次性 capability；hub 按归属推导 side 后进入字节透传。
  app.get(
    "/companion/relay/:attachmentId",
    upgradeWebSocket((c) => {
      const attachmentId = c.req.param("attachmentId") ?? "";
      return {
        onOpen(_event, ws) {
          attachRelaySocket({ ws: ws.raw as WebSocket, attachmentId, hub });
        },
      };
    }),
  );

  const server: ServerType = serve(
    { fetch: app.fetch, port: options.port ?? 0, hostname: options.host ?? "0.0.0.0" },
    () => undefined,
  );
  injectWebSocket(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : (options.port ?? 0);
  logger.info("companion gateway listening", { port });

  const owner: CompanionOwnerPort = {
    createPairingCode: () => pairing.createPairingCode(),
    pairDevice: async (deviceName, code) => {
      const result = await pairing.pairDevice(deviceName, code);
      return {
        deviceId: result.device.deviceId,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        accessExpiresAt: result.accessExpiresAt,
      };
    },
    listDevices: () => store.listDevices(),
    revokeDevice: (deviceId) => {
      hub.closeDeviceConnections(deviceId);
      return pairing.revokeDevice(deviceId);
    },
    registerNode: async ({ nodeId, displayName, kind }) => {
      const token = secrets.randomToken(32);
      await store.saveNode({
        nodeId,
        kind,
        displayName,
        tokenFingerprint: secrets.sha256Hex(token),
        createdAt: systemClock.now(),
      });
      return { nodeId, token };
    },
    revokeNode: async (nodeId) => {
      const record = await store.getNode(nodeId);
      if (!record || record.revokedAt !== undefined) return false;
      await store.saveNode({ ...record, revokedAt: systemClock.now() });
      return true;
    },
  };

  return {
    port,
    owner,
    stop: async () => {
      hub.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
  };
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

type AuthParams = unknown;

function readAuthAccessToken(params: AuthParams): string | null {
  const token = (params as { accessToken?: unknown } | null)?.accessToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function readNodeToken(params: AuthParams): string | null {
  const token = (params as { nodeToken?: unknown } | null)?.nodeToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** 首帧鉴权通用形态：等第一条文本帧 {op:"auth"}，成功回 {id,ok:true} 显式回执；
 * 失败回执错误码并断开。显式回执消除「客户端 auth 后立刻发请求」的丢帧竞态。 */
function wireFirstFrameAuth(
  ws: WebSocket,
  authenticate: (params: unknown) => Promise<string | null>,
): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(null), FIRST_AUTH_TIMEOUT_MS);
    const finish = (value: string | null, frameId?: string): void => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      if (frameId !== undefined) {
        try {
          ws.send(
            JSON.stringify(
              value
                ? { v: 1, id: frameId, ok: true }
                : { v: 1, id: frameId, ok: false, error: { code: "unauthorized", message: "auth rejected" } },
            ),
          );
        } catch {
          // 连接已关闭时回执失败可忽略。
        }
      }
      resolve(value);
    };
    const onMessage = (data: unknown, isBinary: boolean): void => {
      if (isBinary) return;
      const text = String(data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        finish(null);
        return;
      }
      const record = parsed as { id?: unknown; op?: unknown };
      const frameId = typeof record.id === "string" ? record.id : "auth";
      if (record.op !== "auth") {
        finish(null);
        return;
      }
      const params = (parsed as { params?: unknown }).params;
      void authenticate(params).then((value) => finish(value, frameId));
    };
    ws.on("message", onMessage);
  });
}
