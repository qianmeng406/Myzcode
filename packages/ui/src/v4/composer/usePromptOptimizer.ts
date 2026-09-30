import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelSelection } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";

/**
 * 提示词优化的数据层：把输入框草稿经一次**会话外的** workspace generateText 请求改写。
 *
 * 请求不走当前会话（不产生消息、不进历史），上下文刻意压到最小——草稿全文 +
 * 最近几条已发送提示词 + 项目目录名，`maxOutputTokens` 也收紧，保证「点了很快回」。
 */

const PROMPT_OPTIMIZER_QUERY_SOURCE = "prompt_optimizer";
const MAX_CONTEXT_HISTORY_ENTRIES = 6;
const MAX_CONTEXT_CHARS_PER_ENTRY = 200;
const OPTIMIZE_REQUEST_TIMEOUT_MS = 30_000;

export interface PromptOptimizerRequest {
  draft: string;
  /** 最近发送过的提示词（本 workspace），只作消解指代的上下文。 */
  history: readonly string[];
  /** 当前会话模型选择；缺席时 hook 自行读取 modelSelection 视图兜底。 */
  selection: ModelSelection | null | undefined;
}

export function buildPromptOptimizerRequestPrompt(params: {
  draft: string;
  history: readonly string[];
  projectName: string;
}): string {
  const historyLines = params.history
    .slice(0, MAX_CONTEXT_HISTORY_ENTRIES)
    .map(
      (entry, index) =>
        `${index + 1}. ${entry.length > MAX_CONTEXT_CHARS_PER_ENTRY ? `${entry.slice(0, MAX_CONTEXT_CHARS_PER_ENTRY)}…` : entry}`,
    )
    .join("\n");

  return [
    "你在优化一条将要发给编程智能体的任务提示词。把「草稿」改写成清晰、具体、可直接执行的提示词：",
    "- 保持草稿的语言与原意，不新增需求、不编造上下文里没有的细节",
    "- 结合「项目目录」与「最近发送的提示词」消解指代，把含糊表述补全成明确目标",
    "- 顺带修正错别字与语病；篇幅与草稿相当，不要展开成长文",
    "- 只输出优化后的提示词正文本身：不要解释、不要加引号、不要用代码块包裹",
    "",
    `项目目录：${params.projectName}`,
    "最近发送的提示词（仅作上下文）：",
    historyLines || "（无）",
    "",
    "草稿：",
    params.draft,
  ].join("\n");
}

/** 模型偶尔无视「只输出正文」：剥掉包壳的代码块/引号与常见的引导句。 */
export function cleanupOptimizedPromptText(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence?.[1]) {
    text = fence[1].trim();
  }
  const quote = text.match(
    /^(?:["“”«»''])([\s\S]+)(?:["“”«»''])$/,
  );
  if (quote?.[1]) {
    text = quote[1].trim();
  }
  text = text.replace(
    /^(?:好的[，,]\s*|当然[，,]\s*|优化后：|优化后的提示词：|Here is the optimized prompt:\s*|Optimized prompt:\s*)/i,
    "",
  );
  return text.trim();
}

export function usePromptOptimizer(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  locale: string;
}) {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const [optimizing, setOptimizing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const optimizingRef = useRef(false);

  useEffect(
    () => () => {
      // 卸载时中断仍在飞行的请求；失败是 best-effort。
      abortRef.current?.abort();
    },
    [],
  );

  const optimize = useCallback(
    async (request: PromptOptimizerRequest): Promise<string | null> => {
      const agentService = services?.zcodeAgentService;
      if (!agentService) {
        return null;
      }
      const draft = request.draft.trim();
      if (!draft || optimizingRef.current) {
        return null;
      }
      const selection =
        request.selection ??
        (await services?.modelSelectionService.getView().catch(() => null))?.preferredSelection ??
        null;
      if (!selection) {
        toast(intl.formatMessage({ id: "chat.composer.optimizePromptNoModel" }));
        return null;
      }

      optimizingRef.current = true;
      setOptimizing(true);
      const abortController = new AbortController();
      abortRef.current = abortController;
      const timeout = window.setTimeout(() => abortController.abort(), OPTIMIZE_REQUEST_TIMEOUT_MS);
      try {
        const result = await agentService.generateWorkspaceText({
          workspacePath: options.workspacePath,
          ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
          ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
          selection,
          prompt: buildPromptOptimizerRequestPrompt({
            draft,
            history: request.history,
            projectName: getPathLeaf(options.workspacePath) || options.workspacePath,
          }),
          querySource: PROMPT_OPTIMIZER_QUERY_SOURCE,
          signal: abortController.signal,
          requestTimeoutMs: OPTIMIZE_REQUEST_TIMEOUT_MS + 5_000,
        });
        const optimized = cleanupOptimizedPromptText(result.text);
        if (!optimized) {
          throw new Error("empty optimization output");
        }
        logger.info("[PromptOptimizer] 提示词优化完成", {
          workspacePath: options.workspacePath,
          providerId: result.selection.providerId,
          model: result.selection.modelId,
        });
        return optimized;
      } catch (error) {
        const aborted =
          abortController.signal.aborted || (error as Error)?.name === "AbortError";
        logger.warn("[PromptOptimizer] 提示词优化失败", {
          workspacePath: options.workspacePath,
          aborted,
          error: error instanceof Error ? error.message : String(error),
        });
        // 主动超时/切走不弹错误，避免“快速小请求”变成打扰。
        if (!aborted) {
          const detail =
            error instanceof Error && error.message ? ` · ${error.message.slice(0, 120)}` : "";
          toast(intl.formatMessage({ id: "chat.composer.optimizePromptFailed" }) + detail);
        }
        return null;
      } finally {
        window.clearTimeout(timeout);
        if (abortRef.current === abortController) {
          abortRef.current = null;
        }
        optimizingRef.current = false;
        setOptimizing(false);
      }
    },
    [intl, options.remoteSessionId, options.workspaceIdentity, options.workspacePath, services],
  );

  return { optimize, optimizing };
}
