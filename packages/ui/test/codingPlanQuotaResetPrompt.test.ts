import assert from "node:assert/strict";
import test from "node:test";
import type { UsageQuotaLimit } from "@zcode/shared";
import {
  CODING_PLAN_FIVE_HOUR_LIMIT_BUSINESS_CODE,
  resolveCodingPlanQuotaResetPromptModel,
} from "../src/lib/codingPlanQuotaResetPrompt.js";

function fiveHourLimit(overrides: Partial<UsageQuotaLimit> = {}): UsageQuotaLimit {
  return {
    type: "TOKENS_LIMIT",
    usage: 14,
    remaining: 0,
    number: 14,
    unit: 1,
    percentage: 100,
    nextResetTime: 1_790_000_000_000,
    usageDetails: [],
    ...overrides,
  };
}

const ENTRY_AVAILABLE = {
  opportunityCount: 2,
  opportunityExpiresAt: 1_780_000_000_000,
  processing: false,
  done: false,
};

test("1308 with a five-hour window and a card shows the prompt", () => {
  const model = resolveCodingPlanQuotaResetPromptModel({
    providerLimitedCode: CODING_PLAN_FIVE_HOUR_LIMIT_BUSINESS_CODE,
    fiveHourLimit: fiveHourLimit(),
    entry: ENTRY_AVAILABLE,
    dismissedWindowKeys: [],
  });
  assert.equal(model.visible, true);
  assert.equal(model.canUseResetCard, true);
  assert.equal(model.windowKey, "1790000000000");
  assert.equal(model.resetAtMs, 1_790_000_000_000);
  assert.equal(model.opportunityCount, 2);
});

test("non-1308 codes never prompt (other banners keep their own behavior)", () => {
  for (const code of ["1309", "1310", "1320", null, undefined]) {
    const model = resolveCodingPlanQuotaResetPromptModel({
      providerLimitedCode: code,
      fiveHourLimit: fiveHourLimit(),
      entry: ENTRY_AVAILABLE,
      dismissedWindowKeys: [],
    });
    assert.equal(model.visible, false);
    assert.equal(model.dismissReason, "not-five-hour-limit");
  }
});

test("a dismissed window stays dismissed until the window rolls", () => {
  const model = resolveCodingPlanQuotaResetPromptModel({
    providerLimitedCode: CODING_PLAN_FIVE_HOUR_LIMIT_BUSINESS_CODE,
    fiveHourLimit: fiveHourLimit(),
    entry: ENTRY_AVAILABLE,
    dismissedWindowKeys: ["1790000000000"],
  });
  assert.equal(model.visible, false);
  assert.equal(model.dismissReason, "window-dismissed");

  // 窗口滚动（重置时刻变化）后是新的一集，重新允许提示。
  const nextWindow = resolveCodingPlanQuotaResetPromptModel({
    providerLimitedCode: CODING_PLAN_FIVE_HOUR_LIMIT_BUSINESS_CODE,
    fiveHourLimit: fiveHourLimit({ nextResetTime: 1_790_086_400_000 }),
    entry: ENTRY_AVAILABLE,
    dismissedWindowKeys: ["1790000000000"],
  });
  assert.equal(nextWindow.visible, true);
  assert.equal(nextWindow.windowKey, "1790086400000");
});

test("an already-effective reset hides the prompt even with an undismissed window", () => {
  const model = resolveCodingPlanQuotaResetPromptModel({
    providerLimitedCode: CODING_PLAN_FIVE_HOUR_LIMIT_BUSINESS_CODE,
    fiveHourLimit: fiveHourLimit(),
    entry: { ...ENTRY_AVAILABLE, done: true },
    dismissedWindowKeys: [],
  });
  assert.equal(model.visible, false);
  assert.equal(model.dismissReason, "already-reset");
});

test("exhausted quota without any reset card still prompts, without the action", () => {
  const model = resolveCodingPlanQuotaResetPromptModel({
    providerLimitedCode: CODING_PLAN_FIVE_HOUR_LIMIT_BUSINESS_CODE,
    fiveHourLimit: fiveHourLimit(),
    entry: { ...ENTRY_AVAILABLE, opportunityCount: 0 },
    dismissedWindowKeys: [],
  });
  assert.equal(model.visible, true);
  assert.equal(model.canUseResetCard, false);
  assert.equal(model.opportunityCount, 0);
});

test("a missing snapshot degrades to the unknown window key without crashing", () => {
  const model = resolveCodingPlanQuotaResetPromptModel({
    providerLimitedCode: CODING_PLAN_FIVE_HOUR_LIMIT_BUSINESS_CODE,
    fiveHourLimit: null,
    entry: ENTRY_AVAILABLE,
    dismissedWindowKeys: [],
  });
  assert.equal(model.visible, true);
  assert.equal(model.windowKey, "unknown");
  assert.equal(model.resetAtMs, null);
  assert.equal(model.canUseResetCard, true);
});
