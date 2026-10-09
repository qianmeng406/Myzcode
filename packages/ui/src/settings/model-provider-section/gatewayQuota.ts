import type { UsageQuotaLimit } from "@zcode/shared";

/**
 * Command Code 渠道的额度数据层：**客户端直连上游**取数 + 额度映射。
 *
 * 额度来自上游的三条 alpha 接口（Bearer 鉴权，按调用方自己的 key 计额度）：
 * - `/alpha/billing/credits`：滚动窗口 `windowLimits.fiveHour` / `.weekly` 形如
 *   `{ used, cap, resetAt }`（`resetAt` 为纪元秒/毫秒，0 = 窗口未启动），以及
 *   `credits.monthlyCredits`（月额度**剩余**值）；
 * - `/alpha/usage/summary`：`totalCost`（本期已用），用来把「月剩余」还原成「月总额」；
 * - `/alpha/billing/subscriptions`：`currentPeriodEnd`（本期结束 = 月窗口重置点）。
 *
 * 这套聚合原先由自建反代网关的 `/v1/usage` 完成；现已内置到客户端，渠道地址直接用上游
 * 官方地址，额度也从上游直取，**不再依赖任何自建服务器**。
 *
 * 请求头只带 `Authorization`：上游 CORS 预检只放行 `Content-Type,Authorization`
 * （见 `commandCodeQuotaRequestInit` 注释），反代网关用的 `x-cli-environment` /
 * `x-command-code-version` 会被预检拒绝，因此不下发。
 */

/** 上游 API 根地址；官方文档给出的 Provider baseURL 为 `${COMMAND_CODE_API_BASE}/provider/v1`。 */
export const COMMAND_CODE_API_BASE = "https://api.commandcode.ai";

/** 渠道在 Provider 配置里使用的官方 baseUrl。 */
export const COMMAND_CODE_PROVIDER_BASE_URL = `${COMMAND_CODE_API_BASE}/provider/v1`;

/** 官方用量 / 密钥面板（Studio）；额度卡与弹层的「打开完整面板」都用它。 */
export const COMMAND_CODE_STUDIO_URL = "https://commandcode.ai/studio";

export type GatewayQuotaWindowId = "fiveHour" | "weekly" | "monthly";

/** 展示顺序与配色索引一一对应（5 小时 / 周 / 月）。 */
export const GATEWAY_QUOTA_WINDOW_IDS = ["fiveHour", "weekly", "monthly"] as const;

/** 合成 type 值：不复用 TOKENS_LIMIT / TIME_LIMIT，避免被 Coding Plan 的额度查询误命中。 */
export const GATEWAY_QUOTA_LIMIT_TYPES: Record<GatewayQuotaWindowId, string> = {
  fiveHour: "GATEWAY_FIVE_HOUR_LIMIT",
  weekly: "GATEWAY_WEEKLY_LIMIT",
  monthly: "GATEWAY_MONTHLY_LIMIT",
};

export interface GatewayQuotaWindow {
  used: number;
  total: number;
  remaining?: number;
  /** ISO 字符串或纪元时间戳；0/空表示窗口未启动。 */
  resetAt?: string | number | null;
}

export interface GatewayUsagePayload {
  limits?: Partial<Record<GatewayQuotaWindowId, GatewayQuotaWindow | null>> | null;
}

/**
 * 渠道地址是否就是上游官方地址。
 *
 * 只有指向上游的渠道才由本模块直连取额度：用户若把该渠道改指到别处（例如自建代理），
 * 上游额度就不再代表其真实用量，此时不查、只留空态，避免展示一份对不上的数字。
 */
export function isCommandCodeOfficialBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return false;
  }
  try {
    return new URL(trimmed).origin === new URL(COMMAND_CODE_API_BASE).origin;
  } catch {
    return false;
  }
}

/** 上游三条额度端点的完整地址。 */
export function resolveCommandCodeQuotaEndpoints(
  apiBase: string = COMMAND_CODE_API_BASE,
): { readonly credits: string; readonly summary: string; readonly subscription: string } {
  const root = apiBase.replace(/\/+$/, "");
  return {
    credits: `${root}/alpha/billing/credits`,
    summary: `${root}/alpha/usage/summary`,
    subscription: `${root}/alpha/billing/subscriptions`,
  };
}

/**
 * 额度请求参数。
 *
 * 只带 `Authorization`：上游对 `OPTIONS` 预检返回的 `Access-Control-Allow-Headers`
 * 仅含 `Content-Type,Authorization`，多带 `x-cli-*` 会让预检失败（真机实测），
 * 而这些头只是反代网关的遥测标记，取额度不需要。
 */
export function commandCodeQuotaRequestInit(apiKey: string): RequestInit {
  return {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  };
}

/** 官方用量面板地址。 */
export function resolveCommandCodeDashboardUrl(): string {
  return COMMAND_CODE_STUDIO_URL;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 上游重置时间 → ISO 字符串；0/空/不可解析统一为 null（窗口未启动时不显示成 1970 年）。 */
export function normalizeCommandCodeResetAt(value: unknown): string | null {
  const numeric = toFiniteNumber(value);
  if (numeric !== null) {
    if (numeric <= 0) {
      return null;
    }
    // 上游可能是纪元秒，也可能是毫秒；1e12 以下按秒处理。
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

/** 上游滚动窗口 → 统一窗口；`cap <= 0` 视为该窗口不存在。 */
function toRollingWindow(value: unknown): GatewayQuotaWindow | null {
  const window = asRecord(value);
  if (!window) {
    return null;
  }
  const total = toFiniteNumber(window["cap"]);
  if (total === null || total <= 0) {
    return null;
  }
  const used = toFiniteNumber(window["used"]) ?? 0;
  return {
    used,
    total,
    remaining: Math.max(0, total - used),
    resetAt: normalizeCommandCodeResetAt(window["resetAt"]),
  };
}

/** 月度周期结束时间：`{ data: { currentPeriodEnd } }` 或顶层 `currentPeriodEnd`。 */
function readSubscriptionPeriodEnd(subscription: Record<string, unknown> | null): unknown {
  if (!subscription) {
    return null;
  }
  const data = asRecord(subscription["data"]);
  return data?.["currentPeriodEnd"] ?? subscription["currentPeriodEnd"] ?? null;
}

export interface CommandCodeQuotaSource {
  /** `/alpha/billing/credits` 响应。 */
  readonly credits: unknown;
  /** `/alpha/usage/summary` 响应。 */
  readonly summary: unknown;
  /** `/alpha/billing/subscriptions` 响应；仅用于月窗口重置时间。 */
  readonly subscription: unknown;
}

/**
 * 上游三条响应 → `readGatewayQuotaWindows` 认识的 `{ limits }` 载荷。
 *
 * 三条全空（上游整体不可用）返回 null；月额度上游只给「剩余」，用本期已用
 * （`summary.totalCost`）还原总额，没有剩余值时该档不展示——不拿 0 冒充。
 */
export function buildCommandCodeQuotaPayload(
  source: CommandCodeQuotaSource,
): GatewayUsagePayload | null {
  const credits = asRecord(source.credits);
  const summary = asRecord(source.summary);
  const subscription = asRecord(source.subscription);
  if (!credits && !summary && !subscription) {
    return null;
  }

  const windows = asRecord(credits?.["windowLimits"]);
  const fiveHour = toRollingWindow(windows?.["fiveHour"]);
  const weekly = toRollingWindow(windows?.["weekly"]);

  const monthlyRemaining = toFiniteNumber(asRecord(credits?.["credits"])?.["monthlyCredits"]);
  const spent = toFiniteNumber(summary?.["totalCost"]) ?? 0;
  const monthly =
    monthlyRemaining !== null && monthlyRemaining >= 0
      ? {
          used: spent,
          total: monthlyRemaining + spent,
          remaining: monthlyRemaining,
          resetAt: normalizeCommandCodeResetAt(readSubscriptionPeriodEnd(subscription)),
        }
      : null;

  return { limits: { fiveHour, weekly, monthly } };
}

/**
 * `resetAt` 解析为毫秒时间戳；0 / 空 / 不可解析都表示「没有可展示的重置时刻」。
 */
export function parseGatewayResetAt(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readQuotaWindow(value: unknown): GatewayQuotaWindow | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const used = candidate.used;
  const total = candidate.total;
  if (typeof used !== "number" || !Number.isFinite(used)) {
    return null;
  }
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  const remaining = candidate.remaining;
  return {
    used,
    total,
    ...(typeof remaining === "number" && Number.isFinite(remaining) ? { remaining } : {}),
    resetAt:
      typeof candidate.resetAt === "string" || typeof candidate.resetAt === "number"
        ? candidate.resetAt
        : null,
  };
}

export interface GatewayQuotaWindowReading {
  id: GatewayQuotaWindowId;
  used: number;
  total: number;
  remaining: number;
  resetAtMs: number | null;
}

/** 抽出可展示的窗口；缺失或 `total <= 0` 的窗口直接跳过，不补 0 占位。 */
export function readGatewayQuotaWindows(payload: unknown): GatewayQuotaWindowReading[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const limits = (payload as GatewayUsagePayload).limits;
  if (!limits || typeof limits !== "object") {
    return [];
  }
  const readings: GatewayQuotaWindowReading[] = [];
  for (const id of GATEWAY_QUOTA_WINDOW_IDS) {
    const window = readQuotaWindow(limits[id]);
    if (!window) {
      continue;
    }
    const remaining =
      typeof window.remaining === "number"
        ? window.remaining
        : Math.max(0, window.total - window.used);
    readings.push({
      id,
      used: window.used,
      total: window.total,
      remaining,
      resetAtMs: parseGatewayResetAt(window.resetAt),
    });
  }
  return readings;
}

/**
 * 映射成 Coding Plan 卡片共用的 `UsageQuotaLimit`。
 *
 * `percentage` 按该类型的既有语义填**已用百分比**：Plan Card 是「剩余额度」视图，
 * 渲染时会自行反转（见 StatusCards 的 resolveLimitRemainingPercentage），这里不能预先反转，
 * 否则进度条方向会反。`usageDetails` 留空数组，避免渲染出并不存在的模型明细。
 */
export function mapGatewayQuotaWindowsToQuotaLimits(
  readings: readonly GatewayQuotaWindowReading[],
): UsageQuotaLimit[] {
  return readings.map((reading) => ({
    type: GATEWAY_QUOTA_LIMIT_TYPES[reading.id],
    usage: reading.used,
    remaining: reading.remaining,
    number: reading.total,
    unit: 1,
    percentage: Math.max(0, Math.min(100, (reading.used / reading.total) * 100)),
    ...(reading.resetAtMs === null ? {} : { nextResetTime: reading.resetAtMs }),
    usageDetails: [],
  }));
}
