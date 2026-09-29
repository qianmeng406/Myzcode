import type { UsageQuotaLimit } from "@zcode/shared";

/**
 * 「5 小时额度用完 → 弹窗 + 重置卡」的纯判定模型。
 *
 * 上游 1308 是 5 小时窗口的专用业务码（runtime 收到的原文即
 * 「已达到 5 小时的使用上限。您的限额将在 … 重置」）；其它额度类码（套餐过期、
 * 日额度、账号边界）不触发本弹窗，沿用既有额度横幅的行为。
 *
 * 判定拆成纯函数是为了可测：弹窗组件只负责把模型映射成 JSX。
 */

/** 5 小时窗口额度耗尽的业务码（1308）。 */
export const CODING_PLAN_FIVE_HOUR_LIMIT_BUSINESS_CODE = "1308";

export interface QuotaResetPromptEntryInput {
  opportunityCount: number;
  opportunityExpiresAt: number | null;
  processing: boolean;
  done: boolean;
}

export type QuotaResetPromptDismissReason =
  | "window-dismissed"
  | "already-reset"
  | "not-five-hour-limit";

export interface QuotaResetPromptModel {
  visible: boolean;
  dismissReason: QuotaResetPromptDismissReason | null;
  /** 5 小时窗口的去重键（重置时刻）；快照缺失时退化为 "unknown"。 */
  windowKey: string;
  /** 窗口重置时刻；快照缺失时为 null（界面就不显示重置时间）。 */
  resetAtMs: number | null;
  /** 服务端确认仍有可用重置卡时才允许点「使用重置卡」。 */
  canUseResetCard: boolean;
  opportunityCount: number;
  opportunityExpiresAt: number | null;
  processing: boolean;
}

/** 同一 5 小时窗口只弹一次； dismissed 集合由组件按 renderer 会话持有。 */
export function resolveCodingPlanQuotaResetPromptModel(params: {
  providerLimitedCode: string | null | undefined;
  fiveHourLimit: UsageQuotaLimit | null | undefined;
  entry: QuotaResetPromptEntryInput | null;
  dismissedWindowKeys: readonly string[];
}): QuotaResetPromptModel {
  if (params.providerLimitedCode !== CODING_PLAN_FIVE_HOUR_LIMIT_BUSINESS_CODE) {
    return invisible("not-five-hour-limit");
  }
  const resetAtMs =
    typeof params.fiveHourLimit?.nextResetTime === "number" &&
    Number.isFinite(params.fiveHourLimit.nextResetTime)
      ? params.fiveHourLimit.nextResetTime
      : null;
  const windowKey = resetAtMs === null ? "unknown" : String(resetAtMs);
  if (params.dismissedWindowKeys.includes(windowKey)) {
    return invisible("window-dismissed", { windowKey, resetAtMs });
  }
  const entry = params.entry;
  // entry.done（已拿到服务端 used_at）说明重置已生效，弹窗没有存在意义。
  if (entry?.done) {
    return invisible("already-reset", { windowKey, resetAtMs });
  }
  const opportunityCount = entry?.opportunityCount ?? 0;
  return {
    visible: true,
    dismissReason: null,
    windowKey,
    resetAtMs,
    canUseResetCard: opportunityCount > 0 && entry?.processing !== true,
    opportunityCount,
    opportunityExpiresAt: entry?.opportunityExpiresAt ?? null,
    processing: entry?.processing === true,
  };
}

function invisible(
  reason: QuotaResetPromptDismissReason,
  extra?: { windowKey: string; resetAtMs: number | null },
): QuotaResetPromptModel {
  return {
    visible: false,
    dismissReason: reason,
    windowKey: extra?.windowKey ?? "",
    resetAtMs: extra?.resetAtMs ?? null,
    canUseResetCard: false,
    opportunityCount: 0,
    opportunityExpiresAt: null,
    processing: false,
  };
}
