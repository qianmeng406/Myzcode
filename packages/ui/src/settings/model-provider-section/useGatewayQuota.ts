import { useCallback, useEffect, useState } from "react";
import type { UsageQuotaLimit } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  buildCommandCodeQuotaPayload,
  commandCodeQuotaRequestInit,
  isCommandCodeOfficialBaseUrl,
  mapGatewayQuotaWindowsToQuotaLimits,
  readGatewayQuotaWindows,
  resolveCommandCodeQuotaEndpoints,
  type GatewayQuotaWindowReading,
} from "./gatewayQuota.js";

/**
 * 读取 Command Code 渠道的滚动窗口额度（**客户端直连上游**）。
 *
 * 用渠道自己填的 key 并行打上游三条 alpha 接口（Bearer），所以看到的就是该 key 所属账号
 * 的额度；没有 key、或渠道地址不是上游官方地址时不下发请求（`idle`），避免拿别的账号或
 * 已经改指到别处的渠道额度冒充当前值。
 *
 * 不做跨挂载缓存：渠道详情一次只挂一个，且响应里含账号额度，缓存收益小于「换 key 后看到
 * 旧额度」的风险。
 */

export type GatewayQuotaStatus = "idle" | "loading" | "ready" | "empty" | "error";

export interface GatewayQuotaView {
  status: GatewayQuotaStatus;
  readings: GatewayQuotaWindowReading[];
  limits: UsageQuotaLimit[];
  errorMessage: string | null;
  refresh: () => void;
}

/** 三条请求并行，客户端 5s 超时足够，且不会长时间吊住设置页。 */
const REQUEST_TIMEOUT_MS = 5000;

interface JsonFetchResult {
  readonly ok: boolean;
  readonly status: number;
  readonly data: unknown;
}

async function fetchJson(url: string, init: RequestInit, signal: AbortSignal): Promise<JsonFetchResult> {
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) {
    return { ok: false, status: response.status, data: null };
  }
  try {
    return { ok: true, status: response.status, data: await response.json() };
  } catch {
    // 200 但响应体不是 JSON：按上游异常处理，不把解析失败当成"没有额度"。
    return { ok: false, status: response.status, data: null };
  }
}

export function useGatewayQuota(options: { baseUrl: string; apiKey: string }): GatewayQuotaView {
  const { baseUrl, apiKey } = options;
  const [refreshToken, setRefreshToken] = useState(0);
  const [status, setStatus] = useState<GatewayQuotaStatus>("idle");
  const [readings, setReadings] = useState<GatewayQuotaWindowReading[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setRefreshToken((current) => current + 1);
  }, []);

  useEffect(() => {
    const key = apiKey.trim();
    if (!key || !isCommandCodeOfficialBaseUrl(baseUrl)) {
      setStatus("idle");
      setReadings([]);
      setErrorMessage(null);
      return;
    }

    const endpoints = resolveCommandCodeQuotaEndpoints();
    const init = commandCodeQuotaRequestInit(key);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    setStatus("loading");
    setErrorMessage(null);
    let cancelled = false;

    void (async () => {
      try {
        const [credits, summary, subscription] = await Promise.all([
          fetchJson(endpoints.credits, init, controller.signal),
          fetchJson(endpoints.summary, init, controller.signal),
          fetchJson(endpoints.subscription, init, controller.signal),
        ]);
        if (cancelled) {
          return;
        }
        // credits 给窗口、summary 给本期已用：缺任一条就还原不出可信额度，按错误态展示。
        // subscriptions 只影响月窗口重置时间，缺它时其余两档照常展示。
        if (!credits.ok || !summary.ok) {
          const failed = !credits.ok ? credits.status : summary.status;
          setStatus("error");
          setReadings([]);
          setErrorMessage(`HTTP ${failed}`);
          return;
        }
        const payload = buildCommandCodeQuotaPayload({
          credits: credits.data,
          summary: summary.data,
          subscription: subscription.ok ? subscription.data : null,
        });
        const nextReadings = readGatewayQuotaWindows(payload);
        // 上游这次没给出窗口（billing 抖动或该账号确实无额度）时按空态展示，
        // 不隐藏卡片——渠道是用户自己指定的，空态比静默消失更容易判断问题。
        setReadings(nextReadings);
        setStatus(nextReadings.length > 0 ? "ready" : "empty");
      } catch (error) {
        if (cancelled) {
          return;
        }
        // 请求被中止只可能来自卸载或超时；两者都不该把旧额度留在界面上。
        if (error instanceof Error && error.name === "AbortError") {
          setStatus("error");
          setReadings([]);
          setErrorMessage("Request timed out");
          return;
        }
        logger.info(`[command-code-quota] 读取额度失败 base=${baseUrl} error=${String(error)}`);
        setStatus("error");
        setReadings([]);
        setErrorMessage(error instanceof Error ? error.message : String(error));
      } finally {
        window.clearTimeout(timer);
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [apiKey, baseUrl, refreshToken]);

  return {
    status,
    readings,
    // 刷新期间保留上一次读数：hover 触发的静默刷新不应该把进度条清空再重填。
    // 失败/空态两条路径已经清掉 readings，所以这里不会把过期额度当成当前值。
    limits: readings.length > 0 ? mapGatewayQuotaWindowsToQuotaLimits(readings) : [],
    errorMessage,
    refresh,
  };
}
