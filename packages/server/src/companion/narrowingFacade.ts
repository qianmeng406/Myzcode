// 手机 → resident 的窄化 facade：把既有 IZCodeAgentService 通道按白名单转发，
// 并把绑定的 workspace 身份注入每个请求参数（客户端声明一律覆盖，防越权）。
// 事件顺序：relay 连接建立 → facade 注册到本连接的 ChannelServer → 手机的
// subscribe/listen 全部经此转发；relay 断开只 dispose 本连接的 ChannelServer。
import type { Event, IChannel, IServerChannel } from "@zcode/rpc";

/** 首版手机操作面（spec §5）：v4 会话控制 + 只读面；其余一律拒绝。 */
const ALLOWED_CALLS = new Set<string>([
  // v4 握手（客户端 hello；setConnectionFlowStateV4 属 trusted relay，绝不暴露）
  "helloConversationV4",
  "initializeConversationV4",
  // v4 会话订阅/恢复/历史
  "subscribeConversationV4",
  "resyncConversationV4",
  "unsubscribeConversationV4",
  "conversationRowsRangeV4",
  "conversationPlansV4",
  // 会话索引
  "subscribeSessionsIndexV4",
  "resyncSessionsIndexV4",
  "unsubscribeSessionsIndexV4",
  // 命令与对账
  "sendConversationCommandV4",
  "queryConversationCommandsV4",
  // 只读面
  "conversationFileChangesV4",
  "conversationWorkflowRunEventsV4",
  "conversationWorkflowRunsV4",
  "conversationWorkflowRunArtifactsV4",
  "conversationWorkflowRunArtifactDataV4",
  "conversationWorkflowRunArtifactReadV4",
  "conversationWorkflowRunWorkspaceV4",
  "conversationWorkflowRunNodeResultV4",
  "conversationAttachmentReadV4",
  "conversationAttachmentStatV4",
]);

/** v4 命令 payload 白名单：手机首版只允许这四种（spec §2）。 */
const ALLOWED_COMMAND_TYPES = new Set<string>([
  "createSession",
  "sendText",
  "stop",
  "resolveInteraction",
]);

/** workspace 级事件面：会话/索引/工作区配置帧；telemetry 与 CUA 观察面不下发。 */
const ALLOWED_LISTENS = new Set<string>([
  "onDynamicConversationFrame",
  "onDynamicSessionsIndexFrame",
  "onDynamicWorkspaceConfigFrame",
]);

export interface BoundWorkspaceScope {
  workspacePath: string;
  workspaceIdentity: string;
}

export interface NarrowingFacadeOptions {
  upstream: IChannel;
  scope: BoundWorkspaceScope;
}

/** 把 [params] 形式的调用参数注入绑定 workspace；无参调用原样透传。 */
function injectScope(arg: unknown, scope: BoundWorkspaceScope): unknown {
  if (Array.isArray(arg)) {
    const [first] = arg;
    if (first && typeof first === "object" && !Array.isArray(first)) {
      return [
        {
          ...(first as Record<string, unknown>),
          workspacePath: scope.workspacePath,
          workspaceIdentity: scope.workspaceIdentity,
        },
        ...arg.slice(1),
      ];
    }
    return arg;
  }
  return arg;
}

export function createNarrowingAgentFacade(options: NarrowingFacadeOptions): IServerChannel {
  const { upstream, scope } = options;
  return {
    async call<T>(ctx: unknown, command: string, arg?: unknown): Promise<T> {
      if (!ALLOWED_CALLS.has(command)) {
        throw new Error(`companion facade: method not allowed: ${command}`);
      }
      if (command === "sendConversationCommandV4") {
        const [first] = Array.isArray(arg) ? arg : [];
        const commandType =
          first && typeof first === "object"
            ? (first as { command?: { type?: unknown } }).command?.type
            : undefined;
        if (typeof commandType !== "string" || !ALLOWED_COMMAND_TYPES.has(commandType)) {
          throw new Error(`companion facade: command type not allowed: ${String(commandType)}`);
        }
      }
      const result = await upstream.call<T>(command, injectScope(arg, scope));
      return result;
    },
    listen<T>(ctx: unknown, event: string, arg?: unknown): Event<T> {
      if (!ALLOWED_LISTENS.has(event)) {
        // 返回空事件：never fire。比抛错更安全（listen 不在 promise 链上）。
        return ((_listener: unknown) => ({ dispose: () => undefined })) as unknown as Event<T>;
      }
      return upstream.listen<T>(event, injectScope(arg, scope));
    },
  };
}
