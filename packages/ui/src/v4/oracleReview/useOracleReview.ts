import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelSelection } from "@zcode/shared";
import type { ConversationSnapshot, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/provider";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import {
  ORACLE_REVIEW_REQUEST_TIMEOUT_MS,
  ORACLE_TURN_REVIEW_QUERY_SOURCE,
  buildOracleDiffSections,
  buildOracleReviewPrompt,
  parseOracleVerdict,
  type OracleVerdict,
} from "./oracleReviewSupport.js";

/**
 * Oracle 双模型把关的执行层：回合成功结束（且本回合改过文件）时自动用「把关模型」
 * 复审一次本回合 diff；输入框旁的手动按钮走同一管道重审最近一个已完成回合。
 *
 * 全程复用 prompt_optimizer 同款会话外请求（generateWorkspaceText，不产生消息、
 * 不进历史）；diff 来自 v4 的 conversationFileChangesV4（checkpoint artifact 聚合，
 * 不依赖 git 工作区状态）。不写入 v4 协议，冷恢复后卡片消失是 V1 接受的边界。
 */

export type OracleReviewRequestMode = "auto" | "manual";

export type OracleReviewFailure =
  | { kind: "no-turn" }
  | { kind: "no-changes" }
  | { kind: "no-model" }
  /** 模型返回空正文：多为输出预算被 reasoning 耗尽（finishReason 可佐证）。 */
  | { kind: "empty-response"; finishReason?: string }
  /** 客户端 deadline 到点：多为渠道限流或深思考无首 token 的重试循环。 */
  | { kind: "timeout" }
  | { kind: "request"; message: string };

export type OracleReviewState =
  | { status: "idle" }
  | { status: "pending"; mode: OracleReviewRequestMode }
  | {
      status: "result";
      mode: OracleReviewRequestMode;
      turnRowId: number;
      verdict: OracleVerdict;
      summary: string;
      findings: string;
      modelLabel: string;
    }
  | { status: "error"; mode: OracleReviewRequestMode; failure: OracleReviewFailure };

/**
 * 解析把关请求的执行选项：模型选择（缺推理档时补该模型最高公开档）+ 输出预算。
 *
 * maxOutputTokens 跟随模型声明的上限（optionSpecs.maxOutputTokens.max，与主回合
 * 「打满模型声明上限」同语义）：省略会被 adapters 的 validateOptions 以
 * 「outside the model option range」拒绝；设小了会被思考模型的 reasoning 吃光
 * 导致空正文（实测 2048 上限 GLM 返回空文本）。模型视图缺席该值时才省略并让
 * 错误如实上报。
 */
function resolveOracleRequestOptions(
  oracleModel: ModelSelection | null,
  modelSelectionView: ModelSelectionView | null | undefined,
): { selection: ModelSelection; maxOutputTokens?: number } | null {
  const selection = oracleModel ?? modelSelectionView?.preferredSelection ?? null;
  if (!selection) {
    return null;
  }
  const provider = modelSelectionView?.providers.find(
    (candidate) => candidate.providerId === selection.providerId,
  );
  const model = provider?.models.find((candidate) => candidate.modelId === selection.modelId);
  const levels = model?.config.optionSpecs.reasoningLevel?.values;
  const highestLevel = levels?.length ? levels[levels.length - 1] : undefined;
  const resolvedSelection =
    selection.options?.reasoningLevel || !highestLevel
      ? selection
      : { ...selection, options: { reasoningLevel: highestLevel } };
  const specMax = model?.config.optionSpecs.maxOutputTokens?.max;
  return {
    selection: resolvedSelection,
    ...(typeof specMax === "number" && Number.isFinite(specMax) && specMax > 0
      ? { maxOutputTokens: specMax }
      : {}),
  };
}

function findLastCompletedTurnHeader(snapshot: ConversationSnapshot): TurnHeaderRow | null {
  for (let index = snapshot.rows.window.length - 1; index >= 0; index -= 1) {
    const row = snapshot.rows.window[index];
    if (row?.kind === "turnHeader" && row.state === "completedSuccess") {
      return row;
    }
  }
  return null;
}

function findUserRequestBeforeTurn(snapshot: ConversationSnapshot, turnRowId: number): string {
  for (let index = snapshot.rows.window.length - 1; index >= 0; index -= 1) {
    const row = snapshot.rows.window[index];
    if (row?.rowId !== undefined && row.rowId < turnRowId && row.kind === "userInput") {
      return row.text;
    }
  }
  return "";
}

export function useOracleReview(params: {
  snapshot: ConversationSnapshot | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  oracleModel: ModelSelection | null;
  modelSelectionView?: ModelSelectionView | null;
}) {
  const { settings } = useSettings();
  const enabled = settings?.oracleReviewEnabled ?? false;
  const services = useOptionalServices();
  const [state, setState] = useState<OracleReviewState>({ status: "idle" });
  const stateRef = useRef(state);
  const requestSeqRef = useRef(0);
  // 边沿检测：上一帧 phase；null 表示尚无基线（首帧/会话切换后不触发）。
  const prevPhaseRef = useRef<string | null>(null);
  const autoReviewedTurnRowIdsRef = useRef(new Set<number>());
  // snapshot 随流式每帧换新对象；reviewTurn 走 ref 读取，回调身份只随稳定依赖变化。
  const snapshotRef = useRef(params.snapshot);
  snapshotRef.current = params.snapshot;

  const setOracleState = useCallback((next: OracleReviewState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const sessionId = params.snapshot?.sessionId ?? null;
  // 会话切换：清空结果与边沿基线，避免上一会话的终态误触发新会话的自动审查。
  useEffect(() => {
    setOracleState({ status: "idle" });
    prevPhaseRef.current = null;
    autoReviewedTurnRowIdsRef.current = new Set();
  }, [sessionId, setOracleState]);

  const reviewTurn = useCallback(
    async (mode: OracleReviewRequestMode, headerOverride?: TurnHeaderRow) => {
      const snapshot = snapshotRef.current;
      const agentService = services?.zcodeAgentService;
      if (!snapshot || !agentService || stateRef.current.status === "pending") {
        return;
      }
      const header = headerOverride ?? findLastCompletedTurnHeader(snapshot);
      if (!header) {
        setOracleState({ status: "error", mode, failure: { kind: "no-turn" } });
        return;
      }
      if (mode === "auto") {
        // 自动把关每回合至多一次；手动按钮不受限（重审同一回合是明确意图）。
        if (autoReviewedTurnRowIdsRef.current.has(header.rowId)) {
          return;
        }
        autoReviewedTurnRowIdsRef.current.add(header.rowId);
      }
      if (!header.fileChanges || header.fileChanges.files <= 0) {
        setOracleState({ status: "error", mode, failure: { kind: "no-changes" } });
        return;
      }
      const requestOptions = resolveOracleRequestOptions(
        params.oracleModel,
        params.modelSelectionView,
      );
      if (!requestOptions) {
        setOracleState({ status: "error", mode, failure: { kind: "no-model" } });
        return;
      }
      const target = header.entityId ? { rowId: header.rowId, entityId: header.entityId } : null;
      if (!target) {
        setOracleState({ status: "error", mode, failure: { kind: "no-turn" } });
        return;
      }
      setOracleState({ status: "pending", mode });
      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;
      const applyIfCurrent = (next: OracleReviewState) => {
        if (requestSeqRef.current === requestSeq) {
          setOracleState(next);
        }
      };
      try {
        const fileChanges = await agentService.conversationFileChangesV4({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          sessionId: snapshot.sessionId,
          target,
          baseRevision: snapshot.revision,
          baseLogEpoch: snapshot.logEpoch,
        });
        const sections = buildOracleDiffSections(fileChanges.items);
        if (sections.length === 0) {
          applyIfCurrent({ status: "error", mode, failure: { kind: "no-changes" } });
          return;
        }
        const result = await agentService.generateWorkspaceText({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          selection: requestOptions.selection,
          prompt: buildOracleReviewPrompt({
            userRequest: findUserRequestBeforeTurn(snapshot, header.rowId),
            diffSections: sections,
            projectName: getPathLeaf(params.workspacePath) || params.workspacePath,
          }),
          querySource: ORACLE_TURN_REVIEW_QUERY_SOURCE,
          // 输出预算跟随模型声明的上限（resolveOracleRequestOptions 注释详述取舍）；
          // 超时由 requestTimeoutMs 兜底，审查结论从返回内容里解析。
          ...(requestOptions.maxOutputTokens !== undefined
            ? { maxOutputTokens: requestOptions.maxOutputTokens }
            : {}),
          requestTimeoutMs: ORACLE_REVIEW_REQUEST_TIMEOUT_MS,
        });
        const parsed = parseOracleVerdict(result.text);
        if (!result.text.trim()) {
          // 空正文：thinking 模型在输出预算内没留下可见文本。单独成类错误，
          // 不伪装成「无法解析结论」；带 finishReason 便于判断是不是长度截断。
          logger.warn("[OracleReview] 模型返回空正文", {
            workspacePath: params.workspacePath,
            turnRowId: header.rowId,
            finishReason: result.finishReason ?? null,
            outputTokens: result.usage?.outputTokens ?? null,
            reasoningTokens: result.usage?.reasoningTokens ?? null,
          });
          applyIfCurrent({
            status: "error",
            mode,
            failure: {
              kind: "empty-response",
              ...(result.finishReason ? { finishReason: result.finishReason } : {}),
            },
          });
          return;
        }
        logger.info("[OracleReview] 回合审查完成", {
          workspacePath: params.workspacePath,
          turnRowId: header.rowId,
          verdict: parsed.verdict,
          providerId: result.selection.providerId,
          model: result.selection.modelId,
          finishReason: result.finishReason ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
          reasoningTokens: result.usage?.reasoningTokens ?? null,
        });
        applyIfCurrent({
          status: "result",
          mode,
          turnRowId: header.rowId,
          verdict: parsed.verdict,
          summary: parsed.summary,
          findings: parsed.findings,
          modelLabel: `${result.selection.providerId}/${result.selection.modelId}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[OracleReview] 回合审查失败", {
          workspacePath: params.workspacePath,
          error: message,
        });
        // 客户端 deadline 到点：日志实测此时模型侧多为「每次尝试约 60s 无首 token
        // 被掐 + 指数退避重试」循环（渠道限流或深思考无产出），干等不会好转。
        // 给专门的文案指引换把关模型，而不是复用通用失败语。
        const isTimeout = /timed out|timeout/i.test(message);
        applyIfCurrent({
          status: "error",
          mode,
          failure: isTimeout ? { kind: "timeout" } : { kind: "request", message },
        });
      }
    },
    // 依赖拆成稳定引用：workspacePath 等基本不变，modelSelectionView/oracleModel 只在
    // 用户换模型时变——流式期间 snapshot 每帧换新对象也不能重建回调（会打断边沿检测）。
    [
      params.modelSelectionView,
      params.oracleModel,
      params.remoteSessionId,
      params.workspaceIdentity,
      params.workspacePath,
      services,
      setOracleState,
    ],
  );

  // 自动把关：running → completedSuccess 边沿触发（中断/报错回合是半成品，不审）。
  const phase = params.snapshot?.control.phase ?? null;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (prev === null || prev === phase || phase !== "completedSuccess") {
      return;
    }
    if (!enabledRef.current) {
      return;
    }
    void reviewTurn("auto");
  }, [phase, reviewTurn]);

  const manualReview = useCallback(() => {
    void reviewTurn("manual");
  }, [reviewTurn]);

  // 轮尾工具栏「审查这一回合」：按钮只在有 diff 的已完成回合渲染，这里不再重复校验。
  const reviewTurnHeader = useCallback(
    (header: TurnHeaderRow) => {
      void reviewTurn("manual", header);
    },
    [reviewTurn],
  );

  const dismiss = useCallback(() => {
    setOracleState({ status: "idle" });
  }, [setOracleState]);

  return { state, enabled, manualReview, reviewTurnHeader, dismiss };
}

/** SessionPane → composer / 行渲染注入的完整控制面；composer 不再自持 hook 实例。 */
export interface OracleReviewController {
  state: OracleReviewState;
  enabled: boolean;
  manualReview: () => void;
  reviewTurnHeader: (header: TurnHeaderRow) => void;
  dismiss: () => void;
  /** 把关模型偏好（localStorage 全局）；下拉的受控值。 */
  model: ModelSelection | null;
  onSelectModel: (selection: ModelSelection | null) => void;
}
