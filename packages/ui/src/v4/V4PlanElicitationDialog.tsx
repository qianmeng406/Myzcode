// v4 userInput 交互的 ElicitationDialog 承载（从 V4InteractionDialogs 拆出控制其行数）。
// 计划批准（ExitPlanMode）复用问答卡片，并在这里挂上「执行模型/推理档」选择：
// 批准 + 指定模型经 resolveInteraction answer.modelSelection 单命令原子到达 CLI。
import type { ZCodeElicitationRequest } from "@zcode/shared";
import type { PendingInteraction } from "@zcode/shared/zcode-protocol-v4";
import {
  ElicitationDialog,
  type PlanExecutionModelChoice,
  type PlanExecutionModelGroup,
} from "@/ElicitationDialog.js";
import type { ElicitationFormDraft } from "@/store/zcodeSessionStoreTypes.js";
import { pendingUserInputToElicitationRequest } from "@/v4/pendingInteractionAdapter.js";

function buildV4ElicitationProgressKey(request: ZCodeElicitationRequest): string {
  return `${request.requestId}:${request.currentQuestionIndex ?? 0}:${JSON.stringify(request.answerDrafts ?? {})}`;
}

function resolveV4ElicitationRequest(
  projected: ZCodeElicitationRequest | null,
  botProgress: ZCodeElicitationRequest | null,
): ZCodeElicitationRequest | null {
  // Bugfix：V4 snapshot 只保留原始阻塞请求，Bot 代答后的逐题进度必须覆盖同一 request 的投影。
  if (projected && botProgress?.requestId === projected.requestId) {
    return botProgress;
  }
  return projected;
}

/** 把 v4 投影的 userInput 交互接进 ElicitationDialog；非问答类/无法投影时返回 null。 */
export function V4PlanElicitationDialog(props: {
  sessionId: string;
  pending: PendingInteraction;
  botElicitationProgress: ZCodeElicitationRequest | null;
  localElicitationDraft?: ElicitationFormDraft;
  persistElicitationDraft: (requestId: string, draft: ElicitationFormDraft) => void;
  removeElicitationDraft: (requestId: string) => void;
  /** 执行模型下拉候选；仅 plan-approval 传入，空数组同样隐藏下拉。 */
  planExecutionModelGroups?: PlanExecutionModelGroup[];
  /** AskUserQuestion 首次交互暂停（自动结束倒计时）宿主侧闭包，原样转交。 */
  onFirstInteraction?: (
    source: "panelHover" | "answer" | "navigation" | "countdown",
  ) => boolean | void | Promise<boolean | void>;
  resolveInteraction: (
    interactionId: string,
    answer: {
      optionId?: string;
      freeText?: string;
      action?: "accept" | "decline" | "cancel";
      content?: Record<string, unknown>;
      modelSelection?: PlanExecutionModelChoice;
    },
  ) => Promise<boolean>;
  onPlanInteractionAccepted?: (interactionId: string) => void;
}) {
  const {
    sessionId,
    pending,
    botElicitationProgress,
    localElicitationDraft,
    persistElicitationDraft,
    removeElicitationDraft,
    planExecutionModelGroups,
    onFirstInteraction,
    resolveInteraction,
    onPlanInteractionAccepted,
  } = props;
  if (pending.payload.kind !== "userInput") {
    return null;
  }
  const projectedElicitationRequest = pendingUserInputToElicitationRequest(sessionId, {
    ...pending,
    payload: pending.payload,
  });
  if (!projectedElicitationRequest) {
    return null;
  }
  const elicitationRequest = resolveV4ElicitationRequest(
    projectedElicitationRequest,
    botElicitationProgress,
  );
  if (!elicitationRequest) {
    return null;
  }
  const isExitPlanMode = pending.payload.toolName?.trim().toLowerCase() === "exitplanmode";
  const isAskUserQuestion =
    pending.payload.toolName?.trim().toLowerCase() === "askuserquestion" ||
    pending.autoResolution !== undefined;
  return (
    <ElicitationDialog
      key={buildV4ElicitationProgressKey(elicitationRequest)}
      request={elicitationRequest}
      initialFormDraft={
        botElicitationProgress?.requestId === elicitationRequest.requestId
          ? undefined
          : localElicitationDraft
      }
      onFormDraftChange={persistElicitationDraft}
      planExecutionModelGroups={isExitPlanMode ? planExecutionModelGroups : undefined}
      autoResolution={isAskUserQuestion ? pending.autoResolution : undefined}
      onFirstInteraction={isAskUserQuestion ? onFirstInteraction : undefined}
      onRespond={(_requestId, action, content, executionModel) => {
        void resolveInteraction(pending.interactionId, {
          action,
          ...(content ? { content } : {}),
          // 批准 + 指定执行模型：单命令原子到达（CLI broker 据此合并 modify 输入）。
          ...(action === "accept" && executionModel
            ? {
                modelSelection: {
                  providerId: executionModel.providerId,
                  modelId: executionModel.modelId,
                  ...(executionModel.reasoningLevel
                    ? { options: { reasoningLevel: executionModel.reasoningLevel } }
                    : {}),
                },
              }
            : {}),
        }).then((accepted) => {
          if (!accepted) return;
          removeElicitationDraft(pending.interactionId);
          if (isExitPlanMode) {
            // Plan 回执 ACK 与 replayable pending 清场是两条异步路径。
            // 这里只上报已接受的 Plan interaction，由手机 pane 在仍读到旧权威状态时触发恢复。
            onPlanInteractionAccepted?.(pending.interactionId);
          }
        });
      }}
    />
  );
}
