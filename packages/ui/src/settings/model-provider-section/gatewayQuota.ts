import type { UsageQuotaLimit } from "@zcode/shared";

/**
 * Command Code 网关的额度数据层：地址推导与额度映射。
 *
 * 走 `/v1/usage`（Bearer 鉴权），而不是面板的 `/api/usage`：
 * - `/v1/usage` 按**调用方自己的 key** 计算额度，因此渠道里填哪个 key 就看哪个账号的额度，
 *   不需要网关预先收录该 key，也不需要面板访问密码；
 * - `/api/usage` 不带 key 时返回的是网关的「默认账户」，多账号场景下会串号。
 *
 * 响应形态：usage summary 的字段在**顶层**，滚动窗口额度挂在顶层 `limits`，
 * 每项形如 `{ used, total, remaining, resetAt }`，`resetAt` 为 ISO 字符串（0/空表示窗口未启动）。
 */

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
  /** ISO 字符串（实测网关返回该形态），也可能是数字时间戳。 */
  resetAt?: string | number | null;
}

export interface GatewayUsagePayload {
  limits?: Partial<Record<GatewayQuotaWindowId, GatewayQuotaWindow | null>> | null;
}

/** 供应商 Base URL → 去掉结尾 `/v1` 的网关根地址；非 http/https 或不可解析返回 null。 */
function resolveGatewayRootUrl(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return `${parsed.origin}${path}`;
}

/**
 * 按 key 鉴权的额度地址。供应商地址通常带 `/v1` 后缀，先剥掉再挂 `/v1/usage`，
 * 因此 `http://host:3050/v1` 与 `http://host:3050` 得到同一结果。
 */
export function resolveGatewayUsageUrl(baseUrl: string): string | null {
  const root = resolveGatewayRootUrl(baseUrl);
  return root ? `${root}/v1/usage` : null;
}

/** 网关面板的完整网页入口；「打开完整面板」按钮用它。 */
export function resolveGatewayDashboardUrl(baseUrl: string): string | null {
  const root = resolveGatewayRootUrl(baseUrl);
  return root ? `${root}/dashboard` : null;
}

/**
 * `resetAt` 解析为毫秒时间戳；0 / 空 / 不可解析都表示「没有可展示的重置时刻」。
 * 窗口未启动时网关会返回 0，此时不能显示成 1970 年。
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
