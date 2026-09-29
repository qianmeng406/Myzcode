import assert from "node:assert/strict";
import test from "node:test";
import {
  GATEWAY_QUOTA_LIMIT_TYPES,
  mapGatewayQuotaWindowsToQuotaLimits,
  parseGatewayResetAt,
  readGatewayQuotaWindows,
  resolveGatewayDashboardUrl,
  resolveGatewayUsageUrl,
} from "../src/settings/model-provider-section/gatewayQuota.js";

/**
 * 真实抓样：2026-09-29 对网关 `GET /v1/usage`（Bearer 该渠道的 key）的实测响应，
 * 原样保留字段形态——usage summary 在**顶层**、额度窗口挂在顶层 `limits`，
 * 且 `resetAt` 是 ISO 字符串。
 */
const REAL_PAYLOAD = {
  totalCount: 23450,
  totalCost: 69.2784521016,
  averageCost: 0.0029543049936716415,
  successRate: 100,
  completedCount: 23450,
  failedCount: 0,
  totalTokensIn: 7097226765,
  totalTokensOut: 16186614,
  totalTokens: 7113413379,
  totalCredits: 69.2784521016,
  totalFreeCredits: 0,
  totalMonthlyCredits: 69.2784521016,
  totalPurchasedCredits: 0,
  periodBasis: "billing-period",
  limits: {
    fiveHour: {
      used: 0.632298758,
      total: 14,
      remaining: 13.367701242,
      resetAt: "2026-09-29T06:52:20.430Z",
    },
    weekly: {
      used: 0.673454677,
      total: 35,
      remaining: 34.326545323,
      resetAt: "2026-10-05T06:07:56.778Z",
    },
    monthly: {
      used: 69.2784521016,
      total: 70,
      remaining: 0.7215478984,
      resetAt: "2026-10-11T06:23:57.000Z",
    },
    monthlyRemaining: 0.7215478984,
    planPeriodEnd: "2026-10-11T06:23:57.000Z",
  },
};

test("resolveGatewayUsageUrl 剥掉 /v1 后缀并挂到同一 origin 的 /v1/usage", () => {
  assert.equal(
    resolveGatewayUsageUrl("http://47.101.52.182:3050/v1"),
    "http://47.101.52.182:3050/v1/usage",
  );
  // 不带 /v1 的写法必须得到同一个地址，否则同一个网关会因写法不同而查不到额度。
  assert.equal(
    resolveGatewayUsageUrl("http://47.101.52.182:3050"),
    "http://47.101.52.182:3050/v1/usage",
  );
  assert.equal(
    resolveGatewayUsageUrl("http://127.0.0.1:9933/v1/"),
    "http://127.0.0.1:9933/v1/usage",
  );
  assert.equal(
    resolveGatewayUsageUrl("https://gw.example.com/V1"),
    "https://gw.example.com/v1/usage",
  );
  // 非 /v1 的路径前缀原样保留，不猜业务路由。
  assert.equal(
    resolveGatewayUsageUrl("https://gw.example.com/gateway/v1"),
    "https://gw.example.com/gateway/v1/usage",
  );
});

test("resolveGatewayUsageUrl 拒绝非 http(s) 与不可解析地址", () => {
  assert.equal(resolveGatewayUsageUrl(""), null);
  assert.equal(resolveGatewayUsageUrl("   "), null);
  assert.equal(resolveGatewayUsageUrl("ftp://gw.example.com"), null);
  assert.equal(resolveGatewayUsageUrl("not a url"), null);
  assert.equal(resolveGatewayUsageUrl("file:///tmp/x"), null);
});

test("resolveGatewayDashboardUrl 指向同一 origin 的 /dashboard", () => {
  assert.equal(
    resolveGatewayDashboardUrl("http://47.101.52.182:3050/v1"),
    "http://47.101.52.182:3050/dashboard",
  );
  assert.equal(resolveGatewayDashboardUrl("nope"), null);
});

test("parseGatewayResetAt 把 ISO 解析成毫秒，0 与非法值归为无重置时刻", () => {
  assert.equal(
    parseGatewayResetAt("2026-09-29T06:52:20.430Z"),
    Date.parse("2026-09-29T06:52:20.430Z"),
  );
  assert.equal(parseGatewayResetAt(1790664740430), 1790664740430);
  // 窗口未启动：网关返回 0，不能显示成 1970。
  assert.equal(parseGatewayResetAt(0), null);
  assert.equal(parseGatewayResetAt(""), null);
  assert.equal(parseGatewayResetAt(null), null);
  assert.equal(parseGatewayResetAt(undefined), null);
  assert.equal(parseGatewayResetAt("not-a-date"), null);
});

test("readGatewayQuotaWindows 逐项读出顶层 limits 的真实数值", () => {
  const readings = readGatewayQuotaWindows(REAL_PAYLOAD);
  assert.deepEqual(
    readings.map((reading) => reading.id),
    ["fiveHour", "weekly", "monthly"],
  );
  const [fiveHour, weekly, monthly] = readings;
  assert.equal(fiveHour?.used, 0.632298758);
  assert.equal(fiveHour?.total, 14);
  assert.equal(fiveHour?.remaining, 13.367701242);
  assert.equal(fiveHour?.resetAtMs, Date.parse("2026-09-29T06:52:20.430Z"));
  assert.equal(weekly?.resetAtMs, Date.parse("2026-10-05T06:07:56.778Z"));
  assert.equal(monthly?.total, 70);
});

test("readGatewayQuotaWindows 不补占位：缺失/异常窗口一律跳过", () => {
  const partial = readGatewayQuotaWindows({
    limits: { weekly: { used: 1, total: 4, resetAt: 0 } },
  });
  assert.deepEqual(
    partial.map((reading) => reading.id),
    ["weekly"],
  );
  // remaining 缺失时按 total - used 推导；resetAt=0 归为无重置时刻。
  assert.equal(partial[0]?.remaining, 3);
  assert.equal(partial[0]?.resetAtMs, null);

  assert.deepEqual(readGatewayQuotaWindows({ limits: { fiveHour: { used: 0, total: 0 } } }), []);
  assert.deepEqual(readGatewayQuotaWindows({ limits: {} }), []);
  assert.deepEqual(readGatewayQuotaWindows({}), []);
  assert.deepEqual(readGatewayQuotaWindows(null), []);
  assert.deepEqual(readGatewayQuotaWindows("<html>nope</html>"), []);
  // 上游抖动时可能把窗口给成 null，不能抛错。
  assert.deepEqual(readGatewayQuotaWindows({ limits: { fiveHour: null, weekly: null } }), []);
});

test("mapGatewayQuotaWindowsToQuotaLimits 填已用百分比（反转由卡片层负责）", () => {
  const limits = mapGatewayQuotaWindowsToQuotaLimits(readGatewayQuotaWindows(REAL_PAYLOAD));
  assert.deepEqual(
    limits.map((limit) => limit.type),
    [
      GATEWAY_QUOTA_LIMIT_TYPES.fiveHour,
      GATEWAY_QUOTA_LIMIT_TYPES.weekly,
      GATEWAY_QUOTA_LIMIT_TYPES.monthly,
    ],
  );
  const fiveHour = limits[0]!;
  assert.equal(fiveHour.usage, 0.632298758);
  assert.equal(fiveHour.remaining, 13.367701242);
  assert.equal(fiveHour.number, 14);
  // 0.632 / 14 ≈ 4.5% 已用 —— 不能在这里写成 95.5%。
  assert.ok(Math.abs((fiveHour.percentage ?? 0) - 4.5164) < 0.001);
  assert.equal(fiveHour.nextResetTime, Date.parse("2026-09-29T06:52:20.430Z"));
  // 不编造模型明细，否则卡片会渲染出并不存在的模型名。
  assert.deepEqual(fiveHour.usageDetails, []);
  // 合成 type 不能撞上 Coding Plan 的额度类别，否则会被别的入口误命中。
  assert.notEqual(fiveHour.type, "TOKENS_LIMIT");
  assert.notEqual(fiveHour.type, "TIME_LIMIT");
});

test("map 对超限与无重置时刻的窗口保持可渲染", () => {
  const limits = mapGatewayQuotaWindowsToQuotaLimits([
    { id: "fiveHour", used: 20, total: 10, remaining: 0, resetAtMs: null },
  ]);
  assert.equal(limits[0]?.percentage, 100);
  assert.equal(limits[0]?.nextResetTime, undefined);
  assert.equal(limits[0]?.remaining, 0);
});
