import { WorkspaceFileTree } from "@/WorkspaceFileTree.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

/**
 * 侧边面板的「文件」标签：复用工作区边栏的文件树（搜索 / git 过滤 / 右键菜单全部一致）。
 *
 * 树不持有自己的预览面：点文件经 `onOpenCodeViewer` 打开 side pane 的 code viewer tab，
 * 与消息里点文件同一条路；source 补上 workspace 作用域，远程 workspace 也能用正确 host 读文件。
 */
export function FileExplorerSidePane({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  canOpenLocalFileManager = false,
  onOpenBrowserUrl,
  onOpenCodeViewer,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  canOpenLocalFileManager?: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer: (source: CodeViewerSource) => void;
}) {
  return (
    <WorkspaceFileTree
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={workspaceRemoteSessionId}
      canOpenLocalFileManager={canOpenLocalFileManager}
      onOpenBrowserUrl={onOpenBrowserUrl}
      onOpenPreview={(source) => {
        onOpenCodeViewer({
          ...source,
          workspacePath,
          workspaceIdentity,
          workspaceRemoteSessionId,
        });
      }}
    />
  );
}
