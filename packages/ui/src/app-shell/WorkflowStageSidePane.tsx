import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { joinFilePath } from "@/lib/path.js";
import type { WorkflowStageSidePaneTab } from "@/lib/workspaceSidePane.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import {
  STD_WORKFLOW_LEDGER_RELATIVE_PATH,
  deriveStdWorkflowStageStrip,
  parseStdWorkflowStageMarker,
  type StdWorkflowStageState,
  type StdWorkflowStageStrip,
} from "@zcode/shared";
import { RefreshCwIcon } from "lucide-react";

/**
 * 与宿主 fileService 的文本读取硬上限一致（services/src/file/fileService.ts 的
 * MAX_TEXT_READ_BYTES）：请求更多也只会被钳到这个值，这里照实请求并消费 truncated 标记。
 */
const LEDGER_MAX_BYTES = 256 * 1024;

type LedgerLoad =
  | { kind: "loading" }
  | { kind: "loaded"; content: string; truncated: boolean }
  | { kind: "missing" }
  | { kind: "error"; message: string };

function StageChip({ stage, state }: { stage: string; state: StdWorkflowStageState }) {
  const symbol = state === "done" ? "✓" : state === "current" ? "●" : "○";
  return (
    <span
      data-workflow-stage-chip={stage}
      data-workflow-stage-state={state}
      className={
        state === "current"
          ? "inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-ui-xs font-semibold text-foreground"
          : state === "done"
            ? "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ui-xs text-emerald-600 dark:text-emerald-400"
            : "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ui-xs text-foreground-subtlest"
      }
    >
      <span aria-hidden>{symbol}</span>
      {stage}
    </span>
  );
}

function StageLane({
  label,
  stages,
}: {
  label: string;
  stages: ReadonlyArray<{ stage: string; state: StdWorkflowStageState }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-14 shrink-0 text-ui-xs text-foreground-subtlest">{label}</span>
      {stages.map((entry) => (
        <StageChip key={entry.stage} stage={entry.stage} state={entry.state} />
      ))}
    </div>
  );
}

const WorkflowStageContents = memo(function WorkflowStageContents({
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  tab,
}: {
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  tab: WorkflowStageSidePaneTab;
}) {
  const { intl } = useZCodeIntl();
  const { fileService, fileWatcherService } = useServices();
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );

  const ledgerPath = useMemo(
    () => joinFilePath(tab.workspacePath, STD_WORKFLOW_LEDGER_RELATIVE_PATH),
    [tab.workspacePath],
  );
  const ledgerDir = useMemo(
    () => joinFilePath(tab.workspacePath, "workflow"),
    [tab.workspacePath],
  );

  const [load, setLoad] = useState<LedgerLoad>({ kind: "loading" });
  const [refreshTick, setRefreshTick] = useState(0);

  // 换工作区（split pane / 切会话）时先回到 loading，避免把上一个工作区的台账
  // 留在屏幕上直到新读取完成。
  useEffect(() => {
    setLoad({ kind: "loading" });
  }, [ledgerPath]);

  const refresh = useCallback(async () => {
    try {
      const slice = await fileService.readTextFile({
        path: ledgerPath,
        offset: 0,
        length: LEDGER_MAX_BYTES,
      });
      const trimmed = slice.content.trim();
      if (trimmed.length === 0) {
        setLoad({ kind: "missing" });
        return;
      }
      setLoad({ kind: "loaded", content: slice.content, truncated: slice.truncated });
    } catch (error) {
      // 读不到与「文件不存在」在 UI 上必须是两种话：前者可能是远程工作区/权限问题，
      // 提示重试；后者是新项目的正常起点，提示先建台账。
      const message = error instanceof Error ? error.message : String(error);
      if (/no such file|not found|ENOENT/iu.test(message)) {
        setLoad({ kind: "missing" });
      } else {
        setLoad({ kind: "error", message });
      }
    }
  }, [fileService, ledgerPath]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshTick]);

  // 台账由助手在会话里写，两个 watcher 配合覆盖全生命周期：
  // 1) workflow/ 目录存在后 watch 它——台账内容变更的主信号；
  // 2) watch 工作区根（非递归，根必然存在）——捕捉 workflow/ 目录**被创建**的那一刻
  //    （新项目/接手盘点的典型时序：面板先打开、目录后出现，此时信号 1 尚 watch 不上）。
  // 两个 effect 都以 refreshTick 为依赖：手动刷新会重新尝试建立 watcher；watch 失败
  // （目录尚不存在等）只记 info 日志，不影响基础功能。
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    fileWatcherService
      .watch({ path: ledgerDir })
      .then(({ id }) => {
        if (cancelled) {
          void fileWatcherService.unwatch({ id });
          return;
        }
        const disposable = fileWatcherService.onDynamicChange(id)(() => {
          setRefreshTick((tick) => tick + 1);
        });
        cleanup = () => {
          disposable.dispose();
          void fileWatcherService.unwatch({ id });
        };
      })
      .catch((error) => {
        if (!cancelled) {
          logger.info("[WorkflowStage] 监视台账目录失败（等待目录创建）", { ledgerDir, error });
        }
      });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [fileWatcherService, ledgerDir, refreshTick]);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    fileWatcherService
      .watch({ path: tab.workspacePath })
      .then(({ id }) => {
        if (cancelled) {
          void fileWatcherService.unwatch({ id });
          return;
        }
        const disposable = fileWatcherService.onDynamicChange(id)((event) => {
          // 根是非递归 watch：只关心 workflow/ 目录的创建/更名，其余子项不产生事件。
          const changed = event.changedPath ?? "";
          if (/(^|[\\/])workflow$/iu.test(changed)) {
            setRefreshTick((tick) => tick + 1);
          }
        });
        cleanup = () => {
          disposable.dispose();
          void fileWatcherService.unwatch({ id });
        };
      })
      .catch((error) => {
        if (!cancelled) {
          logger.info("[WorkflowStage] 监视工作区根失败（可手动刷新）", {
            workspacePath: tab.workspacePath,
            error,
          });
        }
      });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [fileWatcherService, tab.workspacePath, refreshTick]);

  const strip: StdWorkflowStageStrip | null = useMemo(() => {
    if (load.kind !== "loaded") return null;
    const marker = parseStdWorkflowStageMarker(load.content);
    return marker ? deriveStdWorkflowStageStrip(marker.stage) : null;
  }, [load]);

  return (
    <div data-testid="workflow-stage-pane" className="flex size-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "workflow.stagePane.title" })}
        </h2>
        <span
          data-testid="workflow-stage-ledger-path"
          title={ledgerPath}
          className="min-w-0 flex-1 truncate text-ui-xs text-foreground-subtlest"
        >
          {STD_WORKFLOW_LEDGER_RELATIVE_PATH}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setRefreshTick((tick) => tick + 1)}
          aria-label={intl.formatMessage({ id: "workflow.stagePane.refresh" })}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {load.kind === "loading" ? (
          <p data-testid="workflow-stage-loading" className="text-ui-base text-foreground-subtlest">
            {intl.formatMessage({ id: "workflow.stagePane.loading" })}
          </p>
        ) : load.kind === "error" ? (
          <p data-testid="workflow-stage-read-error" className="text-ui-base text-foreground-subtlest">
            {intl.formatMessage({ id: "workflow.stagePane.readError" })}
          </p>
        ) : load.kind === "missing" ? (
          <p data-testid="workflow-stage-empty" className="text-ui-base text-foreground-subtlest">
            {intl.formatMessage({ id: "workflow.stagePane.empty" })}
          </p>
        ) : (
          <>
            <section className="flex flex-col gap-2 pb-4" data-testid="workflow-stage-strip">
              {strip ? (
                <>
                  {!strip.known ? (
                    <p className="text-ui-xs text-amber-600 dark:text-amber-400">
                      {intl.formatMessage(
                        { id: "workflow.stagePane.unknownStage" },
                        { stage: strip.stage },
                      )}
                    </p>
                  ) : null}
                  <StageLane
                    label={intl.formatMessage({ id: "workflow.stagePane.mainLane" })}
                    stages={strip.main}
                  />
                  <StageLane
                    label={intl.formatMessage({ id: "workflow.stagePane.frontendLane" })}
                    stages={strip.frontend}
                  />
                  <StageLane
                    label={intl.formatMessage({ id: "workflow.stagePane.backendLane" })}
                    stages={strip.backend}
                  />
                  <p className="text-ui-xs text-foreground-subtlest">
                    {intl.formatMessage({ id: "workflow.stagePane.currentStage" })}:{" "}
                    <span data-testid="workflow-stage-current" className="font-semibold text-foreground">
                      {strip.stage}
                    </span>
                    {" · "}
                    {strip.adversarialInProgress
                      ? intl.formatMessage(
                          { id: "workflow.stagePane.currentAdversarial" },
                          {
                            stage: strip.adversarialInProgress.stage,
                            workflow: strip.adversarialInProgress.workflow,
                          },
                        )
                      : strip.nextAdversarial
                        ? intl.formatMessage(
                            { id: "workflow.stagePane.nextAdversarial" },
                            {
                              stage: strip.nextAdversarial.stage,
                              workflow: strip.nextAdversarial.workflow,
                            },
                          )
                        : intl.formatMessage({ id: "workflow.stagePane.noneAdversarial" })}
                  </p>
                </>
              ) : (
                <p className="text-ui-xs text-amber-600 dark:text-amber-400">
                  {intl.formatMessage({ id: "workflow.stagePane.noMarker" })}
                </p>
              )}
            </section>
            {load.truncated ? (
              <p
                data-testid="workflow-stage-truncated"
                className="pb-2 text-ui-xs text-amber-600 dark:text-amber-400"
              >
                {intl.formatMessage({ id: "workflow.stagePane.truncated" })}
              </p>
            ) : null}
            <MessageResponse
              className="mx-auto w-full max-w-4xl min-w-0 break-words text-foreground"
              workspacePath={tab.workspacePath}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              onOpenCodeViewer={onOpenCodeViewer}
              onOpenFileLink={onOpenFileLink}
              onOpenExternalUrl={onOpenBrowserUrl}
            >
              {load.content}
            </MessageResponse>
          </>
        )}
      </div>
    </div>
  );
});

export const WorkflowStageSidePane = memo(function WorkflowStageSidePane({
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  tab,
}: {
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  tab: WorkflowStageSidePaneTab;
}) {
  return (
    <WorkflowStageContents
      tab={tab}
      onOpenBrowserUrl={onOpenBrowserUrl}
      onOpenCodeViewer={onOpenCodeViewer}
      onOpenFileLink={onOpenFileLink}
    />
  );
});
