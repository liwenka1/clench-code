import { mcpToolName, type McpSdkResourceConfig, type McpSdkToolConfig } from "./mcp.js";
import {
  McpResourceDefinition,
  McpServerManager,
  McpToolDefinition,
  callMcpStdioTool,
  discoverMcpStdioServer
} from "./mcp-stdio.js";
import type { McpServerConfig } from "./mcp.js";
import { mcpClientBootstrapFromScopedConfig } from "./mcp-client.js";

export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "auth_required" | "error";

export interface McpServerState {
  serverName: string;
  status: McpConnectionStatus;
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
  serverInfo?: string;
  errorMessage?: string;
}

export class McpToolRegistry {
  private readonly servers = new Map<string, McpServerState>();
  private manager?: McpServerManager;

  setManager(manager: McpServerManager | undefined): void {
    if (manager === undefined) {
      this.manager = undefined;
      return;
    }
    if (this.manager) {
      throw new Error("MCP server manager already configured");
    }
    this.manager = manager;
  }

  registerServer(
    serverName: string,
    status: McpConnectionStatus,
    tools: McpToolDefinition[],
    resources: McpResourceDefinition[],
    serverInfo?: string,
    errorMessage?: string
  ): void {
    this.servers.set(serverName, {
      serverName,
      status,
      tools: [...tools],
      resources: [...resources],
      serverInfo,
      errorMessage
    });
  }

  getServer(serverName: string): McpServerState | undefined {
    const state = this.servers.get(serverName);
    return state ? cloneState(state) : undefined;
  }

  listServers(): McpServerState[] {
    return [...this.servers.values()].map(cloneState);
  }

  listResources(serverName: string): McpResourceDefinition[] {
    const state = this.mustBeConnected(serverName);
    return [...state.resources];
  }

  readResource(serverName: string, uri: string): McpResourceDefinition {
    const state = this.mustBeConnected(serverName);
    const resource = state.resources.find((item) => item.uri === uri);
    if (!resource) {
      throw new Error(`resource '${uri}' not found on server '${serverName}'`);
    }
    return { ...resource };
  }

  listTools(serverName: string): McpToolDefinition[] {
    const state = this.mustBeConnected(serverName);
    return [...state.tools];
  }

  callTool(serverName: string, toolName: string, argumentsValue: unknown): unknown {
    const state = this.mustBeConnected(serverName);
    if (!state.tools.some((tool) => tool.name === toolName)) {
      throw new Error(`tool '${toolName}' not found on server '${serverName}'`);
    }
    if (!this.manager) {
      throw new Error("MCP server manager is not configured");
    }
    return this.manager.callTool(mcpToolName(serverName, toolName), argumentsValue);
  }

  setAuthStatus(serverName: string, status: McpConnectionStatus): void {
    const state = this.servers.get(serverName);
    if (!state) {
      throw new Error(`server '${serverName}' not found`);
    }
    state.status = status;
  }

  disconnect(serverName: string): McpServerState | undefined {
    const state = this.servers.get(serverName);
    if (!state) {
      return undefined;
    }
    this.servers.delete(serverName);
    return cloneState(state);
  }

  len(): number {
    return this.servers.size;
  }

  isEmpty(): boolean {
    return this.servers.size === 0;
  }

  private mustBeConnected(serverName: string): McpServerState {
    const state = this.servers.get(serverName);
    if (!state) {
      throw new Error(`server '${serverName}' not found`);
    }
    if (state.status !== "connected") {
      throw new Error(`server '${serverName}' is not connected (status: ${state.status})`);
    }
    return state;
  }
}

export function registryFromConfig(
  servers: Record<string, McpServerConfig>,
  manager?: McpServerManager
): McpToolRegistry {
  const registry = new McpToolRegistry();
  const bootstrap = bootstrapServerDescriptions(servers);
  const effectiveManager = manager ?? (bootstrap.descriptions.length > 0 ? new McpServerManager(bootstrap.descriptions) : undefined);
  if (effectiveManager) {
    registry.setManager(effectiveManager);
  }
  for (const [serverName, config] of Object.entries(servers)) {
    const bootstrapState = bootstrap.states.get(serverName);
    const tools = bootstrapState?.tools ?? effectiveManager?.discoverTools(serverName)[serverName] ?? [];
    const resources = bootstrapState?.resources ?? effectiveManager?.discoverResources(serverName)[serverName] ?? [];
    registry.registerServer(
      serverName,
      bootstrapState?.status ?? inferConnectionStatus(config),
      tools,
      resources,
      bootstrapState?.serverInfo ?? summarizeServerConfig(config),
      bootstrapState?.errorMessage
    );
  }
  return registry;
}

export function managerFromConfig(
  servers: Record<string, McpServerConfig>
): McpServerManager | undefined {
  const bootstrap = bootstrapServerDescriptions(servers);
  return bootstrap.descriptions.length > 0 ? new McpServerManager(bootstrap.descriptions) : undefined;
}

export function summarizeServerConfig(config: McpServerConfig): string {
  switch (config.type) {
    case "stdio":
      return `${config.command}${config.args.length ? ` ${config.args.join(" ")}` : ""}`;
    case "http":
    case "sse":
    case "ws":
      return config.url;
    case "sdk":
      return `sdk:${config.name}`;
    case "managed_proxy":
      return `${config.url}#${config.id}`;
  }
}

function inferConnectionStatus(config: McpServerConfig): McpConnectionStatus {
  if ("oauth" in config && config.oauth) {
    return "auth_required";
  }
  return "connected";
}

function bootstrapServerDescriptions(servers: Record<string, McpServerConfig>) {
  const descriptions = Object.entries(servers).flatMap(([serverName, config]) => {
    if (config.type === "sdk") {
      return [sdkDescriptionFromConfig(serverName, config)];
    }
    if (config.type === "stdio") {
      const discovered = tryDiscoverStdioServer(serverName, config);
      return discovered ? [discovered.description] : [];
    }
    return [];
  });

  const states = new Map<
    string,
    {
      status: McpConnectionStatus;
      tools: McpToolDefinition[];
      resources: McpResourceDefinition[];
      serverInfo?: string;
      errorMessage?: string;
    }
  >();

  for (const [serverName, config] of Object.entries(servers)) {
    if (config.type === "sdk") {
      const description = sdkDescriptionFromConfig(serverName, config);
      states.set(serverName, {
        status: "connected",
        tools: description.tools ?? [],
        resources: description.resources ?? [],
        serverInfo: summarizeServerConfig(config)
      });
      continue;
    }
    if (config.type === "stdio") {
      const discovered = tryDiscoverStdioServer(serverName, config);
      if (discovered) {
        states.set(serverName, {
          status: "connected",
          tools: discovered.description.tools ?? [],
          resources: discovered.description.resources ?? [],
          serverInfo: discovered.snapshot.serverInfo ?? summarizeServerConfig(config)
        });
      } else {
        states.set(serverName, {
          status: "error",
          tools: [],
          resources: [],
          serverInfo: summarizeServerConfig(config),
          errorMessage: "stdio bootstrap failed"
        });
      }
      continue;
    }
  }

  return { descriptions, states };
}

function sdkDescriptionFromConfig(
  serverName: string,
  config: Extract<McpServerConfig, { type: "sdk" }>
) {
  return {
    serverName,
    tools: (config.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    })),
    resources: (config.resources ?? []).map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType
    })),
    handlers: Object.fromEntries(
      (config.tools ?? []).map((tool) => [tool.name, (params: unknown) => sdkToolResult(serverName, tool, params)])
    )
  };
}

function tryDiscoverStdioServer(
  serverName: string,
  config: Extract<McpServerConfig, { type: "stdio" }>
): { description: { serverName: string; tools: McpToolDefinition[]; resources: McpResourceDefinition[]; handlers: Record<string, (params?: unknown) => unknown> }; snapshot: { serverInfo?: string } } | undefined {
  try {
    const bootstrap = mcpClientBootstrapFromScopedConfig(serverName, {
      scope: "local",
      config
    });
    const snapshot = discoverMcpStdioServer(bootstrap);
    return {
      snapshot,
      description: {
        serverName,
        tools: snapshot.tools,
        resources: snapshot.resources,
        handlers: Object.fromEntries(
          snapshot.tools.map((tool) => [tool.name, (params: unknown) => callMcpStdioTool(bootstrap, tool.name, params)])
        )
      }
    };
  } catch {
    return undefined;
  }
}

function sdkToolResult(serverName: string, tool: McpSdkToolConfig, params: unknown): unknown {
  if (tool.result !== undefined) {
    return tool.result;
  }
  if (tool.text !== undefined) {
    return {
      content: [{ type: "text", text: tool.text }]
    };
  }
  return {
    structuredContent: {
      server: serverName,
      tool: tool.name,
      arguments: tool.echoArguments === false ? undefined : params
    },
    content: [{ type: "text", text: `${serverName}:${tool.name}` }]
  };
}

function cloneState(state: McpServerState): McpServerState {
  return {
    ...state,
    tools: state.tools.map((tool) => ({ ...tool })),
    resources: state.resources.map((resource) => ({ ...resource }))
  };
}
