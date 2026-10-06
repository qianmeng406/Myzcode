// companion relay 频道裁决（specs §11 三分名单）：T2 直通 / T1 方法白名单 / T0 拒绝。
// 原则：默认拒绝——未登记频道一律 T0，保证 RemoteServiceAccess 的 getChannel
// 快速失败而不是在 ChannelServer 的 pending 队列里挂起。
// 宿主写方法永不下发手机（specs §11.3）：写需求走 v4 命令通道。
import type { Event, IChannel, IServerChannel } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";

export type ChannelPolicy =
  | { kind: "passthrough" }
  | { kind: "allow-calls"; calls: ReadonlySet<string> }
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
  // T2 直通
  [ServiceChannels.ZCodeTask]: { kind: "passthrough" },
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
  // bots：状态/配置/列表读取 + 应用运行时偏好同步（Root 启动推送）；任何
  // 注册/保存/删除/测试/绑定/自动化处置不入白名单。
  [ServiceChannels.Bots]: {
    kind: "allow-calls",
    calls: new Set([
      "syncAppRuntimePreferences",
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

function normalizePath(value: string): string {
  const unified = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

function isUnderWorkspace(path: string, scope: PolicyWorkspaceScope): boolean {
  const candidate = normalizePath(path);
  const root = normalizePath(scope.workspacePath);
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * workspace 绑定塑形（specs §11.5）：T1/T2 频道的入参一律以 attachment 绑定为
 * 准——顶层 workspacePath/workspaceIdentity 强制覆写；顶层 path/rootPath 与
 * paths[] 必须落在工作区之内，越界即拒绝。没有这层，file/git 等只读白名单
 * 会退化成宿主任意路径读取原语。
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
  return {
    async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
      if (policy.kind === "allow-calls" && !policy.calls.has(command)) {
        logReject(`method not allowed: ${channelName}.${command}`);
        throw new Error(`companion facade: method not allowed: ${channelName}.${command}`);
      }
      try {
        return await upstream.call<T>(command, shapeArgsWithScope(arg, scope));
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
