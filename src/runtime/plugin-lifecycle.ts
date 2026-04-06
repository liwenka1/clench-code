export type ServerStatus = "healthy" | "degraded" | "failed";

export interface ServerHealth {
  serverName: string;
  status: ServerStatus;
  capabilities: string[];
  lastError?: string;
}

export type PluginState =
  | { state: "unconfigured" }
  | { state: "validated" }
  | { state: "starting" }
  | { state: "healthy" }
  | { state: "degraded"; healthyServers: string[]; failedServers: ServerHealth[] }
  | { state: "failed"; reason: string }
  | { state: "shutting_down" }
  | { state: "stopped" };

export interface ToolInfo {
  name: string;
  description?: string;
}

export interface ResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface DiscoveryResult {
  tools: ToolInfo[];
  resources: ResourceInfo[];
  partial: boolean;
}

export interface DegradedMode {
  availableTools: string[];
  unavailableTools: string[];
  reason: string;
}

export type PluginLifecycleEvent =
  | "config_validated"
  | "startup_healthy"
  | "startup_degraded"
  | "startup_failed"
  | "shutdown";

export class PluginHealthcheck {
  readonly lastCheck: number;
  readonly state: PluginState;

  constructor(
    readonly pluginName: string,
    readonly servers: ServerHealth[]
  ) {
    this.lastCheck = Math.floor(Date.now() / 1000);
    this.state = pluginStateFromServers(servers);
  }

  degradedMode(discovery: DiscoveryResult): DegradedMode | undefined {
    if (this.state.state !== "degraded") {
      return undefined;
    }
    return {
      availableTools: discovery.tools.map((tool) => tool.name),
      unavailableTools: this.state.failedServers.flatMap((server) => server.capabilities),
      reason: `${this.state.healthyServers.length} servers healthy, ${this.state.failedServers.length} servers failed`
    };
  }
}

export function pluginStateFromServers(servers: ServerHealth[]): PluginState {
  if (servers.length === 0) {
    return { state: "failed", reason: "no servers available" };
  }
  const healthyServers = servers
    .filter((server) => server.status !== "failed")
    .map((server) => server.serverName);
  const failedServers = servers.filter((server) => server.status === "failed");
  const hasDegraded = servers.some((server) => server.status === "degraded");

  if (failedServers.length === 0 && !hasDegraded) {
    return { state: "healthy" };
  }
  if (healthyServers.length === 0) {
    return { state: "failed", reason: `all ${failedServers.length} servers failed` };
  }
  return {
    state: "degraded",
    healthyServers,
    failedServers
  };
}
