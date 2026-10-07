// 能力矩阵回归：永久关闭面不得被误开；开放面与 facade 白名单一致。
// 注意：矩阵只是「UI 不渲染入口」的呈现层约定，真正的围栏在服务端
// narrowing facade / channel policy（见 specs/companion-gateway.md §11）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { MOBILE_CAPABILITIES } from "../src/mobileCapabilities.js";

test("能力矩阵：终端/文件写/插件/凭据管理必须恒为 false", () => {
  assert.equal(MOBILE_CAPABILITIES.terminal, false);
  assert.equal(MOBILE_CAPABILITIES.fileWrite, false);
  assert.equal(MOBILE_CAPABILITIES.pluginManagement, false);
  assert.equal(MOBILE_CAPABILITIES.credentialManagement, false);
});

test("能力矩阵：首版开放面与 facade 白名单一致", () => {
  assert.equal(MOBILE_CAPABILITIES.taskCommands, true);
  assert.equal(MOBILE_CAPABILITIES.interactions, true);
  assert.equal(MOBILE_CAPABILITIES.sessionsIndex, true);
  assert.equal(MOBILE_CAPABILITIES.readonlyFileDiff, true);
  assert.equal(MOBILE_CAPABILITIES.modeSwitch, true);
  assert.equal(MOBILE_CAPABILITIES.workspaceSwitch, true);
});
