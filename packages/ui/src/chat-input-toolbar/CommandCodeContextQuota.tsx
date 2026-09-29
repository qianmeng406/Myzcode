import type { UsageQuotaLimit } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ChatCodingPlanUsageMeter } from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import { CodingPlanUsageHeaderAction } from "@/chat-input-toolbar/CodingPlanUsageHeaderAction.js";
import { CodingPlanUsageNotice } from "@/chat-input-toolbar/CodingPlanUsageNotice.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import {
  formatQuotaRemainingPercentage,
  formatQuotaResetTime,
  getQuotaRemainingPercentage,
} from "@/lib/codingPlanQuotaPresentation.js";
import type { GatewayQuotaStatus } from "@/settings/model-provider-section/useGatewayQuota.js";
import type {
  GatewayQuotaWindowId,
  GatewayQuotaWindowReading,
} from "@/settings/model-provider-section/gatewayQuota.js";

/**
 * Composer 剩余额度弹层里的 Command Code（网关）分区。
 *
 * 与 Start Plan 段同一形态：都是挂在 Coding Plan 段之外的独立来源，因此复用
 * `ChatCodingPlanUsageMeter` 的额度条外观，数值口径也保持「剩余占比」。
 *
 * 与 Coding Plan 段的差异（有意为之，不是遗漏）：
 * - 没有「重置额度」徽标与撒花：网关只暴露滚动窗口用量，没有可核销的重置次数接口；
 * - 五个小时窗口的重置时刻用 `adaptive`（当日显示 HH:mm，跨日显示日期），
 *   与官方五小时条一致。
 */

export interface ChatCommandCodeQuotaConfig {
  loading: boolean;
  /** 已映射的额度条，顺序与 `readings` 一一对应。 */
  limits: UsageQuotaLimit[];
  readings: GatewayQuotaWindowReading[];
  /** 区分「加载中 / 上游没给窗口 / 读取失败」，空读数时提示语不能一律说成无额度。 */
  status: GatewayQuotaStatus;
  /** hover 打开面板时发起的静默刷新（与 Coding Plan / Start Plan 段 onAccess 语义一致）。 */
  onAccess?: () => Promise<void> | void;
  onOpenDashboard?: () => void;
  /** hover 触发的本次刷新 promise 进行中；静默刷新不置 loading，spinner 需要跟随它。 */
  refreshing?: boolean;
  error?: string | null;
}

const WINDOW_LABEL_IDS: Record<GatewayQuotaWindowId, string> = {
  fiveHour: "sidebar.usage.plan.fiveHour",
  weekly: "sidebar.usage.plan.weekly",
  monthly: "sidebar.usage.plan.monthly",
};

/** 与 5 小时 / 周 / 月顺序一一对应，配色沿用官方额度条。 */
const WINDOW_COLORS: Record<GatewayQuotaWindowId, string> = {
  fiveHour: "var(--color-usage-chart-1)",
  weekly: "var(--color-usage-chart-2)",
  monthly: "var(--color-usage-chart-3)",
};

export function hasChatCommandCodeQuota(config: ChatCommandCodeQuotaConfig | undefined): boolean {
  if (!config) {
    return false;
  }
  // 与 Coding Plan / Start Plan 段一致：首次打开可能还没有读数，仍要保留触发器，
  // 否则用户没有 hover 入口发起第一次额度请求。
  return config.loading || config.limits.length > 0 || Boolean(config.onAccess);
}

export function ChatCommandCodeQuotaPanel({
  config,
  intl,
  locale,
  separated = false,
}: {
  config: ChatCommandCodeQuotaConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  separated?: boolean;
}) {
  const hasReadings = config.limits.length > 0;
  const busy = config.loading || config.refreshing === true;
  // 没有读数时不返回 null：本段的调用方只在渠道确实配了 key 时才挂载配置，
  // 因此空读数本身就是要告知用户的状态（加载中 / 上游没给窗口 / 读取失败），静默消失会被当成面板坏了。
  const noticeMessage =
    config.status === "loading"
      ? intl.formatMessage({ id: "settings.modelProvider.gatewayQuota.loading" })
      : config.status === "error"
        ? `${intl.formatMessage({
            id: "settings.modelProvider.gatewayQuota.error",
          })}${config.error ? ` · ${config.error}` : ""}`
        : intl.formatMessage({ id: "settings.modelProvider.gatewayQuota.unavailable" });

  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "sidebar.usage.plan.title" })}
          </span>
        </div>
        <CodingPlanUsageHeaderAction
          error={config.error}
          loading={busy}
          openLabel={intl.formatMessage({
            id: "settings.modelProvider.gatewayQuota.showDashboard",
          })}
          refreshingLabel={intl.formatMessage({ id: "sidebar.usage.plan.refreshing" })}
          updatedLabel={intl.formatMessage({ id: "sidebar.usage.plan.updated" })}
          warningLabel={
            config.error ? intl.formatMessage({ id: "sidebar.usage.plan.updateFailed" }) : undefined
          }
          onUsageClick={config.onOpenDashboard}
        />
      </div>
      <div className={cn("grid gap-2", getContextQuotaMeterGridClass(config.limits.length))}>
        {hasReadings ? (
          config.limits.map((limit, index) => {
            const reading = config.readings[index];
            if (!reading) {
              return null;
            }
            return (
              <ChatCodingPlanUsageMeter
                key={limit.type}
                color={WINDOW_COLORS[reading.id]}
                label={intl.formatMessage({ id: WINDOW_LABEL_IDS[reading.id] })}
                percentage={getQuotaRemainingPercentage(limit)}
                resetTime={formatQuotaResetTime({
                  locale,
                  value: limit.nextResetTime,
                  // 5 小时窗口跨日才有意义看日期；周/月只需日期。
                  format: reading.id === "fiveHour" ? "adaptive" : "date",
                })}
                value={formatQuotaRemainingPercentage(locale, limit)}
              />
            );
          })
        ) : (
          <CodingPlanUsageNotice
            message={noticeMessage}
            refreshLabel={intl.formatMessage({ id: "settings.modelProvider.gatewayQuota.refresh" })}
            onRefresh={config.onAccess}
          />
        )}
      </div>
    </div>
  );
}
