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

/** 台账最多读这么多字节——它是人手维护的 markdown，超过这个量说明读错文件了。 */
const LEDGER_MAX_BYTES = 512 * 1024;

type LedgerLoad =
  | { kind: "loaded"; content: string }
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
  onOpenCodeViewer,
  onOpenFileLink,
  tab,
}: {
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

  const [load, setLoad] = useState<LedgerLoad>({ kind: "missing" });
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const slice = await fileService.readTextFile({
        path: ledgerPath,
        offset: 0,
        length: LEDGER_MAX_BYTES,
      });
      setLoad(slice.content.trim().length > 0 ? { kind: "loaded", content: slice.content } : { kind: "missing" });
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

  // 台账由助手在会话里写：watch workflow/ 目录（事件粒度是目录，保守全量重读），
  // 变更即抬 refreshTick 触发上面的重读 effect。watch 失败（目录尚不存在等）不影响
  // 基础功能：仍可手动刷新，tab 重挂载也会重读——与 useWatchedReaddir 同一条容错线。
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
          logger.info("[WorkflowStage] 监视台账目录失败（可手动刷新）", { ledgerDir, error });
        }
      });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [fileWatcherService, ledgerDir]);

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
        {load.kind === "error" ? (
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
                    {strip.nextAdversarial
                      ? intl.formatMessage(
                          { id: "workflow.stagePane.nextAdversarial" },
                          { stage: strip.nextAdversarial.stage, workflow: strip.nextAdversarial.workflow },
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
            <MessageResponse
              className="mx-auto w-full max-w-4xl min-w-0 break-words text-foreground"
              workspacePath={tab.workspacePath}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              onOpenCodeViewer={onOpenCodeViewer}
              onOpenFileLink={onOpenFileLink}
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
  onOpenCodeViewer,
  onOpenFileLink,
  tab,
}: {
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  tab: WorkflowStageSidePaneTab;
}) {
  return (
    <WorkflowStageContents tab={tab} onOpenCodeViewer={onOpenCodeViewer} onOpenFileLink={onOpenFileLink} />
  );
});
