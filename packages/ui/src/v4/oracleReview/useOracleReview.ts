import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { ModelSelection } from "@zcode/shared";
import type { ConversationSnapshot, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/provider";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import {
  ORACLE_DEEP_REVIEW_QUERY_SOURCE,
  ORACLE_DEEP_REVIEW_TIMEOUT_MS,
  ORACLE_REVIEW_REQUEST_TIMEOUT_MS,
  ORACLE_TURN_REVIEW_QUERY_SOURCE,
  buildOracleDiffSections,
  buildOracleReviewPrompt,
  isOracleDeadlineTimeoutError,
  parseOracleVerdict,
  resolveOraclePreviousReviewContext,
  resolveOracleRequestOptions,
  type OraclePreviousReviewContext,
  type OracleReviewDepth,
  type OracleReviewRequestMode,
  type OracleReviewState,
} from "./oracleReviewSupport.js";
import {
  findOracleUserRequestBeforeTurn,
  readOracleRecentCommitSubjects,
  readOracleWorkspaceDiff,
} from "./oracleReviewContextFetch.js";
import {
  findLastCompletedTurnHeader,
  useOracleReviewPendingProgress,
} from "./oracleReviewPendingProgress.js";
import {
  getOracleReviewState,
  invalidateOracleReviewSeq,
  isCurrentOracleReviewSeq,
  nextOracleReviewSeq,
  setOracleReviewState,
  subscribeOracleReviewState,
} from "./oracleReviewStore.js";

/**
 * Oracle 双模型把关的执行层：回合成功结束（且本回合改过文件）时自动用「把关模型」
 * 复审本回合 diff；输入框旁按钮与轮尾按钮走同一管道。复用 prompt_optimizer 同款
 * 会话外请求（generateWorkspaceText，不产生消息）；diff 优先 v4 checkpoint 聚合，
 * 回合无工具级改动时回退工作区未提交改动（脚本回合）。卡片状态在模块级 store
 * （oracleReviewStore）按会话键控，切换会话/重挂载不丢；冷恢复后卡片消失是 V1 边界。
 */

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
  const sessionId = params.snapshot?.sessionId ?? null;
  // 卡片状态在模块级 store（按 sessionId 键控）：切走再切回、组件重挂载都不丢；
  // 进行中的审查由请求闭包继续推进并写入 store，与本实例是否挂载无关。
  // useSyncExternalStore 是外部 store 的规范接法：无并发撕裂窗口，
  // getSnapshot 返回 store 内的稳定引用（idle 为模块级常量）。
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeOracleReviewState(sessionId, onStoreChange),
    [sessionId],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => getOracleReviewState(sessionId),
    () => getOracleReviewState(null),
  );
  // 边沿检测：上一帧 phase；null 表示尚无基线（首帧/会话切换后不触发）。
  const prevPhaseRef = useRef<string | null>(null);
  const autoReviewedTurnRowIdsRef = useRef(new Set<number>());
  // snapshot 随流式每帧换新对象；reviewTurn 走 ref 读取，回调身份只随稳定依赖变化。
  const snapshotRef = useRef(params.snapshot);
  snapshotRef.current = params.snapshot;

  // 边沿基线与自动审查去重随会话切换重置（状态本身不清空——store 持有各会话卡片）。
  useEffect(() => {
    prevPhaseRef.current = null;
    autoReviewedTurnRowIdsRef.current = new Set();
  }, [sessionId]);

  const reviewTurn = useCallback(
    async (
      mode: OracleReviewRequestMode,
      headerOverride?: TurnHeaderRow,
      depth: OracleReviewDepth = "standard",
    ) => {
      const snapshot = snapshotRef.current;
      const agentService = services?.zcodeAgentService;
      if (!snapshot || !agentService) {
        return;
      }
      // 闭包捕获发起时的会话 id：写回永远落在发起会话的 store 条目上，
      // 即使用户已切到别的会话，切回时卡片仍能显示结果。
      const sid = snapshot.sessionId;
      if (getOracleReviewState(sid).status === "pending") {
        // 单横幅设计：审查进行中重复点击只能静默忽略（横幅显示「审查中」）；
        // 留痕日志避免「点了没反应」无从排查。
        logger.info("[OracleReview] 已有审查在进行中，忽略本次请求", {
          mode,
          sessionKey: sid,
          overrideTurnRowId: headerOverride?.rowId ?? null,
        });
        return;
      }
      const header = headerOverride ?? findLastCompletedTurnHeader(snapshot);
      if (!header) {
        setOracleReviewState(sid, { status: "error", mode, failure: { kind: "no-turn" }, depth });
        return;
      }
      // 诊断留痕：区分入口（手动/自动/逐轮）与目标轮，便于失败归因。
      logger.info("[OracleReview] 发起回合审查", {
        mode,
        turnRowId: header.rowId,
        override: headerOverride !== undefined,
        files: header.fileChanges?.files ?? 0,
      });
      if (mode === "auto") {
        // 自动把关每回合至多一次；手动按钮不受限（重审同一回合是明确意图）。
        if (autoReviewedTurnRowIdsRef.current.has(header.rowId)) {
          return;
        }
        autoReviewedTurnRowIdsRef.current.add(header.rowId);
      }
      // 这里不按 header.fileChanges 提前拒绝：脚本/命令完成的改动不会被 checkpoint
      // 记录为工具级改动，有无可审查内容由取 diff（含工作区兜底）之后统一判定。
      const requestOptions = resolveOracleRequestOptions(
        params.oracleModel,
        params.modelSelectionView,
      );
      if (!requestOptions) {
        setOracleReviewState(sid, { status: "error", mode, failure: { kind: "no-model" }, depth });
        return;
      }
      const target = header.entityId ? { rowId: header.rowId, entityId: header.entityId } : null;
      if (!target) {
        setOracleReviewState(sid, { status: "error", mode, failure: { kind: "no-turn" }, depth });
        return;
      }
      // 跨回合对照上下文：注入门槛收敛在 resolveOraclePreviousReviewContext；对照
      // 候选必须在置 pending 前读（pending 会覆盖 result 条目），是否注入等请求文本
      // 取数结果出来再定——请求文本缺失时对照段是唯一"任务线索"，必须抑制。
      const previousReviewCandidate: OraclePreviousReviewContext | null =
        resolveOraclePreviousReviewContext(getOracleReviewState(sid), header.rowId);
      const pendingModelLabel = `${requestOptions.selection.providerId}/${requestOptions.selection.modelId}`;
      setOracleReviewState(sid, { status: "pending", mode, modelLabel: pendingModelLabel, depth });
      const requestSeq = nextOracleReviewSeq(sid);
      const applyIfCurrent = (next: OracleReviewState) => {
        if (isCurrentOracleReviewSeq(sid, requestSeq)) {
          setOracleReviewState(sid, next);
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
        // diff 来源：优先该回合的工具级改动记录（Edit/Write 产物）；为空的常见原因
        // 是脚本/命令（Bash）完成改动——回退工作区相对 HEAD 的未提交改动，否则脚本
        // 回合完全无法审查（标准审查直接拒绝、深度审查同样被挡）。
        let sections = buildOracleDiffSections(fileChanges.items);
        let diffSource: "turn" | "workspace" = "turn";
        if (sections.length === 0) {
          const workspaceDiff = await readOracleWorkspaceDiff(
            services?.gitService,
            params.workspacePath,
          );
          if (workspaceDiff.sections.length > 0) {
            sections = workspaceDiff.sections;
            diffSource = "workspace";
          }
          logger.info("[OracleReview] 回合无工具级改动记录，回退工作区改动", {
            turnRowId: header.rowId,
            depth,
            workspaceFiles: workspaceDiff.fileCount,
            truncated: workspaceDiff.truncated,
            excluded: workspaceDiff.excluded,
            adopted: diffSource === "workspace",
          });
        }
        if (sections.length === 0) {
          // 自动把关的纯对话回合：静默跳过（不留错误卡片），避免每轮都弹「无改动」。
          if (mode === "auto") {
            logger.info("[OracleReview] 自动把关跳过：无任何可审查改动", {
              turnRowId: header.rowId,
            });
            setOracleReviewState(sid, { status: "idle" });
            return;
          }
          applyIfCurrent({ status: "error", mode, failure: { kind: "no-changes" }, depth });
          return;
        }
        const recentCommits = await readOracleRecentCommitSubjects(
          services?.gitService,
          params.workspacePath,
        );
        // 请求文本：快照尾部窗口优先，未命中则经 rows/range 游标翻页补历史
        // （大回合会把请求行挤出窗口——曾导致审查者拿对照上下文臆断任务）。
        const userRequest = await findOracleUserRequestBeforeTurn({
          windowRows: snapshot.rows.window,
          turnRowId: header.rowId,
          fetchRowsBefore: (beforeRowId, limit) =>
            agentService.conversationRowsRangeV4({
              workspacePath: params.workspacePath,
              ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
              ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
              sessionId: snapshot.sessionId,
              beforeRowId,
              limit,
            }),
        });
        logger.info("[OracleReview] 回合请求文本取数", {
          turnRowId: header.rowId,
          source: userRequest.source,
        });
        const previousReview = userRequest.source === "missing" ? null : previousReviewCandidate;
        const result = await agentService.generateWorkspaceText({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          selection: requestOptions.selection,
          prompt: buildOracleReviewPrompt({
            userRequest: userRequest.text,
            ...(userRequest.source === "missing" ? { userRequestUnavailable: true } : {}),
            diffSections: sections,
            projectName: getPathLeaf(params.workspacePath) || params.workspacePath,
            previousReview,
            ...(recentCommits ? { recentCommits } : {}),
            depth,
            diffSource,
          }),
          querySource:
            depth === "deep" ? ORACLE_DEEP_REVIEW_QUERY_SOURCE : ORACLE_TURN_REVIEW_QUERY_SOURCE,
          // 流式传输：一次性请求路径实测 8 次尝试均在 ~55-60s 无产出后被上游掐断
          // （客户端各超时均 ≥180s 可排除）；流式的思考增量让连接持续活跃避开该窗口。
          stream: true,
          // 深度审查：只读子代理多轮取证（core 忽略单轮 stream 语义，逐轮内部流式）。
          ...(depth === "deep"
            ? {
                agentic: true,
                // 软 deadline 随请求下发：调查轮在扣除收尾预留后提前收敛进禁用
                // 工具的收尾轮（hard-abort 之外的 first-line 保障，实测孤儿审查
                // 烧满 deadline 零结论的教训）。
                deadlineAt: Date.now() + ORACLE_DEEP_REVIEW_TIMEOUT_MS,
              }
            : {}),
          // 输出预算跟随模型声明的上限（resolveOracleRequestOptions 注释详述取舍）；
          // 超时由 requestTimeoutMs 兜底，审查结论从返回内容里解析。
          ...(requestOptions.maxOutputTokens !== undefined
            ? { maxOutputTokens: requestOptions.maxOutputTokens }
            : {}),
          requestTimeoutMs:
            depth === "deep" ? ORACLE_DEEP_REVIEW_TIMEOUT_MS : ORACLE_REVIEW_REQUEST_TIMEOUT_MS,
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
            depth,
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
          depth,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[OracleReview] 回合审查失败", {
          workspacePath: params.workspacePath,
          error: message,
        });
        // 客户端 deadline 到点（协议 client 专属错误类型）：日志实测模型侧多为
        // 「~60s 无首 token 被掐 + 指数退避重试」循环（限流/深思考无产出），干等
        // 无好转，给专门文案指引换把关模型。AbortError/ETIMEDOUT/服务端 timeout 走通用失败语。
        const isTimeout = isOracleDeadlineTimeoutError(error);
        applyIfCurrent({
          status: "error",
          mode,
          failure: isTimeout ? { kind: "timeout", message } : { kind: "request", message },
          modelLabel: pendingModelLabel,
          depth,
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

  // pending 期间的等待计时与流式进度订阅（从主 hook 拆出控制行数）。
  const { pendingElapsedSeconds, pendingOutputChars } = useOracleReviewPendingProgress({
    state,
    services,
    workspacePath: params.workspacePath,
    sessionId,
  });

  const manualReview = useCallback(() => {
    void reviewTurn("manual");
  }, [reviewTurn]);

  const deepReview = useCallback(() => {
    void reviewTurn("manual", undefined, "deep");
  }, [reviewTurn]);

  // 轮尾工具栏「审查这一回合」：按钮只在有 diff 的已完成回合渲染，这里不再重复校验。
  const reviewTurnHeader = useCallback(
    (header: TurnHeaderRow) => {
      void reviewTurn("manual", header);
    },
    [reviewTurn],
  );

  const reviewTurnHeaderDeep = useCallback(
    (header: TurnHeaderRow) => {
      void reviewTurn("manual", header, "deep");
    },
    [reviewTurn],
  );

  const dismiss = useCallback(() => {
    // 只清当前查看会话的卡片；其他会话的存量卡片（含进行中的审查）不受影响。
    if (sessionId !== null) {
      // 作废该会话在飞请求的写回：dismiss 即用户明确不想要这张卡片，
      // 进行中的审查完成后不再把卡片顶回来（代次被推高，applyIfCurrent 失效）。
      invalidateOracleReviewSeq(sessionId);
      setOracleReviewState(sessionId, { status: "idle" });
    }
  }, [sessionId]);

  return {
    state,
    enabled,
    pendingElapsedSeconds,
    pendingOutputChars,
    manualReview,
    deepReview,
    reviewTurnHeader,
    reviewTurnHeaderDeep,
    dismiss,
  };
}

export type { OracleReviewController } from "./oracleReviewSupport.js";
