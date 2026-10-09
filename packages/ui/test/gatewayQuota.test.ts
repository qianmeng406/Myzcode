import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMAND_CODE_API_BASE,
  COMMAND_CODE_PROVIDER_BASE_URL,
  COMMAND_CODE_STUDIO_URL,
  GATEWAY_QUOTA_LIMIT_TYPES,
  buildCommandCodeQuotaPayload,
  commandCodeQuotaRequestInit,
  isCommandCodeOfficialBaseUrl,
  mapGatewayQuotaWindowsToQuotaLimits,
  normalizeCommandCodeResetAt,
  parseGatewayResetAt,
  readGatewayQuotaWindows,
  resolveCommandCodeDashboardUrl,
  resolveCommandCodeQuotaEndpoints,
} from "../src/settings/model-provider-section/gatewayQuota.js";

/**
 * 抓样：上游三条 alpha 接口的实测字段形态（与自建反代网关 `/v1/usage` 聚合成的一样）。
 * - `credits`：`windowLimits.fiveHour/.weekly = { used, cap, resetAt }`（resetAt 纪元秒/毫秒）
 *   与 `credits.monthlyCredits`（月**剩余**）；
 * - `summary`：`totalCost`（本期已用）；
 * - `subscription`：`data.currentPeriodEnd`（月窗口重置点，ISO）。
 */
const CREDITS = {
  credits: { monthlyCredits: 10.7215478984 },
  windowLimits: {
    // 纪元**秒**（上游两种单位都可能出现，这里各覆盖一种）。
    fiveHour: { used: 0.632298758, cap: 14, resetAt: 1791234000 },
    // 纪元**毫秒**。
    weekly: { used: 0.673454677, cap: 35, resetAt: 1791752400000 },
  },
};
const SUMMARY = { totalCost: 69.2784521016 };
const SUBSCRIPTION = { data: { currentPeriodEnd: "2026-10-11T06:23:57.000Z" } };

test("渠道与额度都指向上游官方地址，不含任何自建服务器地址", () => {
  assert.equal(COMMAND_CODE_API_BASE, "https://api.commandcode.ai");
  assert.equal(COMMAND_CODE_PROVIDER_BASE_URL, "https://api.commandcode.ai/provider/v1");
  assert.equal(COMMAND_CODE_STUDIO_URL, "https://commandcode.ai/studio");
  assert.equal(resolveCommandCodeDashboardUrl(), "https://commandcode.ai/studio");
});

test("resolveCommandCodeQuotaEndpoints 给出同源的三条 alpha 额度接口", () => {
  assert.deepEqual(resolveCommandCodeQuotaEndpoints(), {
    credits: "https://api.commandcode.ai/alpha/billing/credits",
    summary: "https://api.commandcode.ai/alpha/usage/summary",
    subscription: "https://api.commandcode.ai/alpha/billing/subscriptions",
  });
  // 末尾斜杠不应改变结果。
  assert.deepEqual(resolveCommandCodeQuotaEndpoints("https://api.commandcode.ai/"), {
    credits: "https://api.commandcode.ai/alpha/billing/credits",
    summary: "https://api.commandcode.ai/alpha/usage/summary",
    subscription: "https://api.commandcode.ai/alpha/billing/subscriptions",
  });
});

test("额度请求只带 Authorization——上游 CORS 预检不放行 x-cli-* 头", () => {
  const init = commandCodeQuotaRequestInit("sk-test-key");
  assert.equal(init.method, "GET");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer sk-test-key");
  // 反代网关用的遥测头会被上游预检拒绝，必须不下发，否则浏览器/渲染进程直接请求失败。
  assert.equal("x-cli-environment" in headers, false);
  assert.equal("x-command-code-version" in headers, false);
});

test("isCommandCodeOfficialBaseUrl 只认上游同源地址", () => {
  assert.equal(isCommandCodeOfficialBaseUrl("https://api.commandcode.ai/provider/v1"), true);
  assert.equal(isCommandCodeOfficialBaseUrl("https://api.commandcode.ai"), true);
  assert.equal(isCommandCodeOfficialBaseUrl("  https://api.commandcode.ai/provider/v1  "), true);
  // 自建代理、其它上游、空值与不可解析地址一律不认，避免展示对不上的额度。
  assert.equal(isCommandCodeOfficialBaseUrl("http://proxy.example.test:3050/v1"), false);
  assert.equal(isCommandCodeOfficialBaseUrl("https://gw.example.com/provider/v1"), false);
  assert.equal(isCommandCodeOfficialBaseUrl(""), false);
  assert.equal(isCommandCodeOfficialBaseUrl("not a url"), false);
});

test("normalizeCommandCodeResetAt 统一纪元秒/毫秒/ISO，0 表示窗口未启动", () => {
  assert.equal(normalizeCommandCodeResetAt(1791234000), new Date(1791234000 * 1000).toISOString());
  assert.equal(normalizeCommandCodeResetAt(1791752400000), new Date(1791752400000).toISOString());
  assert.equal(
    normalizeCommandCodeResetAt("2026-10-11T06:23:57.000Z"),
    "2026-10-11T06:23:57.000Z",
  );
  // 0 / 空 / 不可解析都表示"没有可展示的重置时刻"，不能显示成 1970 年。
  assert.equal(normalizeCommandCodeResetAt(0), null);
  assert.equal(normalizeCommandCodeResetAt(null), null);
  assert.equal(normalizeCommandCodeResetAt("nope"), null);
});

test("buildCommandCodeQuotaPayload 把上游三响应合成 limits，月额度按已用还原总额", () => {
  const payload = buildCommandCodeQuotaPayload({
    credits: CREDITS,
    summary: SUMMARY,
    subscription: SUBSCRIPTION,
  });
  assert.deepEqual(payload, {
    limits: {
      fiveHour: {
        used: 0.632298758,
        total: 14,
        remaining: 13.367701242,
        resetAt: new Date(1791234000 * 1000).toISOString(),
      },
      weekly: {
        used: 0.673454677,
        total: 35,
        remaining: 34.326545323,
        resetAt: new Date(1791752400000).toISOString(),
      },
      // 月额度上游只给"剩余"，用 summary.totalCost 还原总额：10.7215478984 + 69.2784521016。
      monthly: {
        used: 69.2784521016,
        total: 80,
        remaining: 10.7215478984,
        resetAt: "2026-10-11T06:23:57.000Z",
      },
    },
  });
});

test("buildCommandCodeQuotaPayload 不拿 0 冒充缺失档位", () => {
  const payload = buildCommandCodeQuotaPayload({
    credits: { credits: {}, windowLimits: { fiveHour: { used: 1, cap: 0, resetAt: 0 } } },
    summary: {},
    subscription: null,
  });
  // cap<=0 的窗口视作不存在；月剩余缺失时月档也不展示，只留下结构里的 null。
  assert.deepEqual(payload, { limits: { fiveHour: null, weekly: null, monthly: null } });
  assert.deepEqual(readGatewayQuotaWindows(payload), []);
});

test("buildCommandCodeQuotaPayload 在三条响应全空时返回 null", () => {
  assert.equal(
    buildCommandCodeQuotaPayload({ credits: null, summary: null, subscription: null }),
    null,
  );
});

test("合成载荷经 readGatewayQuotaWindows 得到 5小时/周/月三档读数", () => {
  const readings = readGatewayQuotaWindows(
    buildCommandCodeQuotaPayload({
      credits: CREDITS,
      summary: SUMMARY,
      subscription: SUBSCRIPTION,
    }),
  );
  assert.deepEqual(
    readings.map((reading) => reading.id),
    ["fiveHour", "weekly", "monthly"],
  );
  assert.equal(readings[0]?.total, 14);
  assert.equal(readings[1]?.total, 35);
  assert.equal(readings[2]?.total, 80);
  assert.equal(readings[2]?.resetAtMs, Date.parse("2026-10-11T06:23:57.000Z"));
});

test("mapGatewayQuotaWindowsToQuotaLimits 填已用百分比并映射到合成 type", () => {
  const readings = readGatewayQuotaWindows(
    buildCommandCodeQuotaPayload({
      credits: CREDITS,
      summary: SUMMARY,
      subscription: SUBSCRIPTION,
    }),
  );
  const limits = mapGatewayQuotaWindowsToQuotaLimits(readings);
  assert.equal(limits.length, 3);
  assert.equal(limits[0]?.type, GATEWAY_QUOTA_LIMIT_TYPES.fiveHour);
  assert.equal(limits[1]?.type, GATEWAY_QUOTA_LIMIT_TYPES.weekly);
  assert.equal(limits[2]?.type, GATEWAY_QUOTA_LIMIT_TYPES.monthly);
  // usage=已用、number=总额、remaining=剩余；percentage 是已用百分比（渲染时自行反转）。
  assert.equal(limits[0]?.usage, 0.632298758);
  assert.equal(limits[0]?.number, 14);
  assert.equal(limits[0]?.remaining, 13.367701242);
  assert.equal(limits[0]?.percentage, (0.632298758 / 14) * 100);
  assert.equal(limits[0]?.usageDetails.length, 0);
});

test("parseGatewayResetAt 拒绝 0 与不可解析值", () => {
  assert.equal(parseGatewayResetAt(0), null);
  assert.equal(parseGatewayResetAt(null), null);
  assert.equal(parseGatewayResetAt(""), null);
  assert.equal(parseGatewayResetAt("nope"), null);
  assert.equal(parseGatewayResetAt("2026-10-11T06:23:57.000Z"), Date.parse("2026-10-11T06:23:57.000Z"));
  assert.equal(parseGatewayResetAt(1791752400000), 1791752400000);
});
