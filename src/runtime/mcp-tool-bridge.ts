import { mcpToolName } from "./mcp.js";
import { McpResourceDefinition, McpServerManager, McpToolDefinition } from "./mcp-stdio.js";

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
    serverInfo?: string
  ): void {
    this.servers.set(serverName, {
      serverName,
      status,
      tools: [...tools],
      resources: [...resources],
      serverInfo
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

function cloneState(state: McpServerState): McpServerState {
  return {
    ...state,
    tools: state.tools.map((tool) => ({ ...tool })),
    resources: state.resources.map((resource) => ({ ...resource }))
  };
}
