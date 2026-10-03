import { useEffect, useRef, useState } from "react";
import type { ConversationSnapshot, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { useOptionalServices } from "@/hooks/useServices.js";
import {
  appendOracleReviewToolEvent,
  isOracleReviewQuerySource,
  type OracleReviewState,
} from "./oracleReviewSupport.js";
import { getOracleReviewState, setOracleReviewState } from "./oracleReviewStore.js";

/** 最近一个已完成回合的 header：手动「审查」按钮默认审它。 */
export function findLastCompletedTurnHeader(
  snapshot: ConversationSnapshot,
): TurnHeaderRow | null {
  for (let index = snapshot.rows.window.length - 1; index >= 0; index -= 1) {
    const row = snapshot.rows.window[index];
    if (row?.kind === "turnHeader" && row.state === "completedSuccess") {
      return row;
    }
  }
  return null;
}

type OracleServices = ReturnType<typeof useOptionalServices>;

/**
 * pending 期间的进度反馈（从主 hook 拆出，控制其行数）：
 * - 等待时长：pending 期间每秒跳一次，让用户确认「还在跑」。
 * - 流式输出进度：CLI 把正文+思考的累计字符数（深度审查附轮次/工具名）按节流窗口
 *   推给宿主，经 onDynamicWorkspaceGenerateTextProgress 全局事件转发到这里；按
 *   querySource（标准+深度两个来源）+ workspacePath 认领本 hook 发起的请求。
 * 轮次/工具名/工具事件直接写进模块级 store 的 pending 条目，主 hook 无需逐帧重渲染。
 */
export function useOracleReviewPendingProgress(params: {
  state: OracleReviewState;
  services: OracleServices | null;
  workspacePath: string;
  sessionId: string | null;
}): { pendingElapsedSeconds: number; pendingOutputChars: number } {
  const { state, services, workspacePath, sessionId } = params;

  const [pendingElapsedSeconds, setPendingElapsedSeconds] = useState(0);
  const pendingStartedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (state.status !== "pending") {
      pendingStartedAtRef.current = null;
      setPendingElapsedSeconds(0);
      return;
    }
    if (pendingStartedAtRef.current === null) {
      pendingStartedAtRef.current = Date.now();
    }
    const startedAt = pendingStartedAtRef.current;
    const tick = () => {
      setPendingElapsedSeconds(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [state.status]);

  const [pendingOutputChars, setPendingOutputChars] = useState(0);
  useEffect(() => {
    if (state.status !== "pending") {
      setPendingOutputChars(0);
      return;
    }
    const event = services?.zcodeAgentService.onDynamicWorkspaceGenerateTextProgress();
    if (!event) {
      return;
    }
    const disposable = event((progress) => {
      if (!isOracleReviewQuerySource(progress.querySource)) return;
      if (progress.workspacePath !== workspacePath) return;
      setPendingOutputChars(progress.outputChars);
      // 深度审查的轮次/工具名/工具事件写进 store 的 pending 条目（工具执行阶段带
      // toolName，生成阶段不带——直接赋值让上一次的工具名随新轮次清空）。
      const hasToolEvent = Boolean(progress.toolName);
      if (sessionId !== null && (progress.round !== undefined || hasToolEvent)) {
        const current = getOracleReviewState(sessionId);
        if (current.status === "pending") {
          const toolEvents =
            hasToolEvent && progress.toolName
              ? appendOracleReviewToolEvent(current.toolEvents ?? [], {
                  round: progress.round ?? current.round ?? 1,
                  toolName: progress.toolName,
                  ...(progress.toolTarget ? { target: progress.toolTarget } : {}),
                })
              : current.toolEvents;
          setOracleReviewState(sessionId, {
            ...current,
            ...(progress.round !== undefined ? { round: progress.round } : {}),
            toolName: progress.toolName,
            toolTarget: progress.toolTarget,
            ...(toolEvents ? { toolEvents } : {}),
          });
        }
      }
    });
    return () => {
      disposable.dispose();
    };
  }, [state.status, services, workspacePath, sessionId]);

  return { pendingElapsedSeconds, pendingOutputChars };
}
