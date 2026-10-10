import {
  getCapturedZCodeCuaBrokerCredentials,
  resolveContextProfile,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";
import { registerMcpTools, traceContextToLogContext } from "../deps.js";
import type { McpConnectionSnapshot, McpServerConfig, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS = 15_000;

/**
 * 只有同时携带 resolver 注入的官方 plugin id 和本进程私有 authority 的 server 才能共享
 * Computer Use 项目授权。server 名、tool 名和 manifest env 都可被第三方仿造，不能单独作为信任依据。
 */
export function computeOfficialCuaServerNames(
  servers: Record<string, McpServerConfig>,
  trustedServerNames: ReadonlySet<string>,
): Set<string> {
  const expectedAuthority = getCapturedZCodeCuaBrokerCredentials().pluginAuthority;
  const names = new Set<string>();
  if (!expectedAuthority) return names;

  for (const [name, config] of Object.entries(servers)) {
    if (!trustedServerNames.has(name)) continue;
    if (config.type !== "stdio") continue;
    if (
      config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() !==
        ZCODE_CUA_OFFICIAL_PLUGIN_ID ||
      config.env?.[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]?.trim() !== expectedAuthority
    ) {
      continue;
    }
    names.add(name);
  }
  return names;
}

export function startMcpStartup(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<McpConnectionSnapshot> | undefined {
  if (this.mcpInitialized) return this.mcpStartupPromise;

  // 极简上下文档位不下发任何 MCP 工具，但「跳过启动」不等于「初始化完成」：
  // 这里若一并置 mcpInitialized/mcpToolsRegistered，切回标准档位后 initializeMcp 会永久
  // 短路，同一 runtime 再也拿不到 MCP 工具。两个标志保持 false，退出极简后补启动即可。
  if (resolveContextProfile(this.config) === "minimal") return undefined;
  this.mcpInitialized = true;

  if (!this.mcpPort || this.config.mcp?.enabled === false) {
    this.mcpToolsRegistered = true;
    return undefined;
  }

  const servers = this.config.mcp?.servers ?? {};
  if (Object.keys(servers).length === 0) {
    const startup = Promise.all([this.mcpPort.status(), this.mcpPort.listTools()])
      .then(([statuses, tools]) => ({ statuses, tools }))
      .catch((error) => {
        this.logger?.warn("MCP existing tool discovery failed", {
          ...traceContextToLogContext(traceContext),
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.existing_tools.failed",
          module: "core.runtime",
          status: "failed",
        });
        return { statuses: {}, tools: [] };
      });
    this.mcpStartupPromise = this.trackResidencyBlockingWork(startup);
    return this.mcpStartupPromise;
  }

  const startedAt = Date.now();
  const startup = this.mcpPort
    .connectConfiguredServers(servers, {
      // authorization_code MCP 无人完成浏览器授权时，session 启动过去会等默认 5 分钟，
      // 导致模型请求迟迟不发出；session 只等 15s，授权入口由设置页 mcp/list 展示。
      oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
      trace: traceContext,
      workingDirectory: this.workingDirectory,
      workspaceIdentity: this.config.workspaceIdentity?.toString(),
    })
    .then((snapshot) => {
      const statusCounts = Object.values(snapshot.statuses).reduce<Record<string, number>>(
        (counts, status) => {
          counts[status.status] = (counts[status.status] ?? 0) + 1;
          return counts;
        },
        {},
      );
      this.logger?.info("MCP startup completed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        event: "mcp.startup.completed",
        module: "core.runtime",
        serverCount: Object.keys(servers).length,
        status: "completed",
        statusCounts,
        toolCount: snapshot.tools.length,
      });
      return snapshot;
    })
    .catch((error) => {
      this.logger?.warn("MCP startup failed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.startup.failed",
        module: "core.runtime",
        status: "failed",
      });
      return { statuses: {}, tools: [] };
    });
  this.mcpStartupPromise = this.trackResidencyBlockingWork(startup);
  this.logger?.debug("MCP startup scheduled", {
    ...traceContextToLogContext(traceContext),
    event: "mcp.startup.scheduled",
    module: "core.runtime",
    serverCount: Object.keys(servers).length,
    status: "started",
  });
  return this.mcpStartupPromise;
}

export async function initializeMcp(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (this.mcpToolsRegistered) return;

  const startup = this.startMcpStartup(traceContext);
  const mcpPort = this.mcpPort;
  if (!startup || !mcpPort) {
    // 极简跳过（startMcpStartup 未置 mcpInitialized）不是完成：保持可恢复。
    // 只有真正「无事可做」（无 port / MCP 关闭）才把注册标记为完成。
    if (this.mcpInitialized) this.mcpToolsRegistered = true;
    return;
  }
  if (this.mcpRegistrationPromise) {
    // 注册 single-flight：并发请求 / plugin reference / compact 共用一次注册，
    // 不重复 register 同名工具覆盖 handler。
    await this.mcpRegistrationPromise;
    return;
  }
  const serverCount = Object.keys(this.config.mcp?.servers ?? {}).length;

  const registration = (async () => {
    try {
      const snapshot = await startup;
      // 等待启动期间可能已切到极简档位：注册推迟到退出后，连接快照保留在
      // mcpStartupPromise 复用，不再发起第二次连接。
      if (resolveContextProfile(this.config) === "minimal") return;
      const registered = registerMcpTools(this.registry, mcpPort, snapshot.tools, {
        allowedTools: this.config.toolAllowlist,
        disallowedTools: this.config.toolDisallowlist,
        officialCuaServerNames: computeOfficialCuaServerNames(
          this.config.mcp?.servers ?? {},
          new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
        ),
      });
      if (registered.length > 0) {
        this.invalidateToolCache();
        // 注册结果进入 guidanceToolNames / 可见工具表：推进派生版本让请求边界重投影。
        this.contextProjectionRevision += 1;
      }
      this.logger?.info("MCP tools registered", {
        ...traceContextToLogContext(traceContext),
        event: "mcp.tools.registered",
        module: "core.runtime",
        registeredToolCount: registered.length,
        serverCount,
        status: "completed",
      });
    } catch (error) {
      this.mcpToolsRegistered = true;
      this.logger?.warn("MCP initialization failed", {
        ...traceContextToLogContext(traceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.initialization.failed",
        module: "core.runtime",
        status: "failed",
      });
      return;
    }
    this.mcpToolsRegistered = true;
  })();
  this.mcpRegistrationPromise = registration;
  try {
    await registration;
  } finally {
    this.mcpRegistrationPromise = undefined;
  }
}
