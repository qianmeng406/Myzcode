import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { requestEmbeddedBrowserOpen } from "@/lib/embeddedBrowserOpenBridge.js";
import {
  CODING_PLAN_USAGE_SUMMARY_COLORS,
  PlanStatusCardSurface,
  PlanUsageMetricCard,
} from "./StatusCards.js";
import { type GatewayQuotaWindowId, resolveGatewayDashboardUrl } from "./gatewayQuota.js";
import { useGatewayQuota } from "./useGatewayQuota.js";

/**
 * Command Code 渠道的额度卡片。
 *
 * 复用官方 Coding Plan 额度卡的叶子组件（外壳 + 额度条），因此配色、百分比反转、
 * 重置时间格式都与「模型设置」里其它套餐卡一致。
 *
 * 额度按**渠道自己填的 key**查询（网关 `/v1/usage` 的 Bearer 鉴权），所以多账号切换时
 * 不会串号；没填 key 前不发请求，只提示先填 Key。
 */

const WINDOW_LABEL_IDS: Record<GatewayQuotaWindowId, string> = {
  fiveHour: "settings.usage.entitlementFiveHourUsage",
  weekly: "settings.usage.entitlementWeeklyUsage",
  monthly: "settings.modelProvider.gatewayQuota.monthlyRemaining",
};

export function GatewayQuotaCard({ baseUrl, apiKey }: { baseUrl: string; apiKey: string }) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { status, readings, limits, errorMessage, refresh } = useGatewayQuota({ baseUrl, apiKey });
  const dashboardUrl = resolveGatewayDashboardUrl(baseUrl);

  const handleOpenDashboard = () => {
    if (!dashboardUrl) {
      return;
    }
    // 优先内置浏览器（面板带登录态，未登录时也能就地登录）；当前壳层没有 Browser 面板
    // 时退回系统浏览器，保证按钮在任何环境都有反馈。
    if (requestEmbeddedBrowserOpen(dashboardUrl)) {
      return;
    }
    platform.openExternal(dashboardUrl);
  };

  const usageContent =
    status === "ready" ? (
      <div className="space-y-2">
        <h4 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
        </h4>
        <div className="flex w-full gap-2 max-sm:flex-col">
          {readings.map((reading, index) => {
            const limit = limits[index];
            if (!limit) {
              return null;
            }
            return (
              <PlanUsageMetricCard
                key={reading.id}
                label={intl.formatMessage({ id: WINDOW_LABEL_IDS[reading.id] })}
                limit={limit}
                progressColor={
                  CODING_PLAN_USAGE_SUMMARY_COLORS[
                    index % CODING_PLAN_USAGE_SUMMARY_COLORS.length
                  ] ?? CODING_PLAN_USAGE_SUMMARY_COLORS[0]
                }
                // 5 小时窗口重置频繁，展示到时刻；周/月只需日期，与官方卡片一致。
                resetTimeFormat={reading.id === "fiveHour" ? "dateTime" : "date"}
              />
            );
          })}
        </div>
      </div>
    ) : (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 text-ui-base text-foreground-subtle">
          {status === "idle"
            ? intl.formatMessage({ id: "settings.modelProvider.gatewayQuota.needApiKey" })
            : status === "loading"
              ? intl.formatMessage({ id: "settings.modelProvider.gatewayQuota.loading" })
              : status === "empty"
                ? intl.formatMessage({ id: "settings.modelProvider.gatewayQuota.unavailable" })
                : `${intl.formatMessage({
                    id: "settings.modelProvider.gatewayQuota.error",
                  })}${errorMessage ? ` · ${errorMessage}` : ""}`}
        </span>
        {status === "error" || status === "empty" ? (
          <Button type="button" variant="ghost" size="sm" onClick={refresh}>
            {intl.formatMessage({ id: "settings.modelProvider.gatewayQuota.retry" })}
          </Button>
        ) : null}
      </div>
    );

  return (
    <PlanStatusCardSurface
      planTitle={intl.formatMessage({ id: "settings.modelProvider.gatewayQuota.title" })}
      statusMeta={
        <ControlHintTooltip
          standalone
          title={intl.formatMessage({ id: "settings.modelProvider.gatewayQuota.refresh" })}
        >
          <Button type="button" variant="ghost" size="icon-sm" onClick={refresh}>
            <RefreshCwIcon aria-hidden="true" />
          </Button>
        </ControlHintTooltip>
      }
      trailingAction={
        dashboardUrl ? (
          <Button type="button" variant="outline" size="lg" onClick={handleOpenDashboard}>
            <ExternalLinkIcon aria-hidden="true" />
            {intl.formatMessage({ id: "settings.modelProvider.gatewayQuota.openDashboard" })}
          </Button>
        ) : undefined
      }
      usageContent={usageContent}
    />
  );
}
