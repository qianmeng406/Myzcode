import { useMemo, useState } from "react";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleHelpIcon,
  Loader2Icon,
  OctagonAlertIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ORACLE_REVIEW_REQUEST_TIMEOUT_MS, buildOracleFixPrompt } from "./oracleReviewSupport.js";
import type { OracleReviewFailure, OracleReviewState } from "./useOracleReview.js";

/** 等待超过该秒数后在 pending 卡片上提示「渠道响应慢，可换把关模型」。 */
const SLOW_REVIEW_HINT_SECONDS = 120;

/**
 * Oracle 审查结果横幅：挂在输入框上方（与 ChatErrorBanner 同层）。
 * pending 展示审查中；result 展示裁决 + 摘要 + 可折叠的问题清单与一键修复；
 * error 展示失败原因与重试。全部状态都不阻塞输入。
 */

const VERDICT_PRESETS = {
  pass: {
    icon: CheckCircle2Icon,
    labelKey: "chat.oracleReview.verdict.pass",
    className: "border-[var(--color-success)]/40 bg-[var(--color-success)]/10",
    iconClassName: "text-[var(--color-success)]",
  },
  warn: {
    icon: TriangleAlertIcon,
    labelKey: "chat.oracleReview.verdict.warn",
    className: "border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10",
    iconClassName: "text-[var(--color-warning)]",
  },
  fail: {
    icon: OctagonAlertIcon,
    labelKey: "chat.oracleReview.verdict.fail",
    className: "border-[var(--color-destructive)]/40 bg-[var(--color-destructive)]/10",
    iconClassName: "text-[var(--color-destructive)]",
  },
  unknown: {
    icon: CircleHelpIcon,
    labelKey: "chat.oracleReview.verdict.unknown",
    className: "border-border bg-surface",
    iconClassName: "text-foreground-subtle",
  },
} as const;

function failureDetail(state: Extract<OracleReviewState, { status: "error" }>): {
  titleKey: string;
  detail?: string;
  /** i18n 插值（如超时分钟数），与代码常量共享，不在文案里硬编码时长。 */
  titleValues?: Record<string, string>;
} {
  const failure: OracleReviewFailure = state.failure;
  switch (failure.kind) {
    case "no-turn":
      return { titleKey: "chat.oracleReview.error.noTurn" };
    case "no-changes":
      return { titleKey: "chat.oracleReview.error.noChanges" };
    case "no-model":
      return { titleKey: "chat.oracleReview.error.noModel" };
    case "empty-response":
      return {
        titleKey: "chat.oracleReview.error.emptyResponse",
        detail: failure.finishReason,
      };
    case "timeout":
      return {
        titleKey: "chat.oracleReview.error.timeout",
        // 展示底层真实错误消息，误判或新场景下用户能看到实际原因。
        detail: failure.message,
        titleValues: {
          minutes: String(Math.round(ORACLE_REVIEW_REQUEST_TIMEOUT_MS / 60_000)),
        },
      };
    case "request":
      return {
        titleKey: "chat.oracleReview.error.request",
        detail: failure.message,
      };
    default: {
      // 穷举保护：新增 failure kind 而漏改本 switch 时在编译期之外再拦一道。
      const exhaustive: never = failure;
      throw new Error(`Unhandled oracle review failure: ${String(exhaustive)}`);
    }
  }
}

export function OracleReviewBanner({
  state,
  pendingElapsedSeconds = 0,
  onRereview,
  onDismiss,
  onFix,
}: {
  state: OracleReviewState;
  /** pending 已等待秒数（宿主每秒更新）；驱动时长跳动与慢渠道提示。 */
  pendingElapsedSeconds?: number;
  onRereview: () => void;
  onDismiss: () => void;
  onFix: (fixPrompt: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const [findingsOpen, setFindingsOpen] = useState(false);
  const pending = state.status === "pending";
  const result = state.status === "result" ? state : null;
  const verdictPreset = result ? VERDICT_PRESETS[result.verdict] : null;
  const findings = result?.findings ?? "";
  // 「无」这类占位结论不给修复按钮；只有可行动的问题清单才注入下一轮。
  const canFix =
    Boolean(result) &&
    result!.verdict !== "unknown" &&
    findings.length > 0 &&
    !/^(无|none)\s*。?$/i.test(findings);
  const fixPrompt = useMemo(
    () => (canFix ? buildOracleFixPrompt(findings) : ""),
    [canFix, findings],
  );

  if (state.status === "idle") return null;

  return (
    <div className="mb-6 w-full shrink-0">
      <div
        className={cn(
          "overflow-hidden rounded-xl border shadow-none",
          verdictPreset ? verdictPreset.className : "border-border bg-card",
        )}
        data-testid="v4-oracle-review-banner"
      >
        <div className="flex min-w-0 items-center gap-2 px-3 py-2.5">
          {state.status === "pending" ? (
            <>
              <Loader2Icon className="size-4 shrink-0 animate-spin text-foreground-subtle" />
              <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
                {intl.formatMessage(
                  { id: "chat.oracleReview.pending" },
                  {
                    model: state.modelLabel,
                    minutes: String(Math.floor(pendingElapsedSeconds / 60)),
                    seconds: String(pendingElapsedSeconds % 60).padStart(2, "0"),
                  },
                )}
              </span>
              {pendingElapsedSeconds >= SLOW_REVIEW_HINT_SECONDS ? (
                <span className="hidden shrink-0 text-ui-sm text-foreground-subtle md:inline">
                  {intl.formatMessage({ id: "chat.oracleReview.pendingSlow" })}
                </span>
              ) : null}
            </>
          ) : null}
          {state.status === "error"
            ? (() => {
                const detail = failureDetail(state);
                return (
                  <>
                    <OctagonAlertIcon className="size-4 shrink-0 text-foreground-subtle" />
                    <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
                      {intl.formatMessage({ id: detail.titleKey }, detail.titleValues)}
                      {detail.detail ? ` · ${detail.detail.slice(0, 160)}` : ""}
                    </span>
                    {state.modelLabel ? (
                      <span
                        className="hidden shrink-0 font-mono text-ui-xs text-foreground-subtle md:inline"
                        title={state.modelLabel}
                      >
                        {state.modelLabel}
                      </span>
                    ) : null}
                  </>
                );
              })()
            : null}
          {result && verdictPreset ? (
            <>
              <verdictPreset.icon className={cn("size-4 shrink-0", verdictPreset.iconClassName)} />
              <span
                className={cn("shrink-0 font-medium text-ui-base", verdictPreset.iconClassName)}
              >
                {intl.formatMessage({ id: verdictPreset.labelKey })}
              </span>
              <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
                {result.summary ||
                  intl.formatMessage({ id: "chat.oracleReview.verdict.unknownSummary" })}
              </span>
              <span
                className="hidden shrink-0 font-mono text-ui-xs text-foreground-subtle md:inline"
                title={result.modelLabel}
              >
                {result.modelLabel}
              </span>
            </>
          ) : null}
          <div className="flex shrink-0 items-center gap-0.5">
            {!pending ? (
              <>
                {canFix ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-ui-base"
                    data-testid="v4-oracle-review-fix"
                    onClick={() => onFix(fixPrompt)}
                  >
                    <WrenchIcon className="size-3.5" />
                    <span>{intl.formatMessage({ id: "chat.oracleReview.fix" })}</span>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-ui-base text-foreground-subtle"
                  onClick={onRereview}
                >
                  <RefreshCwIcon className="size-3.5" />
                  <span>{intl.formatMessage({ id: "chat.oracleReview.rereview" })}</span>
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-foreground-subtle"
              aria-label={intl.formatMessage({ id: "common.close" })}
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        </div>
        {result ? (
          <Collapsible open={findingsOpen} onOpenChange={setFindingsOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-1.5 border-t border-border/60 px-3 py-1.5 text-left text-ui-sm text-foreground-subtle transition-colors hover:text-foreground"
                aria-label={intl.formatMessage({ id: "chat.oracleReview.findingsToggle" })}
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0 transition-transform",
                    findingsOpen ? "rotate-90" : "rotate-0",
                  )}
                />
                <span>{intl.formatMessage({ id: "chat.oracleReview.findings" })}</span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words border-t border-border/60 px-3 py-2 font-mono text-ui-sm text-foreground">
                {findings || intl.formatMessage({ id: "chat.oracleReview.findingsEmpty" })}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </div>
  );
}
