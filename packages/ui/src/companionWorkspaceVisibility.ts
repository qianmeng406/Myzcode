// companion 目录可见性（specs §A4「目录按设备 grants 过滤：未授权工作区不可见」）：
// 手机端的完整 UI（WebUI 响应式）从 Host 恢复的是**桌面端全部**标签会话，其中未共享
// 的工作区在数据面按授权读不到，会在侧栏显示成永远空列表（「暂无任务」）——既误导
// 也泄露存在性。这里给 UI 一个可选的「共享工作区集合」：由 companion 引导（拿得到
// gateway 目录）注入；不注入（桌面渲染器 / 浏览器 / 测试）时为 null，行为完全不变。
import { useSyncExternalStore } from "react";

export interface CompanionWorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string;
}

let allowedKeys: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * 注入当前设备可见的共享工作区集合（键 = workspacePath 与 workspaceIdentity 双写，
 * 兼容「本地工作区 identity === path」与「远程工作区 identity = authority+path」两种键法）。
 * 空集合按「未注入」处理，绝不因此隐藏全部工作区。
 */
export function setCompanionSharedWorkspaces(entries: readonly CompanionWorkspaceRef[]): void {
  const keys = new Set<string>();
  for (const entry of entries) {
    keys.add(entry.workspacePath);
    if (entry.workspaceIdentity && entry.workspaceIdentity !== entry.workspacePath) {
      keys.add(entry.workspaceIdentity);
    }
  }
  const next = keys.size > 0 ? keys : null;
  if (next === null && allowedKeys === null) return;
  allowedKeys = next;
  notify();
}

export function clearCompanionSharedWorkspaces(): void {
  if (allowedKeys === null) return;
  allowedKeys = null;
  notify();
}

export function subscribeCompanionWorkspaceVisibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCompanionSharedWorkspaceKeys(): ReadonlySet<string> | null {
  return allowedKeys;
}

/** null = 无 companion 限制（桌面/浏览器/测试环境）；有集合时按 path/identity 双键判定。 */
export function useCompanionWorkspaceRestriction(): ReadonlySet<string> | null {
  return useSyncExternalStore(
    subscribeCompanionWorkspaceVisibility,
    getCompanionSharedWorkspaceKeys,
    () => null,
  );
}

export function isWorkspaceVisibleUnderCompanionRestriction(
  workspacePath: string,
  workspaceIdentity?: string,
): boolean {
  if (allowedKeys === null) return true;
  return (
    allowedKeys.has(workspacePath) ||
    (workspaceIdentity !== undefined && allowedKeys.has(workspaceIdentity))
  );
}
