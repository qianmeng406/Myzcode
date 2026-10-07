// 手机端经 companion attachment 访问 agent 服务的窄化服务面。
// 从 sessions 列表实现中拆出：会话列表视图已按官方结构移除（任务行即入口），
// 会话视图与首页任务索引共用这一个访问器。
import type { IServiceAccessor } from "@zcode/services";

export interface AgentServiceLike {
  // 传输层所需的 Pick 面；通过窄化 facade 代理时全部可用。
  helloConversationV4(): Promise<unknown>;
  initializeConversationV4(clientHello: unknown): Promise<void>;
  subscribeSessionsIndexV4(params: Record<string, unknown>): Promise<{ ack: { subscriptionId: string } }>;
  resyncSessionsIndexV4(params: Record<string, unknown>): Promise<unknown>;
  unsubscribeSessionsIndexV4(params: Record<string, unknown>): Promise<void>;
  onDynamicSessionsIndexFrame(params: Record<string, unknown>): (
    listener: (frame: unknown) => void,
  ) => { dispose(): void };
  onAgentRuntimeLifecycle?(listener: (state: "available" | "unavailable") => void): {
    dispose(): void;
  };
  setMode(params: {
    workspacePath: string;
    workspaceIdentity: string;
    sessionId: string;
    mode: string;
  }): Promise<unknown>;
}

export function agentServiceOf(accessor: IServiceAccessor): AgentServiceLike {
  return (accessor as unknown as { zcodeAgentService: AgentServiceLike }).zcodeAgentService;
}
