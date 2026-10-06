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
  [ServiceChannels.Broadcast]: { kind: "passthrough" },
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

function neverEvent<T>(): Event<T> {
  return ((_listener: unknown) => ({ dispose: () => undefined })) as unknown as Event<T>;
}

/** 按裁决生成频道 facade：T0 快速失败；T1 白名单外拒绝；事件面仅 T0 关闭。 */
export function createPolicyChannel(options: {
  channelName: string;
  upstream: IChannel;
  policy: ChannelPolicy;
}): IServerChannel {
  const { channelName, upstream, policy } = options;
  if (policy.kind === "deny") {
    return {
      async call(): Promise<never> {
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
        throw new Error(`companion facade: method not allowed: ${channelName}.${command}`);
      }
      return upstream.call<T>(command, arg);
    },
    listen<T>(_ctx: unknown, event: string, arg?: unknown): Event<T> {
      // T1 的事件是只读事实（onDidChange 等）；T2/T1 统一放行监听。
      return upstream.listen<T>(event, arg);
    },
  };
}
