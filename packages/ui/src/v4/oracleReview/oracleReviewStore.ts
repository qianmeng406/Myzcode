import type { OracleReviewState } from "./oracleReviewSupport.js";

/**
 * 审查卡片的模块级状态仓：按 v4 sessionId 键控，**跨会话切换与组件重挂载存活**。
 *
 * 之前状态放在 useOracleReview 的 useState 里：切换会话会触发清空 effect，且
 * SessionPane 重挂载后旧实例的 React state 全部作废——进行中的审查请求闭包虽然
 * 还在跑，结果却写回了已卸载的实例，表现为「切走再切回，卡片没了、结果也收不到」。
 * 把状态搬进 store 后，请求闭包写的是模块级条目，重挂载的 hook 重新订阅即恢复；
 * 请求代次守卫也一并搬进来，跨重挂载仍能作废过期请求的写回。
 *
 * 纯内存（Map 随会话数增长，条目极小），冷恢复后卡片消失仍是 V1 接受的边界；
 * 状态回到 idle 时删除条目以收敛内存。
 */

type OracleReviewListener = (state: OracleReviewState) => void;

const states = new Map<string, OracleReviewState>();
const listeners = new Map<string, Set<OracleReviewListener>>();
const seqs = new Map<string, number>();

export function getOracleReviewState(sessionId: string | null): OracleReviewState {
  return (sessionId !== null && states.get(sessionId)) || { status: "idle" };
}

export function setOracleReviewState(sessionId: string, next: OracleReviewState): void {
  // idle 不占位（get 的缺省即 idle），条目数与会话内活跃卡片数一致。
  if (next.status === "idle") {
    states.delete(sessionId);
  } else {
    states.set(sessionId, next);
  }
  const sessionListeners = listeners.get(sessionId);
  if (sessionListeners) {
    for (const listener of [...sessionListeners]) {
      listener(next);
    }
  }
}

/** 订阅某会话的状态变化；返回退订函数。重复退订安全。 */
export function subscribeOracleReviewState(
  sessionId: string | null,
  listener: OracleReviewListener,
): () => void {
  if (sessionId === null) {
    return () => {};
  }
  let sessionListeners = listeners.get(sessionId);
  if (!sessionListeners) {
    sessionListeners = new Set();
    listeners.set(sessionId, sessionListeners);
  }
  sessionListeners.add(listener);
  return () => {
    const current = listeners.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(sessionId);
    }
  };
}

/** 取该会话的下一个请求代次；调用方持有返回值用于 applyIfCurrent 守卫。 */
export function nextOracleReviewSeq(sessionId: string): number {
  const seq = (seqs.get(sessionId) ?? 0) + 1;
  seqs.set(sessionId, seq);
  return seq;
}

export function isCurrentOracleReviewSeq(sessionId: string, seq: number): boolean {
  return seqs.get(sessionId) === seq;
}
