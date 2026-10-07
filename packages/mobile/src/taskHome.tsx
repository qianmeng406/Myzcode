// 任务首页：官方 WebRemoteControlMobileTaskHome 的结构复刻（证据：官方解包
// extract/pretty.js 62436-62440；文案 zh 取自官方 IntlProvider webRemoteControl.mobileHome.*）。
// 数据面与官方对齐：listWorkspaces 聚合（本产品 = gateway catalog + 只读任务索引），
// 双组织模式（按工作区 / 按时间线）+ 双排序（创建 / 更新）+ 收起全部 + 手动刷新。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CompanionClient } from "@zcode/companion/client";
import {
  groupByDay,
  loadPrefs,
  relativeTime,
  savePrefs,
  useHomeData,
  type HomePrefs,
  type HomeTask,
  type HomeWorkspace,
} from "./taskHomeData.js";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloudIcon,
  CollapseAllIcon,
  FolderIcon,
  Menu,
  MenuItem,
  MenuLabel,
  MessageIcon,
  OrganizeIcon,
  PlusIcon,
  RefreshIcon,
  ThemeMenu,
  type ThemeName,
} from "./ui.js";

type TaskStatus = "idle" | "running" | "completed" | "error";

function statusOf(task: HomeTask): TaskStatus {
  if (task.ended) return "completed";
  if (task.pending > 0) return "running";
  return "idle";
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  idle: "空闲",
  running: "运行中",
  completed: "已完成",
  error: "错误",
};

function StatusPill({ status }: { status: TaskStatus }): React.ReactElement {
  return (
    <span className={`pill ${status}`}>
      {status === "running" ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null}
      {status === "completed" ? <CheckIcon className="ic xs" /> : null}
      {STATUS_LABELS[status]}
    </span>
  );
}

export function TaskHomeView(props: {
  ensureClient: () => Promise<CompanionClient>;
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
  onOpenTask: (
    nodeId: string,
    workspacePath: string,
    workspaceIdentity: string,
    title: string,
    sessionId: string | null,
  ) => void;
  onOpenFullUi: () => void;
  onOpenSettings: () => void;
}): React.ReactElement {
  const { workspaces, error, loading, refresh } = useHomeData(props.ensureClient);
  const [prefs, setPrefs] = useState<HomePrefs>(loadPrefs);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const switchPrefs = useCallback((next: Partial<HomePrefs>): void => {
    setPrefs((previous) => {
      const merged = { ...previous, ...next };
      savePrefs(merged);
      return merged;
    });
  }, []);

  const totalTasks = workspaces.reduce((sum, workspace) => sum + workspace.tasks.length, 0);
  const connected = error === null && workspaces.length > 0;

  const sortedTasks = useMemo(() => {
    const all = workspaces.flatMap((workspace) => workspace.tasks);
    // 索引暂无 createdAt：created 排序退化为活动时间（偏好仍持久，字段随协议补齐）。
    all.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return all;
  }, [workspaces]);

  const toggleWorkspace = useCallback((key: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const workspaceByIdentity = useMemo(() => {
    const map = new Map<string, HomeWorkspace>();
    for (const workspace of workspaces) map.set(workspace.key, workspace);
    return map;
  }, [workspaces]);

  const openWorkspaceTask = (workspace: HomeWorkspace, sessionId: string | null): void => {
    props.onOpenTask(
      workspace.nodeId,
      workspace.workspacePath,
      workspace.workspaceIdentity,
      workspace.title,
      sessionId,
    );
  };

  const renderTaskRow = (
    task: HomeTask,
    owner: HomeWorkspace | null,
    opts: { variant: "carded" | "plain"; tall?: boolean; showWorkspace?: boolean; disabled?: boolean },
  ): React.ReactElement => {
    const title = task.title.trim() === "" ? "新任务" : task.title;
    return (
      <button
        key={task.sessionId}
        type="button"
        className={`task-btn${opts.variant === "carded" ? " carded" : ""}${opts.tall === true ? " tall" : ""}`}
        aria-label={`打开任务 ${title}`}
        disabled={opts.disabled === true || owner === null}
        onClick={() => {
          if (owner !== null) openWorkspaceTask(owner, task.sessionId);
        }}
      >
        <span className="left-slot">
          {task.pending > 0 && opts.variant === "carded" ? <span className="dot unread" /> : null}
        </span>
        <span className="mid">
          <span className="task-title">{title}</span>
          <span className="task-meta">
            {opts.showWorkspace === true && owner !== null ? (
              <>
                <span>{owner.title}</span>
                <span>·</span>
              </>
            ) : null}
            <span>{relativeTime(task.lastActivityAt, now)}</span>
          </span>
        </span>
        <StatusPill status={statusOf(task)} />
      </button>
    );
  };

  return (
    <div className="home">
      <header className="home-header">
        <div className="home-header-inner">
          <div className="left">
            <div className="home-title">Myzcode 远程控制</div>
            <div className="home-status">{connected ? "已连接到当前桌面窗口" : "未连接"}</div>
          </div>
          <div className="header-actions">
            <ThemeMenu theme={props.theme} onThemeChange={props.onThemeChange} />
          </div>
        </div>
      </header>
      <div className="home-scroll">
        <div className="notice-card">
          本次连接可以查看当前设备上已打开的项目、任务和会话；断开授权后需要重新配对。
        </div>
        <div className="section-head">
          <div className="left">
            <h1>当前设备上的工作区和任务</h1>
            <p className="summary">{workspaces.length} 个工作区 · {totalTasks} 个任务</p>
          </div>
          <div className="header-actions">
            {prefs.organizeBy === "workspace" && workspaces.length > 0 ? (
              <button
                type="button"
                className="iconbtn"
                aria-label="收起全部工作区"
                onClick={() => setCollapsed(new Set(workspaces.map((workspace) => workspace.key)))}
              >
                <CollapseAllIcon className="ic sm" />
              </button>
            ) : null}
            <Menu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              triggerAriaLabel="整理任务"
              trigger={(attrs) => (
                <button type="button" className="iconbtn" {...attrs}>
                  <OrganizeIcon className="ic sm" />
                </button>
              )}
            >
              <MenuLabel>整理任务</MenuLabel>
              <MenuItem
                checked={prefs.organizeBy === "workspace"}
                onClick={() => switchPrefs({ organizeBy: "workspace" })}
              >
                <FolderIcon className="ic sm" /> 按工作区
              </MenuItem>
              <MenuItem
                checked={prefs.organizeBy === "timeline"}
                onClick={() => switchPrefs({ organizeBy: "timeline" })}
              >
                <MessageIcon className="ic sm" /> 按时间线
              </MenuItem>
              <div className="menu-sep" />
              <MenuLabel>排序方式</MenuLabel>
              <MenuItem checked={prefs.sortBy === "created"} onClick={() => switchPrefs({ sortBy: "created" })}>
                <PlusIcon className="ic sm" /> 创建时间
              </MenuItem>
              <MenuItem checked={prefs.sortBy === "updated"} onClick={() => switchPrefs({ sortBy: "updated" })}>
                <RefreshIcon className="ic sm" /> 更新时间
              </MenuItem>
              <div className="menu-sep" />
              <MenuItem
                checked={false}
                onClick={() => {
                  setMenuOpen(false);
                  props.onOpenFullUi();
                }}
              >
                打开完整界面
              </MenuItem>
              <MenuItem
                checked={false}
                onClick={() => {
                  setMenuOpen(false);
                  props.onOpenSettings();
                }}
              >
                设置
              </MenuItem>
            </Menu>
            <button type="button" className="iconbtn" aria-label="刷新工作区和任务" onClick={refresh}>
              <RefreshIcon className={`ic sm${loading ? " spin" : ""}`} />
            </button>
          </div>
        </div>
        {error !== null ? <div className="error-card">{error}</div> : null}
        {loading && workspaces.length === 0 ? (
          <div className="loading-row">
            <span className="spinner" /> 加载中...
          </div>
        ) : null}
        {!loading && error === null && workspaces.length === 0 ? (
          <div className="empty-row">当前桌面窗口没有可展示的任务</div>
        ) : null}
        {prefs.organizeBy === "timeline" ? (
          <div>
            {totalTasks === 0 && workspaces.length > 0 ? (
              <div className="empty-row">当前桌面窗口没有可展示的任务</div>
            ) : null}
            {groupByDay(sortedTasks, now).map((group) => (
              <div key={group.key} className="timeline-group">
                <div className="group-label">{group.label}</div>
                {group.tasks.map((task) => {
                  const owner = taskOwner(workspaceByIdentity, task.sessionId);
                  return renderTaskRow(task, owner, { variant: "carded", tall: true, showWorkspace: true });
                })}
              </div>
            ))}
          </div>
        ) : (
          <div>
            {workspaces.map((workspace) => {
              const isCollapsed = collapsed.has(workspace.key);
              return (
                <div key={workspace.key} className="ws-card">
                  <div className="ws-head-row">
                    <button
                      type="button"
                      className="ws-toggle"
                      aria-expanded={!isCollapsed}
                      onClick={() => toggleWorkspace(workspace.key)}
                    >
                      <span className="ws-icon">
                        {workspace.kind === "remote" ? <CloudIcon /> : <FolderIcon />}
                      </span>
                      <span className="mid">
                        <span className="ws-name-row">
                          <span className="ws-name">{workspace.title}</span>
                          <span className="kind-badge">
                            {workspace.kind === "remote" ? "远程" : "本地"}
                          </span>
                          {workspace.offline ? <span className="kind-badge offline">未连接</span> : null}
                        </span>
                        <span className="ws-path">{workspace.workspacePath}</span>
                        {workspace.updatedAt !== null ? (
                          <span className="ws-updated">更新于 {relativeTime(workspace.updatedAt, now)}</span>
                        ) : null}
                      </span>
                      <span className="ws-meta">
                        {workspace.tasks.length > 0 ? `${workspace.tasks.length} 个任务` : null}
                        {isCollapsed ? <ChevronDownIcon className="ic sm" /> : <ChevronUpIcon className="ic sm" />}
                      </span>
                    </button>
                    {workspace.offline ? (
                      <button
                        type="button"
                        className="btn-outline-sm"
                        aria-label="重新连接"
                        onClick={refresh}
                      >
                        <RefreshIcon className="ic sm" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-outline-sm"
                        aria-label="新任务"
                        onClick={() => openWorkspaceTask(workspace, null)}
                      >
                        <PlusIcon className="ic sm" />
                      </button>
                    )}
                  </div>
                  {!isCollapsed ? (
                    <div className="ws-tasklist">
                      {workspace.tasks.length === 0 ? (
                        <div className="ws-empty">这个工作区暂无任务</div>
                      ) : (
                        workspace.tasks
                          .slice()
                          .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
                          .map((task) => renderTaskRow(task, workspace, { variant: "plain", disabled: workspace.offline }))
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** 任务 → 所属工作区（时间线模式打开时反查）。 */
function taskOwner(map: Map<string, HomeWorkspace>, sessionId: string): HomeWorkspace | null {
  for (const workspace of map.values()) {
    if (workspace.tasks.some((task) => task.sessionId === sessionId)) return workspace;
  }
  return null;
}
