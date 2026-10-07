// companion 完整 UI 的目标选择屏：目录中有多个候选工作区时不再静默取
// 第一项——节点分组展示（复用轻量目录的信息结构），用户点选后进入。
import type { CompanionCatalogResult } from "@zcode/shared/companion-protocol";

export interface PickedTarget {
  nodeId: string;
  workspacePath: string;
  workspaceIdentity: string;
  title: string;
}

function isChineseLocale(): boolean {
  return /^zh\b/i.test(navigator.language);
}

export function renderCompanionTargetPicker(
  catalog: CompanionCatalogResult,
  onPick: (target: PickedTarget) => void,
  render: (tree: React.ReactNode) => void,
): void {
  const zh = isChineseLocale();
  render(
    <div className="h-dvh min-h-dvh w-screen overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-md flex-col px-4 pb-8 pt-8">
        <header>
          <h1 className="text-ui-sm font-semibold">{zh ? "选择要打开的工作区" : "Open a workspace"}</h1>
          <p className="mt-1 text-ui-xs text-foreground-subtle">
            {zh
              ? "多台设备或多个工作区可用；选择将在此设备记住。"
              : "Pick one target; the choice is remembered on this device."}
          </p>
        </header>
        {catalog.nodes
          .filter((node) => node.online && node.workspaces.some((workspace) => workspace.available))
          .map((node) => (
            <section key={node.nodeId} className="mt-5">
              <div className="flex items-center gap-2 text-ui-xs text-foreground-subtle">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                <span className="font-medium text-foreground">{node.displayName}</span>
                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] leading-none">
                  {node.kind === "cloud" ? (zh ? "云端" : "Cloud") : zh ? "电脑" : "Desktop"}
                </span>
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {node.workspaces
                  .filter((workspace) => workspace.available)
                  .map((workspace) => (
                    <button
                      key={workspace.workspaceIdentity}
                      type="button"
                      className="w-full rounded-xl border border-card-border bg-card px-4 py-3 text-left hover:bg-surface-hover"
                      onClick={() =>
                        onPick({
                          nodeId: node.nodeId,
                          workspacePath: workspace.workspacePath,
                          workspaceIdentity: workspace.workspaceIdentity,
                          title: workspace.title,
                        })
                      }
                    >
                      <div className="text-ui-xs font-medium">{workspace.title}</div>
                      <div className="mt-0.5 truncate text-ui-xs text-foreground-subtle">
                        {workspace.workspacePath}
                      </div>
                    </button>
                  ))}
              </div>
            </section>
          ))}
      </div>
    </div>,
  );
}
