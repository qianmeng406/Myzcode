import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canCreateAttachment,
  decideDeviceWorkspaceAccess,
  isPairingCodeUsable,
  type CompanionDeviceGrants,
} from "../src/domain/grants.js";

const grants: CompanionDeviceGrants = {
  deviceId: "dev-1",
  nodes: [
    { nodeId: "cloud-1", workspaceIdentities: [] },
    { nodeId: "desktop-1", workspaceIdentities: ["/work/demo"] },
  ],
};

test("未授权节点被拒绝", () => {
  const decision = decideDeviceWorkspaceAccess({
    grants,
    revokedAt: null,
    nodeId: "cloud-2",
    workspaceIdentity: "/srv/app",
  });
  assert.deepEqual(decision, { allowed: false, reason: "node_not_granted" });
});

test("空白名单节点放行任意已登记工作区", () => {
  const decision = decideDeviceWorkspaceAccess({
    grants,
    revokedAt: null,
    nodeId: "cloud-1",
    workspaceIdentity: "/srv/anything",
  });
  assert.deepEqual(decision, { allowed: true });
});

test("精确白名单：命中放行，未命中拒绝", () => {
  const hit = decideDeviceWorkspaceAccess({
    grants,
    revokedAt: null,
    nodeId: "desktop-1",
    workspaceIdentity: "/work/demo",
  });
  assert.deepEqual(hit, { allowed: true });
  const miss = decideDeviceWorkspaceAccess({
    grants,
    revokedAt: null,
    nodeId: "desktop-1",
    workspaceIdentity: "/work/other",
  });
  assert.deepEqual(miss, { allowed: false, reason: "workspace_not_granted" });
});

test("已撤销设备一律拒绝且归因为 device_revoked", () => {
  const decision = decideDeviceWorkspaceAccess({
    grants,
    revokedAt: 123,
    nodeId: "cloud-1",
    workspaceIdentity: "/srv/app",
  });
  assert.deepEqual(decision, { allowed: false, reason: "device_revoked" });
});

test("无授权记录按未授权节点处理", () => {
  const decision = decideDeviceWorkspaceAccess({
    grants: null,
    revokedAt: null,
    nodeId: "cloud-1",
    workspaceIdentity: "/srv/app",
  });
  assert.deepEqual(decision, { allowed: false, reason: "node_not_granted" });
});

test("配对码状态：已用/未过期判定", () => {
  assert.deepEqual(isPairingCodeUsable({ expiresAt: 10, usedAt: null }), { usable: true });
  assert.deepEqual(isPairingCodeUsable({ expiresAt: 10, usedAt: 5 }), {
    usable: false,
    reason: "used",
  });
});

test("attachment 配额判定", () => {
  assert.equal(canCreateAttachment(7, 8), true);
  assert.equal(canCreateAttachment(8, 8), false);
});
