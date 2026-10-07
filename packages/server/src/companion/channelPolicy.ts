// companion relay 频道裁决（specs §11 三分名单）：T2 直通 / T1 方法白名单 / T0 拒绝。
// 原则：默认拒绝——未登记频道一律 T0，保证 RemoteServiceAccess 的 getChannel
// 快速失败而不是在 ChannelServer 的 pending 队列里挂起。
// 宿主写方法永不下发手机（specs §11.3）：写需求走 v4 命令通道。
import type { Event, IChannel, IServerChannel } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";

export type ChannelPolicy =
  | { kind: "passthrough" }
  | { kind: "allow-calls"; calls: ReadonlySet<string> }
  | { kind: "task-scoped" }
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
 * workspace 绑定塑形（specs §11.5）：T1/T2 频道的入参一律以 attachment 绑定为
 * 准——顶层 workspacePath/workspaceIdentity 强制覆写；嵌套 workspaceScopes[]
 * （zcode-task 列表/分组视图）逐项覆写；顶层 path/rootPath 与 paths[] 必须
 * 落在工作区之内，越界即拒绝。没有这层，file/git 等只读白名单会退化成
 * 宿主任意路径读取原语。
 */
export function shapeArgsWithScope(arg: unknown, scope: PolicyWorkspaceScope): unknown {
  if (Array.isArray(arg)) {
    const [first] = arg;
    if (first && typeof first === "object" && !Array.isArray(first)) {
      return [shapeArgsWithScope(first, scope), ...arg.slice(1)];
    }
    return arg;
  }
  if (!arg || typeof arg !== "object") return arg;
  const source = arg as Record<string, unknown>;
  const shaped: Record<string, unknown> = { ...source };
  shaped.workspacePath = scope.workspacePath;
  shaped.workspaceIdentity = scope.workspaceIdentity;
  if (Array.isArray(shaped.workspaceScopes)) {
    shaped.workspaceScopes = shaped.workspaceScopes.map((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? { ...(item as Record<string, unknown>), workspacePath: scope.workspacePath, workspaceIdentity: scope.workspaceIdentity }
        : item,
    );
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
    const result = await this.upstream.call<T>(command, shapeArgsWithScope(arg, this.scope));
    this.learnFrom(result);
    return result;
  }

  listen<T>(_ctx: unknown, event: string, arg?: unknown): Event<T> {
    const inner = this.upstream.listen<T>(event, shapeArgsWithScope(arg, this.scope));
    return ((listener: (value: T) => void) =>
      inner((value: T) => {
        this.learnFrom(value);
        listener(value);
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
  const maskResponse = channelName === ServiceChannels.ProviderSettings;
  return {
    async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
      if (policy.kind === "allow-calls" && !policy.calls.has(command)) {
        logReject(`method not allowed: ${channelName}.${command}`);
        throw new Error(`companion facade: method not allowed: ${channelName}.${command}`);
      }
      try {
        const result = await upstream.call<T>(command, shapeArgsWithScope(arg, scope));
        return maskResponse ? (maskSecrets(result) as T) : result;
      } catch (error) {
        if (error instanceof Error && error.message.includes("path escapes workspace")) {
          logReject(`path escape: ${channelName}.${command}`);
        }
        throw error;
      }
    },
    listen<T>(_ctx: unknown, event: string, arg?: unknown): Event<T> {
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
