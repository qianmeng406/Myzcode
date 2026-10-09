// companion 目录可见性回归：未共享工作区不得出现在手机侧栏（specs §A4 存在性不泄露），
// 且注入为空集合时绝不隐藏全部工作区（按未注入处理）。桌面/浏览器不注入时行为不变。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearCompanionSharedWorkspaces,
  getCompanionSharedWorkspaceKeys,
  isWorkspaceVisibleUnderCompanionRestriction,
  setCompanionSharedWorkspaces,
} from "../src/companionWorkspaceVisibility.js";

test("未注入集合时不限制（桌面渲染器/浏览器路径行为不变）", () => {
  clearCompanionSharedWorkspaces();
  assert.equal(getCompanionSharedWorkspaceKeys(), null);
  assert.equal(isWorkspaceVisibleUnderCompanionRestriction("C:\\any"), true);
});

test("注入共享集合后：共享工作区可见（path 与 identity 双键），未共享不可见", () => {
  try {
    setCompanionSharedWorkspaces([
      { workspacePath: "C:\\Users\\me\\ZCode", workspaceIdentity: "C:\\Users\\me\\ZCode" },
      { workspacePath: "/srv/cloud", workspaceIdentity: "ssh://host/srv/cloud" },
    ]);
    // 本地工作区：tab 的 identity 可能缺省（= path）或显式等于 path。
    assert.equal(isWorkspaceVisibleUnderCompanionRestriction("C:\\Users\\me\\ZCode"), true);
    assert.equal(
      isWorkspaceVisibleUnderCompanionRestriction("C:\\Users\\me\\ZCode", "C:\\Users\\me\\ZCode"),
      true,
    );
    // 远程工作区：tab 带 identity（authority+path）也能命中。
    assert.equal(isWorkspaceVisibleUnderCompanionRestriction("/srv/cloud", "ssh://host/srv/cloud"), true);
    // 未共享：按 path 或 identity 都命中不了 → 不可见。
    assert.equal(isWorkspaceVisibleUnderCompanionRestriction("C:\\Users\\me\\other"), false);
    assert.equal(isWorkspaceVisibleUnderCompanionRestriction("/home/x", "/home/x"), false);
  } finally {
    clearCompanionSharedWorkspaces();
  }
});

test("空集合按未注入处理（绝不因此隐藏全部工作区）", () => {
  setCompanionSharedWorkspaces([]);
  assert.equal(getCompanionSharedWorkspaceKeys(), null);
  assert.equal(isWorkspaceVisibleUnderCompanionRestriction("C:\\anything"), true);
});
