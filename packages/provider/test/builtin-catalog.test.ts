import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  COMMAND_CODE_PROVIDER_GROUP,
  COMMAND_CODE_PROVIDER_ID,
} from "../../shared/src/model-provider-types.js";
import {
  parseZCodeBuiltinModelConfigRules,
  parseZCodeBuiltinProviderConfigRules,
} from "../src/config/schema.js";

/**
 * 内置 Provider Config 的回归护栏。
 *
 * 目录是打进安装包的资源（electron-builder 的 extraResources），解析失败会直接让模型设置页
 * 拿不到任何内置渠道；本测试用真实 schema 解析仓库里的目录，保证改动不会悄悄破坏它。
 */

const catalog = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../config/provider/zcode-builtin.json"), "utf-8"),
) as {
  schemaVersion: number;
  revision: number;
  config: { providerConfigRules: unknown; modelConfigRules: unknown };
};

test("内置目录的 providerConfigRules 能通过 schema 解析", () => {
  const parsed = parseZCodeBuiltinProviderConfigRules(catalog.config.providerConfigRules);
  assert.ok(parsed.providers.keys().length > 0, "内置渠道不能为空");
  // 智谱套餐渠道必须仍在，避免新增分组时误删既有条目。
  assert.ok(parsed.providers.has("account:bigmodel-individual-coding-plan"));
  assert.ok(parsed.providers.has("account:zai-start-plan"));
});

test("内置目录的 modelConfigRules 能通过 schema 解析", () => {
  assert.doesNotThrow(() => parseZCodeBuiltinModelConfigRules(catalog.config.modelConfigRules));
});

test("Command Code 渠道作为内置条目存在且配置完整", () => {
  const { providers } = parseZCodeBuiltinProviderConfigRules(catalog.config.providerConfigRules);
  const provider = providers.get(COMMAND_CODE_PROVIDER_ID);
  assert.ok(provider, "内置目录缺少 Command Code 渠道");

  // 分组必须是独立分组：混进 standard-personal 会被当成"自定义供应商"，
  // 混进 zai/bigmodel family 会污染 OAuth 套餐逻辑。
  assert.equal(provider.group, COMMAND_CODE_PROVIDER_GROUP);
  assert.equal(provider.access?.type, "api-key");
  assert.equal(provider.api?.type, "openai-chat-completions");
  assert.equal(provider.api?.baseUrl, "http://47.101.52.182:3050/v1");
  assert.equal(provider.logo?.type, "builtin");

  // 渠道开箱可用：必须自带模型，否则用户进来看到的是空列表。
  assert.ok(
    (provider.builtinModelIds?.length ?? 0) > 0,
    "Command Code 渠道没有任何内置模型",
  );
  // 带入的模型必须同时在内置模型规则里声明，否则模型没有能力配置可用。
  const modelRules = catalog.config.modelConfigRules as {
    builtinProviderModelRules: { providerId: string; modelId: string }[];
  };
  const declared = new Set(
    modelRules.builtinProviderModelRules
      .filter((rule) => rule.providerId === COMMAND_CODE_PROVIDER_ID)
      .map((rule) => rule.modelId),
  );
  for (const modelId of provider.builtinModelIds ?? []) {
    assert.ok(declared.has(modelId), `模型 ${modelId} 缺少 builtinProviderModelRules 声明`);
  }
});
