import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  formatOracleCommitLine,
  isOracleDeadlineTimeoutError,
  isOracleReviewQuerySource,
  parseOracleVerdict,
  readOracleRecentCommitSubjects,
  resolveOraclePreviousReviewContext,
  resolveOracleRequestOptions,
  type OraclePreviousReviewContext,
  type OracleReviewDepth,
  type OracleReviewRequestMode,
  type OracleReviewState,
} from "./oracleReviewSupport.js";
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
 * 复审一次本回合 diff；输入框旁的手动按钮走同一管道重审最近一个已完成回合。
 *
 * 全程复用 prompt_optimizer 同款会话外请求（generateWorkspaceText，不产生消息、
 * 不进历史）；diff 来自 v4 的 conversationFileChangesV4（checkpoint artifact 聚合，
 * 不依赖 git 工作区状态）。卡片状态在模块级 store（oracleReviewStore）按会话键控，
 * 切换会话/重挂载不丢；冷恢复（内存态无持久化）后卡片消失仍是 V1 接受的边界。
 */

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
        // 单横幅设计：审查进行中（最长 ~10 分钟）的重复点击只能静默忽略——
        // 横幅此时显示「审查中」。留痕日志，避免「点了没反应」无从排查。
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
      // 诊断留痕：逐轮按钮审历史旧轮与默认「最近回合」共用本函数，日志区分入口
      // 与目标轮，便于把失败归因到具体路径。
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
      if (!header.fileChanges || header.fileChanges.files <= 0) {
        setOracleReviewState(sid, {
          status: "error",
          mode,
          failure: { kind: "no-changes" },
          depth,
        });
        return;
      }
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
      // 跨回合对照上下文：注入门槛（上次审查必须是结果态、且本次目标回合在其之后）
      // 收敛在 resolveOraclePreviousReviewContext 纯函数里；必须在置 pending 前读取
      // （pending 写入会覆盖该会话的 result 条目）。
      const previousReview: OraclePreviousReviewContext | null = resolveOraclePreviousReviewContext(
        getOracleReviewState(sid),
        header.rowId,
      );
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
        const sections = buildOracleDiffSections(fileChanges.items);
        if (sections.length === 0) {
          applyIfCurrent({ status: "error", mode, failure: { kind: "no-changes" }, depth });
          return;
        }
        const recentCommits = await readOracleRecentCommitSubjects(
          services?.gitService,
          params.workspacePath,
        );
        const result = await agentService.generateWorkspaceText({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          selection: requestOptions.selection,
          prompt: buildOracleReviewPrompt({
            userRequest: findUserRequestBeforeTurn(snapshot, header.rowId),
            diffSections: sections,
            projectName: getPathLeaf(params.workspacePath) || params.workspacePath,
            previousReview,
            ...(recentCommits ? { recentCommits } : {}),
            depth,
          }),
          querySource:
            depth === "deep" ? ORACLE_DEEP_REVIEW_QUERY_SOURCE : ORACLE_TURN_REVIEW_QUERY_SOURCE,
          // 流式传输（与主会话/子代理同一 streamText 管道）。日志观察（2026-10-01
          // 23:26-23:36，~/.zcode/v2/logs/）：一次性请求路径 8 次尝试均在 ~55-60s
          // 无产出后终止（客户端各超时均 ≥180s，可排除客户端超时）；推断为上游对
          // 静默连接的容忍窗口。流式的思考增量使连接持续活跃，避开该窗口。
          // 指纹头同源——审查请求本就走同一套 provider runtime headers。
          stream: true,
          // 深度审查：只读子代理多轮取证（core 忽略单轮 stream 语义，逐轮内部流式）。
          ...(depth === "deep" ? { agentic: true } : {}),
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
        // 客户端 deadline 到点（协议 client 的专属错误类型，RPC 层保留 name）：
        // 日志实测此时模型侧多为「每次尝试约 60s 无首 token 被掐 + 指数退避重试」
        // 循环（渠道限流或深思考无产出），干等不会好转，给专门文案指引换把关模型。
        // AbortError / ETIMEDOUT / 服务端自带 timeout 字样的错误不进此分支，走通用失败语。
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

  // 审查等待时长：pending 期间每秒跳一次，让用户确认「还在跑」。
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

  // 流式输出进度：CLI 把正文+思考的累计字符数（深度审查附轮次/工具名）按节流窗口
  // 推给宿主，经 onDynamicWorkspaceGenerateTextProgress 全局事件转发到这里；按
  // querySource（标准+深度两个来源）+ workspacePath 认领本 hook 发起的请求。
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
      if (progress.workspacePath !== params.workspacePath) return;
      setPendingOutputChars(progress.outputChars);
      // 深度审查的轮次/工具名写进 store 的 pending 条目（工具执行阶段带 toolName，
      // 生成阶段不带——直接赋值让上一次的工具名随新轮次清空）。
      if (sessionId !== null && (progress.round !== undefined || progress.toolName)) {
        const current = getOracleReviewState(sessionId);
        if (current.status === "pending") {
          setOracleReviewState(sessionId, {
            ...current,
            ...(progress.round !== undefined ? { round: progress.round } : {}),
            toolName: progress.toolName,
          });
        }
      }
    });
    return () => {
      disposable.dispose();
    };
  }, [state.status, services, params.workspacePath, sessionId]);

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
    dismiss,
  };
}

/** SessionPane → composer / 行渲染注入的完整控制面；composer 不再自持 hook 实例。 */
export interface OracleReviewController {
  state: OracleReviewState;
  enabled: boolean;
  /** pending 已等待秒数（每秒跳动）；结果/错误态归零。 */
  pendingElapsedSeconds: number;
  /** pending 期间模型已累计输出的字符数（正文+思考，CLI 流式进度推送）；非 pending 归零。 */
  pendingOutputChars: number;
  manualReview: () => void;
  /** 深度审查（只读子代理多轮取证）：仅手动入口，成本数倍于标准审查。 */
  deepReview: () => void;
  reviewTurnHeader: (header: TurnHeaderRow) => void;
  dismiss: () => void;
  /** 把关模型偏好（localStorage 全局）；下拉的受控值。 */
  model: ModelSelection | null;
  onSelectModel: (selection: ModelSelection | null) => void;
}
