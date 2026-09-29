import { useCallback, useEffect, useState } from "react";
import type { UsageQuotaLimit } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  mapGatewayQuotaWindowsToQuotaLimits,
  readGatewayQuotaWindows,
  resolveGatewayUsageUrl,
  type GatewayQuotaWindowReading,
} from "./gatewayQuota.js";

/**
 * 读取 Command Code 网关的滚动窗口额度。
 *
 * 用渠道自己的 key 打 `/v1/usage`（Bearer），所以看到的就是该 key 所属账号的额度；
 * 没有 key 时不下发请求（`idle`），避免拿默认账户的额度冒充当前账号。
 *
 * 不做跨挂载缓存：渠道详情一次只挂一个，且响应里含账号额度，缓存收益小于「换 key 后看到旧额度」的风险。
 */

export type GatewayQuotaStatus = "idle" | "loading" | "ready" | "empty" | "error";

export interface GatewayQuotaView {
  status: GatewayQuotaStatus;
  readings: GatewayQuotaWindowReading[];
  limits: UsageQuotaLimit[];
  errorMessage: string | null;
  refresh: () => void;
}

/** 网关自身对上游有 30s 缓存；客户端 5s 超时足够，且不会长时间吊住设置页。 */
const REQUEST_TIMEOUT_MS = 5000;

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
    const url = resolveGatewayUsageUrl(baseUrl);
    if (!key || !url) {
      setStatus("idle");
      setReadings([]);
      setErrorMessage(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    setStatus("loading");
    setErrorMessage(null);
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
          signal: controller.signal,
        });
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          setStatus("error");
          setReadings([]);
          setErrorMessage(`HTTP ${response.status}`);
          return;
        }
        const payload: unknown = await response.json();
        if (cancelled) {
          return;
        }
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
        logger.info(`[gateway-quota] 读取额度失败 url=${url} error=${String(error)}`);
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
