// companion relay 频道裁决（specs §11 三分名单）：T2 直通 / T1 方法白名单 / T0 拒绝。
// 原则：默认拒绝——未登记频道一律 T0，保证 RemoteServiceAccess 的 getChannel
// 快速失败而不是在 ChannelServer 的 pending 队列里挂起。
// 宿主写方法永不下发手机（specs §11.3）：写需求走 v4 命令通道。
import type { Event, IChannel, IServerChannel } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
} from "@zcode/shared/zcode-protocol-v4";

export type ChannelPolicy =
  | { kind: "passthrough" }
  | {
      kind: "allow-calls";
      calls: ReadonlySet<string>;
      /**
       * 事件面白名单。缺省 = 沿用既有语义（事件原样转发），仅用于既有 T1 只读频道；
       * 显式给出空集合 = 该频道不得建立任何事件转发。
       */
      events?: ReadonlySet<string>;
    }
  | { kind: "task-scoped" }
  /**
   * window-controller 专用：只读任务列表 + 跨工作区任务索引帧流（specs §11.4.1）。
   * 帧是宿主投影的全量事实流，必须先按 attachment 的共享集合过滤再下发手机——
   * 未过滤会把未共享工作区的任务/工作区事实直接推给设备。
   */
  | { kind: "controller-readonly" }
  | { kind: "deny" };

/** file 只读面（specs §11.2）：文件树/差异/预览所需的全部读方法；写方法不入表。 */
const FILE_READS: readonly string[] = [
  "searchWorkspaceFiles",
  "readdir",
  "stat",
  "checkFilesExist",
  "readTextFile",
  "readMediaPreview",
  "readFileRange",
  "readBinaryPreview",
  "listWorkspaceFilesLength",
  "listWorkspaceFilesRange",
  "resolvePath",
];

/** git 只读面：仓库状态/分支/提交图/差异；一切变更操作不入表。 */
const GIT_READS: readonly string[] = [
  "getRepositorySummary",
  "getWorkspaceRepositoryInfo",
  "getLocalBranches",
  "getCommitGraph",
  "getChanges",
  "getIgnoredPaths",
  "getDiff",
  "getBranchComparison",
  "getIdentity",
  "refresh",
];

/**
 * 频道裁决表（specs §11.2）。不在表内的 ServiceChannels 一律 T0；
 * zcode-agent 不在此表——它由既有窄 facade（narrowingFacade.ts）单独注册。
 */
export const COMPANION_CHANNEL_POLICIES: Readonly<Record<string, ChannelPolicy>> = {
  // T2 直通（zcode-task 例外：task 调用面按 attachment 学到的归属校验，见 task-scoped）
  [ServiceChannels.ZCodeTask]: { kind: "task-scoped" },
  [ServiceChannels.ZCodeSession]: { kind: "passthrough" },
  [ServiceChannels.ModelSelection]: { kind: "passthrough" },
  // broadcast：仅监听（跨面板刷新事件总线）。publish 是注入面——手机可向
  // 同 daemon 的其他会话 UI 伪造事件，调用侧一律拒绝。
  [ServiceChannels.Broadcast]: { kind: "allow-calls", calls: new Set<string>([]) },
  [ServiceChannels.FileWatcher]: { kind: "passthrough" },
  [ServiceChannels.MediaPreview]: { kind: "passthrough" },
  // T1 方法白名单（只读）
  [ServiceChannels.File]: { kind: "allow-calls", calls: new Set(FILE_READS) },
  [ServiceChannels.Git]: { kind: "allow-calls", calls: new Set(GIT_READS) },
  [ServiceChannels.GitCheckpoint]: { kind: "allow-calls", calls: new Set(["diffCheckpoints"]) },
  [ServiceChannels.Setting]: { kind: "allow-calls", calls: new Set(["get"]) },
  [ServiceChannels.System]: { kind: "allow-calls", calls: new Set(["info"]) },
  // provider-settings：名义只读，但视图承载个人 Provider 的 access.apiKey——
  // 响应统一脱敏后再下发手机（秘钥不出宿主进程）。
  [ServiceChannels.ProviderSettings]: {
    kind: "allow-calls",
    calls: new Set(["getView", "refresh", "resolveModelConfig"]),
  },
  // 启动链提档（specs §11.3）：Root 首屏依赖的只读面，逐方法白名单。
  // coding-plan 只放配置/预览 getter；购买、签约、支付、绑卡等写方法永不下发。
  [ServiceChannels.CodingPlanSubscription]: {
    kind: "allow-calls",
    calls: new Set([
      "batchPreview",
      "getStaticProducts",
      "getStaticTeamProducts",
      "getStartPlanPreview",
      "getOffPeakClientConfig",
      "getDynamicWorkflowClientConfig",
      "getModelContextBudgetStrategy",
      "getForceUpdateConfig",
    ]),
  },
  // bots：状态/配置/列表读取（Root 首屏依赖）。syncAppRuntimePreferences 是
  // 写方法且作用面为全部 Bot 远端 runtime，永不下发手机（specs §11.3 规则 2）。
  [ServiceChannels.Bots]: {
    kind: "allow-calls",
    calls: new Set([
      "getStatus",
      "getConfig",
      "listWorkspaceRefs",
      "getUserConfigOptions",
      "listBots",
      "getBotStates",
    ]),
  },
  // window-controller：只读任务列表 + 任务索引帧流（specs §11.4 只读任务索引的手机侧读面）。
  // 侧栏的每工作区任务行来自这条磁盘链路（tasks-index 持久化，不需要该工作区的
  // agent 运行时在跑）；帧流是侧栏跨工作区活度（增删/置顶/归档/运行状态）的实时镜像源。
  // 写方法（mutateTask / deleteArchivedTask(s)）一律 T0。listTaskList 的响应范围由
  // shapeArgsWithScope 收窄；帧内容由 ControllerReadonlyChannel 按共享集合过滤。
  [ServiceChannels.WindowController]: { kind: "controller-readonly" },
  // onboarding-record：只读判定面（shouldOnboard/getLatestEntry/getRecords/
  // syncSettingsFromRecord）。被拒会让 Root 的引导判定回退成“需要引导”，
  // 把主界面拦在向导上。record/append/dismiss/clear 等写方法永 T0
  // （宿主侧完成过一次引导后 shouldOnboard 即为 false，手机端不再触达写路径）。
  // settings-sync：首启提示的读 + 已读记账写（纯 UI 簿记，写入内容只有
  // “提示已处理”标记；被拒会让欢迎提示每次启动循环出现）。其余同步写方法永 T0。
  [ServiceChannels.SettingsSync]: {
    kind: "allow-calls",
    calls: new Set(["getFirstRunPromptState", "markFirstRunPromptHandled"]),
  },
  [ServiceChannels.OnboardingRecord]: {
    kind: "allow-calls",
    calls: new Set(["shouldOnboard", "getLatestEntry", "getRecords", "syncSettingsFromRecord"]),
  },
};

export function policyForChannel(channelName: string): ChannelPolicy {
  return COMPANION_CHANNEL_POLICIES[channelName] ?? { kind: "deny" };
}

/** attachment 绑定的 workspace 身份（与 narrowingFacade 同语义）。 */
export interface PolicyWorkspaceScope {
  workspacePath: string;
  workspaceIdentity: string;
  /**
   * 本 attachment 允许**只读列举**的共享工作区集合（connector 的"已打开且已共享"
   * 目录，云端为已登记云工作区）。缺省 = 未知，此时 workspaceScopes[] 退回旧行为
   * （整体改写成绑定工作区），不会放宽任何范围。
   *
   * 为什么需要它：任务列表（zcode-task.listTasks / window-controller.listTaskList）
   * 是跨工作区的只读查询，手机侧栏要为每个共享工作区各查一次。若一律改写成绑定
   * 工作区，除已 attach 的工作区外全部显示「暂无任务」（会话/任务无法同步）；若完全
   * 不校验，手机就能凭任意路径读取未共享工作区的任务元数据。这里按 connector 的
   * 共享集合逐项收窄：集合内的原样放行，集合外的整项丢弃（fail-closed）。
   */
  sharedWorkspaces?: ReadonlyArray<{ workspacePath: string; workspaceIdentity: string }>;
}

/**
 * 消解 `.`/`..` 路段后再比对——纯词法前缀匹配会被 `<workspace>/../../etc`
 * 绕过（fs 侧做的是裸路径操作，无二次围栏）。越出根的 `..` 按绝对路径钳制。
 */
function resolveDotSegments(unified: string): string {
  const absolute = unified.startsWith("/");
  const segments = unified.split("/");
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!absolute) {
        stack.push("..");
      }
      continue;
    }
    stack.push(segment);
  }
  const joined = stack.join("/");
  if (absolute) return `/${joined}`;
  return joined;
}

function normalizePath(value: string): string {
  const unified = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const resolved = resolveDotSegments(unified);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isUnderWorkspace(path: string, scope: PolicyWorkspaceScope): boolean {
  const candidate = normalizePath(path);
  const root = normalizePath(scope.workspacePath);
  return candidate === root || candidate.startsWith(`${root}/`);
}

/** 本地工作区语义：identity 缺省即路径本身（与 desktopConnector.localWorkspaceIdentity 一致）。 */
function scopeIdentityKey(workspacePath: string, workspaceIdentity?: string): string {
  return normalizePath(workspaceIdentity?.trim() ? workspaceIdentity : workspacePath);
}

/** workspaceScopes[] / 顶层 workspace 目标是否命中共享集合（路径 + 身份完全一致）。 */
function isSharedWorkspaceTarget(path: string, identity: string | undefined, scope: PolicyWorkspaceScope): boolean {
  const shared = scope.sharedWorkspaces;
  if (!shared || shared.length === 0) return false;
  if (path === "") return false;
  return shared.some(
    (entry) =>
      normalizePath(entry.workspacePath) === normalizePath(path) &&
      scopeIdentityKey(entry.workspacePath, entry.workspaceIdentity) === scopeIdentityKey(path, identity),
  );
}

/**
 * workspaceScopes[] 单条的授权判定：必须与 connector 共享集合中的某一项
 * （路径 + 身份）完全一致。集合未知时返回 false——调用方据此回退旧行为。
 */
function isSharedWorkspaceScope(item: Record<string, unknown>, scope: PolicyWorkspaceScope): boolean {
  const path = typeof item.workspacePath === "string" ? item.workspacePath : "";
  const identity = typeof item.workspaceIdentity === "string" ? item.workspaceIdentity : undefined;
  return isSharedWorkspaceTarget(path, identity, scope);
}

/** 深度遍历 JSON 值，命中即回调（深度受限，防止大响应全树遍历的开销失控）。 */
function walkJson(value: unknown, visit: (node: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 8 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit, depth + 1);
    return;
  }
  const node = value as Record<string, unknown>;
  visit(node);
  for (const key of Object.keys(node)) walkJson(node[key], visit, depth + 1);
}

/** 秘钥脱敏：个人 Provider 视图里的明文 apiKey 不得出宿主进程。 */
const SECRET_KEY_PATTERN = /^(apiKey|api_key)$/;

function maskSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item, depth + 1));
  const source = value as Record<string, unknown>;
  const masked: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (SECRET_KEY_PATTERN.test(key) && typeof item === "string" && item !== "") {
      masked[key] = "••••••••";
    } else {
      masked[key] = maskSecrets(item, depth + 1);
    }
  }
  return masked;
}

/**
 * workspace 绑定塑形（specs §11.5）：T1/T2 频道的入参以 attachment 绑定为准——
 * 顶层 workspacePath/workspaceIdentity 强制覆写；嵌套 workspaceScopes[]
 * （zcode-task 列表/分组视图、window-controller.listTaskList）按共享集合逐项收窄；
 * 顶层 path/rootPath 与 paths[] 必须落在工作区之内，越界即拒绝。没有这层，
 * file/git 等只读白名单会退化成宿主任意路径读取原语。
 *
 * allowSharedTopLevelWorkspace：仅任务索引类只读频道（zcode-task）开启——它们的
 * 每工作区成员查询（listTasks/listPinnedTasks/listArchivedTasks/listDeletedTaskIds）
 * 把目标放在**顶层 workspacePath** 而不是 workspaceScopes[]，若一律改写成绑定工作区，
 * 除已 attach 工作区外的所有共享工作区都读不到任务成员（手机端表现为「暂无任务」）。
 * 开启后：请求的顶层目标命中共享集合则原样放行，未命中仍改写成绑定工作区（fail-closed）。
 * 文件/git/agent 面**不得**开启，它们的读内容必须留在所选 attachment 内。
 */
export function shapeArgsWithScope(
  arg: unknown,
  scope: PolicyWorkspaceScope,
  onDroppedScope?: (workspacePath: string) => void,
  options?: { allowSharedTopLevelWorkspace?: boolean },
): unknown {
  if (Array.isArray(arg)) {
    const [first] = arg;
    if (first && typeof first === "object" && !Array.isArray(first)) {
      return [shapeArgsWithScope(first, scope, onDroppedScope, options), ...arg.slice(1)];
    }
    return arg;
  }
  if (!arg || typeof arg !== "object") return arg;
  const source = arg as Record<string, unknown>;
  const shaped: Record<string, unknown> = { ...source };
  const requestedPath = typeof source.workspacePath === "string" ? source.workspacePath : "";
  const requestedIdentity =
    typeof source.workspaceIdentity === "string" ? source.workspaceIdentity : undefined;
  const keepTopLevel =
    options?.allowSharedTopLevelWorkspace === true &&
    isSharedWorkspaceTarget(requestedPath, requestedIdentity, scope);
  if (!keepTopLevel) {
    shaped.workspacePath = scope.workspacePath;
    shaped.workspaceIdentity = scope.workspaceIdentity;
  }
  if (Array.isArray(shaped.workspaceScopes)) {
    const sharedKnown = (scope.sharedWorkspaces?.length ?? 0) > 0;
    shaped.workspaceScopes = shaped.workspaceScopes
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
      .map((item) =>
        sharedKnown
          ? // 共享集合已知：集合内的原样保留（跨工作区只读列举），集合外整项丢弃。
            item
          : // 集合未知：保持旧行为，把每个 scope 改写成绑定工作区（不放宽范围）。
            {
              ...item,
              workspacePath: scope.workspacePath,
              workspaceIdentity: scope.workspaceIdentity,
            },
      )
      .filter((item) => {
        if (!sharedKnown || isSharedWorkspaceScope(item, scope)) return true;
        // 静默丢弃会让"手机端某工作区一直空列表"无从定位，这里留痕（只含路径）。
        onDroppedScope?.(typeof item.workspacePath === "string" ? item.workspacePath : "");
        return false;
      });
  }
  const assertInside = (key: string, value: unknown): void => {
    if (typeof value !== "string" || value.length === 0) return;
    if (!isUnderWorkspace(value, scope)) {
      throw new Error(`companion facade: path escapes workspace (${key})`);
    }
  };
  assertInside("path", shaped.path);
  assertInside("rootPath", shaped.rootPath);
  if (Array.isArray(shaped.paths)) {
    for (const item of shaped.paths) assertInside("paths[]", item);
  }
  return shaped;
}

function neverEvent<T>(): Event<T> {
  return ((_listener: unknown) => ({ dispose: () => undefined })) as unknown as Event<T>;
}

/**
 * zcode-task 的 attachment 级 task 归属校验：
 * - 列表/订阅类响应（经 workspaceScopes 覆写后只含绑定工作区的任务）里出现的
 *   {taskId, workspacePath} 对被"学习"进本附件的允许集；
 * - 任何携带 taskId 的调用（sendPrompt/closeTask/setModel/…）只放行允许集内
 *   的任务，杜绝凭猜测的 taskId 跨工作区注入 prompt / 读轨迹 / 关任务。
 * 未学习到就调用 = 拒绝（fail-closed）；UI 的正常路径总是先列表后操作。
 */
class TaskScopedChannel implements IServerChannel {
  private readonly allowedTaskIds = new Set<string>();

  /**
   * 允许以"共享集合内的其它工作区"为目标的**只读**方法（specs §11.4 只读任务索引）：
   * 手机侧栏要为每个共享工作区各查一次成员/归档/pin 摘要。写方法与按 taskId 的操作
   * 不在此列——它们必须留在 attachment 绑定的工作区内，跨工作区操作需先 attach。
   */
  private static readonly SHARED_SCOPE_READ_METHODS = new Set<string>([
    "listTasks",
    "listPinnedTasks",
    "listArchivedTasks",
    "listDeletedTaskIds",
    "listTaskList",
  ]);

  constructor(
    private readonly upstream: IChannel,
    private readonly scope: PolicyWorkspaceScope,
    private readonly logReject: (message: string) => void,
  ) {}

  private learnFrom(value: unknown): void {
    walkJson(value, (node) => {
      const taskId = node.taskId;
      const workspacePath = node.workspacePath;
      if (typeof taskId === "string" && taskId !== "" && typeof workspacePath === "string") {
        if (isUnderWorkspace(workspacePath, this.scope)) {
          this.allowedTaskIds.add(taskId);
        }
      }
    });
  }

  /**
   * 真实 RPC 经 ProxyChannel.toService 传输：调用参数是数组（[params]），
   * 只查 arg.taskId 会整体跳过校验。这里对数组逐元素、对象取自身 taskId
   * 判定；深度遍历只用于学习（响应面），不用于拒绝判定——嵌套引用
   * （如事件里的关联任务）不是本调用的目标任务，不能据以放行或误拒。
   */
  private assertTaskAllowed(arg: unknown): void {
    if (Array.isArray(arg)) {
      for (const item of arg) this.assertTaskAllowed(item);
      return;
    }
    if (!arg || typeof arg !== "object") return;
    const taskId = (arg as Record<string, unknown>).taskId;
    if (typeof taskId !== "string" || taskId === "") return;
    if (!this.allowedTaskIds.has(taskId)) {
      this.logReject(`task not in attached workspace: ${taskId.slice(0, 8)}…`);
      throw new Error("companion facade: task not in attached workspace");
    }
  }

  async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
    this.assertTaskAllowed(arg);
    const result = await this.upstream.call<T>(
      command,
      shapeArgsWithScope(
        arg,
        this.scope,
        (workspacePath) => this.logReject(`scope outside shared set: ${workspacePath}`),
        { allowSharedTopLevelWorkspace: TaskScopedChannel.SHARED_SCOPE_READ_METHODS.has(command) },
      ),
    );
    this.learnFrom(result);
    return result;
  }

  listen<T>(_ctx: unknown, event: string, arg?: unknown): Event<T> {
    // 事件面同样允许共享集合内的顶层目标：侧栏的活度机制是按工作区订阅
    // onDynamicWorkspaceEvent（workspace_task_list_changed 归属事件→bump→重读左表）。
    // 若一律把订阅目标改写成绑定工作区，手机只能收到已 attach 工作区的事件——
    // 桌面端对其它共享工作区的归档/置顶/未读变化手机永远收不到（真机复现）。
    // 事件只来自手机已获准订阅的共享工作区，与只读索引同一授权边界。
    const inner = this.upstream.listen<T>(
      event,
      shapeArgsWithScope(
        arg,
        this.scope,
        (workspacePath) => this.logReject(`scope outside shared set: ${workspacePath}`),
        { allowSharedTopLevelWorkspace: true },
      ),
    );
    return ((listener: (value: T) => void) =>
      inner((value: T) => {
        this.learnFrom(value);
        listener(value);
      })) as unknown as Event<T>;
  }
}

// ── window-controller 只读面（specs §11.4.1 跨工作区活度帧）──

interface ControllerFrameLike {
  topic?: unknown;
  subscriptionId?: unknown;
  logEpoch?: unknown;
  fromSeq?: unknown;
  toSeq?: unknown;
  payload?: unknown;
}

interface ControllerAddressLike {
  workspacePath?: unknown;
  workspaceIdentity?: unknown;
  remoteSessionId?: unknown;
}

/** 帧内出现的 workspace 目标（task address / workspace fact / removed delta）是否命中共享集合。 */
function isSharedFrameTarget(target: ControllerAddressLike | null | undefined, scope: PolicyWorkspaceScope): boolean {
  if (!target || typeof target !== "object") return false;
  const path = typeof target.workspacePath === "string" ? target.workspacePath : "";
  const identity = typeof target.workspaceIdentity === "string" ? target.workspaceIdentity : undefined;
  return isSharedWorkspaceTarget(path, identity, scope);
}

/**
 * 把宿主 controller 帧过滤到 attachment 的共享工作区集合。
 * - 只改 payload 里的行/delta 内容；帧封套（subscriptionId/logEpoch/fromSeq/toSeq/sentAt）
 *   原样保留——seq 连续性是客户端 gap 检测与 resync 的依据，绝不能因过滤而断链。
 * - 增量全部被滤掉时仍转发空增量帧（客户端按 no-op 处理），同样是保 seq 连续性。
 * - 无法识别的帧形状整体丢弃（fail-closed）并留痕；客户端会当作 gap 触发 resync 自愈。
 * 返回 null = 该帧不得下发。
 */
export function filterControllerFrameToShared<T>(
  frame: T,
  scope: PolicyWorkspaceScope,
  logReject?: (message: string) => void,
): T | null {
  const sharedKnown = (scope.sharedWorkspaces?.length ?? 0) > 0;
  if (!sharedKnown) return null;
  const record = frame as unknown as ControllerFrameLike;
  if (!record || typeof record !== "object" || typeof record.topic !== "string") {
    logReject?.("controller frame dropped: unrecognizable shape");
    return null;
  }
  const payload = record.payload as
    | { kind?: unknown; snapshot?: unknown; deltas?: unknown }
    | null
    | undefined;
  if (!payload || typeof payload !== "object" || typeof payload.kind !== "string") {
    logReject?.(`controller frame dropped: unknown payload (${record.topic})`);
    return null;
  }

  if (record.topic === CONTROLLER_TASKS_INDEX_TOPIC) {
    if (payload.kind === "snapshot") {
      const snapshot = payload.snapshot as { tasks?: unknown } | null;
      if (!snapshot || !Array.isArray(snapshot.tasks)) {
        logReject?.("controller frame dropped: malformed tasks snapshot");
        return null;
      }
      const tasks = snapshot.tasks.filter((row) =>
        isSharedFrameTarget((row as { address?: ControllerAddressLike } | null)?.address, scope),
      );
      return { ...(frame as object), payload: { kind: "snapshot", snapshot: { ...snapshot, tasks } } } as T;
    }
    if (payload.kind === "deltas") {
      const deltas = Array.isArray(payload.deltas) ? payload.deltas : null;
      if (!deltas) {
        logReject?.("controller frame dropped: malformed tasks deltas");
        return null;
      }
      const kept = deltas.filter((delta) =>
        isSharedFrameTarget(
          (delta as { address?: ControllerAddressLike; task?: { address?: ControllerAddressLike } } | null)
            ?.task?.address ??
            (delta as { address?: ControllerAddressLike } | null)?.address,
          scope,
        ),
      );
      return { ...(frame as object), payload: { kind: "deltas", deltas: kept } } as T;
    }
    logReject?.(`controller frame dropped: unknown tasks payload kind (${String(payload.kind)})`);
    return null;
  }

  if (record.topic === CONTROLLER_WORKSPACES_TOPIC) {
    if (payload.kind === "snapshot") {
      const snapshot = payload.snapshot as { workspaces?: unknown } | null;
      if (!snapshot || !Array.isArray(snapshot.workspaces)) {
        logReject?.("controller frame dropped: malformed workspaces snapshot");
        return null;
      }
      const workspaces = snapshot.workspaces.filter((fact) => isSharedFrameTarget(fact, scope));
      return {
        ...(frame as object),
        payload: { kind: "snapshot", snapshot: { ...snapshot, workspaces } },
      } as T;
    }
    if (payload.kind === "deltas") {
      const deltas = Array.isArray(payload.deltas) ? payload.deltas : null;
      if (!deltas) {
        logReject?.("controller frame dropped: malformed workspaces deltas");
        return null;
      }
      const kept = deltas.filter((delta) =>
        isSharedFrameTarget(
          (delta as { workspace?: ControllerAddressLike } | null)?.workspace ?? (delta as ControllerAddressLike),
          scope,
        ),
      );
      return { ...(frame as object), payload: { kind: "deltas", deltas: kept } } as T;
    }
    logReject?.(`controller frame dropped: unknown workspaces payload kind (${String(payload.kind)})`);
    return null;
  }

  logReject?.(`controller frame dropped: unknown topic (${record.topic})`);
  return null;
}

/**
 * window-controller 的手机读面：只读任务列表 + 按 topic 订阅任务索引帧流。
 * - `listTaskList` 走 shapeArgsWithScope（workspaceScopes[] 按共享集合收窄）；
 * - 订阅/续订/退订参数是 `.strict()` schema（topic/subscriptionId/seq），
 *   绝不能注入 workspace 键——原样透传；
 * - 帧流（onDynamicControllerFrame）逐帧过 filterControllerFrameToShared；
 * - 写方法（mutateTask / deleteArchivedTask(s)）与方法白名单外一律拒绝。
 *   帧携带的是任务**列表事实**（标题/成员/活度），据此学习 taskId 允许集会打开
 *   跨工作区操作面，因此这里刻意不学习——跨工作区操作仍必须先 attach。
 */
class ControllerReadonlyChannel implements IServerChannel {
  private static readonly READ_METHODS = new Set<string>([
    "listTaskList",
    "subscribeControllerV4",
    "resyncControllerV4",
    "unsubscribeControllerV4",
  ]);
  /** 参数需要 workspace 塑形的方法（其余 strict-schema 方法原样透传）。 */
  private static readonly SHAPED_METHODS = new Set<string>(["listTaskList"]);

  constructor(
    private readonly upstream: IChannel,
    private readonly scope: PolicyWorkspaceScope,
    private readonly logReject: (message: string) => void,
  ) {}

  async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
    if (!ControllerReadonlyChannel.READ_METHODS.has(command)) {
      this.logReject(`method not allowed: window-controller.${command}`);
      throw new Error(`companion facade: method not allowed: window-controller.${command}`);
    }
    if (command === "subscribeControllerV4" && !(this.scope.sharedWorkspaces?.length ?? 0)) {
      // 没有共享集合就无法过滤帧流：宁可拒绝订阅也不下发全量投影。
      this.logReject("controller subscribe without shared workspace set");
      throw new Error("companion facade: controller frames require a shared workspace set");
    }
    if (ControllerReadonlyChannel.SHAPED_METHODS.has(command)) {
      return this.upstream.call<T>(
        command,
        shapeArgsWithScope(arg, this.scope, (workspacePath) =>
          this.logReject(`scope outside shared set: ${workspacePath}`),
        ),
      );
    }
    return this.upstream.call<T>(command, arg);
  }

  listen<T>(_ctx: unknown, event: string, arg?: unknown): Event<T> {
    if (event !== "onDynamicControllerFrame") {
      this.logReject(`event not allowed: window-controller.${event}`);
      return neverEvent<T>();
    }
    const inner = this.upstream.listen<T>(event, arg);
    return ((listener: (value: T) => void) =>
      inner((frame: T) => {
        const filtered = filterControllerFrameToShared(frame, this.scope, this.logReject);
        if (filtered !== null) listener(filtered);
      })) as unknown as Event<T>;
  }
}

/** 按裁决生成频道 facade：T0 快速失败；T1 白名单外拒绝；事件面仅 T0 关闭。 */
export function createPolicyChannel(options: {
  channelName: string;
  upstream: IChannel;
  policy: ChannelPolicy;
  scope: PolicyWorkspaceScope;
}): IServerChannel {
  const { channelName, upstream, policy, scope } = options;
  // 拒绝留痕（只含频道/方法名，不含参数内容）：完整 UI bring-up 期用于定位
  // 缺口/越权尝试，也是运行期审计线索。
  const logReject = (message: string): void => {
    console.warn(`[companion-facade] reject ${message}`);
  };
  if (policy.kind === "deny") {
    return {
      async call(_ctx, command): Promise<never> {
        logReject(`channel not allowed: ${channelName}.${command}`);
        throw new Error(`companion facade: channel not allowed: ${channelName}`);
      },
      listen(): Event<never> {
        return neverEvent<never>();
      },
    };
  }
  if (policy.kind === "task-scoped") {
    return new TaskScopedChannel(upstream, scope, logReject);
  }
  if (policy.kind === "controller-readonly") {
    return new ControllerReadonlyChannel(upstream, scope, logReject);
  }
  const maskResponse = channelName === ServiceChannels.ProviderSettings;
  return {
    async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
      if (policy.kind === "allow-calls" && !policy.calls.has(command)) {
        logReject(`method not allowed: ${channelName}.${command}`);
        throw new Error(`companion facade: method not allowed: ${channelName}.${command}`);
      }
      try {
        const result = await upstream.call<T>(
          command,
          shapeArgsWithScope(arg, scope, (workspacePath) =>
            logReject(`scope outside shared set: ${workspacePath}`),
          ),
        );
        return maskResponse ? (maskSecrets(result) as T) : result;
      } catch (error) {
        if (error instanceof Error && error.message.includes("path escapes workspace")) {
          logReject(`path escape: ${channelName}.${command}`);
        }
        throw error;
      }
    },
    listen<T>(_ctx: unknown, event: string, arg?: unknown): Event<T> {
      // allow-calls 频道可显式声明事件面白名单；声明了就按白名单收口（空集合 = 无事件），
      // 未声明则沿用既有只读数据面（T1 事件本就是只读事实，如 broadcast.onMessage）。
      if (policy.kind === "allow-calls" && policy.events && !policy.events.has(event)) {
        logReject(`event not allowed: ${channelName}.${event}`);
        return neverEvent<T>();
      }
      // T1/T2 的事件是只读事实（onDidChange 等），监听参数同样过绑定塑形。
      try {
        return upstream.listen<T>(event, shapeArgsWithScope(arg, scope));
      } catch (error) {
        if (error instanceof Error && error.message.includes("path escapes workspace")) {
          logReject(`path escape (listen): ${channelName}.${event}`);
        }
        throw error;
      }
    },
  };
}
