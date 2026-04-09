import type { ToolDefinition } from "../api/types.js";
import { PluginDefinition } from "../plugins/index.js";
import { PermissionPolicy, type PermissionMode } from "../runtime/index.js";
import {
  loadRuntimeConfig,
  mcpToolName,
  registryFromConfig,
  registryFromConfigAsync,
  type McpServerConfig,
  type McpToolDefinition,
  type McpToolRegistry
} from "../runtime/index.js";
import type { PluginTool } from "../plugins/index.js";

export type ToolSource = "base" | "runtime" | "plugin";

export interface ToolManifestEntry {
  name: string;
  source: ToolSource;
  requiredPermission: PermissionMode;
}

export interface ToolSearchResult {
  name: string;
  source: ToolSource;
}

const BUILTIN_TOOLS: ToolManifestEntry[] = [
  { name: "read_file", source: "base", requiredPermission: "read-only" },
  { name: "grep_search", source: "base", requiredPermission: "read-only" },
  { name: "glob_search", source: "base", requiredPermission: "read-only" },
  { name: "write_file", source: "base", requiredPermission: "workspace-write" },
  { name: "bash", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "Config", source: "runtime", requiredPermission: "read-only" },
  { name: "MCP", source: "runtime", requiredPermission: "read-only" },
  { name: "ListMcpResources", source: "runtime", requiredPermission: "read-only" },
  { name: "ReadMcpResource", source: "runtime", requiredPermission: "read-only" },
  { name: "WebFetch", source: "runtime", requiredPermission: "read-only" },
  { name: "WebSearch", source: "runtime", requiredPermission: "read-only" },
  { name: "Sleep", source: "runtime", requiredPermission: "read-only" },
  { name: "StructuredOutput", source: "runtime", requiredPermission: "read-only" },
  { name: "Task", source: "runtime", requiredPermission: "read-only" },
  { name: "ToolSearch", source: "runtime", requiredPermission: "read-only" }
];

const TOOL_ALIASES = new Map<string, string>([
  ["Read", "read_file"],
  ["Write", "write_file"],
  ["Grep", "grep_search"],
  ["Glob", "glob_search"],
  ["Bash", "bash"],
  ["Config", "Config"],
  ["Mcp", "MCP"],
  ["AgentTool", "Task"]
]);

export class ToolRegistry {
  constructor(private readonly manifestEntries: ToolManifestEntry[]) {}

  entries(): ToolManifestEntry[] {
    return [...this.manifestEntries];
  }

  search(query: string, maxResults = 5): ToolSearchResult[] {
    const lowered = query.toLowerCase();
    return this.manifestEntries
      .filter((entry) => entry.name.toLowerCase().includes(lowered))
      .slice(0, maxResults)
      .map((entry) => ({ name: entry.name, source: entry.source }));
  }
}

export class GlobalToolRegistry {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissionPolicy = new PermissionPolicy("danger-full-access"),
    private readonly pluginTools = new Map<string, PluginTool>(),
    private readonly mcpRegistry?: McpToolRegistry,
    private readonly mcpTools = new Map<string, { serverName: string; toolName: string; definition: McpToolDefinition }>()
  ) {}

  static builtin(): GlobalToolRegistry {
    return new GlobalToolRegistry(new ToolRegistry(BUILTIN_TOOLS));
  }

  withPlugins(plugins: PluginDefinition[]): GlobalToolRegistry {
    const extraEntries: ToolManifestEntry[] = [];
    const pluginTools = new Map(this.pluginTools);
    for (const plugin of plugins) {
      for (const tool of plugin.tools) {
        extraEntries.push({
          name: tool.definition.name,
          source: "plugin",
          requiredPermission: tool.requiredPermission
        });
        pluginTools.set(tool.definition.name, tool);
      }
    }
    return new GlobalToolRegistry(
      new ToolRegistry([...this.registry.entries(), ...extraEntries]),
      this.permissionPolicy,
      pluginTools,
      this.mcpRegistry,
      this.mcpTools
    );
  }

  withMcpRegistry(mcpRegistry: McpToolRegistry): GlobalToolRegistry {
    return new GlobalToolRegistry(this.registry, this.permissionPolicy, this.pluginTools, mcpRegistry, this.mcpTools);
  }

  withMcpTools(mcpRegistry: McpToolRegistry): GlobalToolRegistry {
    const toolEntries: ToolManifestEntry[] = [];
    const mcpTools = new Map(this.mcpTools);
    for (const server of mcpRegistry.listServers()) {
      for (const tool of server.tools) {
        const qualifiedName = mcpToolName(server.serverName, tool.name);
        toolEntries.push({
          name: qualifiedName,
          source: "runtime",
          requiredPermission: "read-only"
        });
        mcpTools.set(qualifiedName, {
          serverName: server.serverName,
          toolName: tool.name,
          definition: tool
        });
      }
    }
    return new GlobalToolRegistry(
      new ToolRegistry([...this.registry.entries(), ...toolEntries]),
      this.permissionPolicy,
      this.pluginTools,
      mcpRegistry,
      mcpTools
    );
  }

  entries(): ToolManifestEntry[] {
    return this.registry.entries();
  }

  search(query: string, maxResults = 5): ToolSearchResult[] {
    return this.registry.search(query, maxResults);
  }

  toolDefinition(name: string): ToolDefinition | undefined {
    const entry = this.registry.entries().find((tool) => tool.name === name);
    if (entry) {
      return {
        name,
        description: defaultDescriptionForTool(name, entry.source),
        input_schema: defaultInputSchemaForTool(name)
      };
    }
    const pluginTool = this.pluginTools.get(name);
    if (!pluginTool) {
      const mcpTool = this.mcpTools.get(name);
      if (!mcpTool) {
        return undefined;
      }
      return {
        name,
        description: mcpTool.definition.description ?? `MCP tool ${mcpTool.toolName}`,
        input_schema: mcpTool.definition.inputSchema ?? { type: "object", additionalProperties: true }
      };
    }
    return {
      name: pluginTool.definition.name,
      description: pluginTool.definition.description ?? `Plugin tool ${pluginTool.definition.name}`,
      input_schema: pluginTool.definition.inputSchema
    };
  }

  normalizeAllowedTools(allowed: string[]): string[] {
    return allowed.map((tool) => {
      const canonical = TOOL_ALIASES.get(tool) ?? tool;
      const known = this.registry.entries().some((entry) => entry.name === canonical);
      if (!known && !canonical.startsWith("mcp__")) {
        throw new Error(`unknown tool '${tool}'`);
      }
      return canonical;
    });
  }

  executeTool(name: string, input: Record<string, unknown>): string {
    const entry = this.registry.entries().find((tool) => tool.name === name);
    if (!entry) {
      throw new Error(`unknown tool '${name}'`);
    }

    const authorization = this.permissionPolicy
      .withToolRequirement(entry.name, entry.requiredPermission)
      .authorize(
      entry.name,
      JSON.stringify(input)
    );
    if (authorization.type === "deny") {
      throw new Error(authorization.reason);
    }

    if (entry.name === "write_file") {
      return String(input.path ?? "written");
    }
    if (entry.name === "bash") {
      return String(input.command ?? "");
    }
    if (entry.name === "ToolSearch") {
      return JSON.stringify(this.search(String(input.query ?? ""), Number(input.maxResults ?? 5)));
    }
    if (entry.name === "Task") {
      const subagentType = String(input.subagent_type ?? "general-purpose");
      return JSON.stringify({
        subagentType,
        allowedTools: [...allowedToolsForSubagent(subagentType)]
      });
    }
    if (entry.name === "Config") {
      return JSON.stringify({
        section: input.section ?? null,
        scope: input.scope ?? "merged",
        value: input.value ?? null
      });
    }
    if (entry.name === "MCP") {
      const server = String(input.server ?? "");
      const toolName = String(input.tool ?? input.toolName ?? "");
      if (!this.mcpRegistry) {
        return JSON.stringify({
          server: input.server ?? null,
          tool: input.tool ?? input.toolName ?? null,
          arguments: input.arguments ?? {}
        });
      }
      return JSON.stringify(
        this.mcpRegistry.callTool(server, toolName, input.arguments ?? {})
      );
    }
    if (entry.name === "ListMcpResources") {
      const server = String(input.server ?? "");
      return JSON.stringify({
        server: input.server ?? null,
        resources: this.mcpRegistry ? this.mcpRegistry.listResources(server) : []
      });
    }
    if (entry.name === "ReadMcpResource") {
      const server = String(input.server ?? "");
      const uri = String(input.uri ?? "");
      if (!this.mcpRegistry) {
        return JSON.stringify({
          server: input.server ?? null,
          uri: input.uri ?? null,
          content: input.fallback ?? null
        });
      }
      return JSON.stringify(this.mcpRegistry.readResource(server, uri));
    }
    if (entry.name === "WebFetch") {
      return JSON.stringify({ url: input.url ?? null, status: "stubbed" });
    }
    if (entry.name === "WebSearch") {
      return JSON.stringify({ query: input.query ?? input.search_term ?? null, results: [] });
    }
    if (entry.name === "Sleep") {
      return String(input.duration_ms ?? input.ms ?? 0);
    }
    if (entry.name === "StructuredOutput") {
      return JSON.stringify(input);
    }
    const pluginTool = this.pluginTools.get(entry.name);
    if (pluginTool) {
      return pluginTool.execute(input);
    }
    const mcpTool = this.mcpTools.get(name);
    if (mcpTool && this.mcpRegistry) {
      return JSON.stringify(this.mcpRegistry.callTool(mcpTool.serverName, mcpTool.toolName, input));
    }
    return JSON.stringify(input);
  }

  async executeToolAsync(name: string, input: Record<string, unknown>): Promise<string> {
    const entry = this.registry.entries().find((tool) => tool.name === name);
    if (!entry) {
      throw new Error(`unknown tool '${name}'`);
    }

    const authorization = this.permissionPolicy
      .withToolRequirement(entry.name, entry.requiredPermission)
      .authorize(
      entry.name,
      JSON.stringify(input)
    );
    if (authorization.type === "deny") {
      throw new Error(authorization.reason);
    }

    if (entry.name === "MCP") {
      const server = String(input.server ?? "");
      const toolName = String(input.tool ?? input.toolName ?? "");
      if (!this.mcpRegistry) {
        return JSON.stringify({
          server: input.server ?? null,
          tool: input.tool ?? input.toolName ?? null,
          arguments: input.arguments ?? {}
        });
      }
      return JSON.stringify(await this.mcpRegistry.callToolAsync(server, toolName, input.arguments ?? {}));
    }
    if (entry.name === "ListMcpResources") {
      const server = String(input.server ?? "");
      return JSON.stringify({
        server: input.server ?? null,
        resources: this.mcpRegistry ? await this.mcpRegistry.listResourcesAsync(server) : []
      });
    }
    if (entry.name === "ReadMcpResource") {
      const server = String(input.server ?? "");
      const uri = String(input.uri ?? "");
      if (!this.mcpRegistry) {
        return JSON.stringify({
          server: input.server ?? null,
          uri: input.uri ?? null,
          content: input.fallback ?? null
        });
      }
      return JSON.stringify(await this.mcpRegistry.readResourceAsync(server, uri));
    }
    const mcpTool = this.mcpTools.get(name);
    if (mcpTool && this.mcpRegistry) {
      return JSON.stringify(await this.mcpRegistry.callToolAsync(mcpTool.serverName, mcpTool.toolName, input));
    }
    return this.executeTool(name, input);
  }

  withPermissionPolicy(policy: PermissionPolicy): GlobalToolRegistry {
    return new GlobalToolRegistry(this.registry, policy, this.pluginTools, this.mcpRegistry, this.mcpTools);
  }
}

export function normalizeAllowedTools(allowed: string[]): string[] {
  return GlobalToolRegistry.builtin().normalizeAllowedTools(allowed);
}

export function executeTool(
  name: string,
  input: Record<string, unknown>,
  permissionPolicy = new PermissionPolicy("danger-full-access")
): string {
  return GlobalToolRegistry.builtin().withPermissionPolicy(permissionPolicy).executeTool(name, input);
}

export function loadWorkspaceToolRegistry(
  cwd: string,
  permissionPolicy = new PermissionPolicy("danger-full-access")
): GlobalToolRegistry {
  const { merged } = loadRuntimeConfig(cwd);
  const enabledPlugins = Object.values(merged.plugins ?? {})
    .filter((plugin) => plugin.enabled && typeof plugin.path === "string")
    .map((plugin) => PluginDefinition.loadFromFile(plugin.path!));
  const mcpRegistry = registryFromConfig((merged.mcp ?? {}) as Record<string, McpServerConfig>);
  return GlobalToolRegistry.builtin()
    .withPlugins(enabledPlugins)
    .withMcpRegistry(mcpRegistry)
    .withMcpTools(mcpRegistry)
    .withPermissionPolicy(permissionPolicy);
}

export async function loadWorkspaceToolRegistryAsync(
  cwd: string,
  permissionPolicy = new PermissionPolicy("danger-full-access")
): Promise<GlobalToolRegistry> {
  const { merged } = loadRuntimeConfig(cwd);
  const enabledPlugins = Object.values(merged.plugins ?? {})
    .filter((plugin) => plugin.enabled && typeof plugin.path === "string")
    .map((plugin) => PluginDefinition.loadFromFile(plugin.path!));
  const mcpRegistry = await registryFromConfigAsync((merged.mcp ?? {}) as Record<string, McpServerConfig>);
  return GlobalToolRegistry.builtin()
    .withPlugins(enabledPlugins)
    .withMcpRegistry(mcpRegistry)
    .withMcpTools(mcpRegistry)
    .withPermissionPolicy(permissionPolicy);
}

export function allowedToolsForSubagent(subagentType: string): Set<string> {
  const normalized = subagentType.trim().toLowerCase();
  if (normalized === "explore") {
    return new Set([
      "read_file",
      "grep_search",
      "glob_search",
      "ToolSearch",
      "Config",
      "ListMcpResources",
      "ReadMcpResource"
    ]);
  }
  if (normalized === "plan") {
    return new Set(["read_file", "grep_search", "glob_search", "Config"]);
  }
  if (normalized === "verification") {
    return new Set(["read_file", "grep_search", "bash"]);
  }
  return new Set([
    "read_file",
    "grep_search",
    "glob_search",
    "write_file",
    "bash",
    "Config",
    "MCP",
    "ListMcpResources",
    "ReadMcpResource",
    "ToolSearch"
  ]);
}

function defaultDescriptionForTool(name: string, source: ToolSource): string {
  if (source === "plugin") {
    return `Plugin tool ${name}`;
  }
  const descriptions: Record<string, string> = {
    bash: "Run a shell command in the workspace",
    read_file: "Read a file path",
    write_file: "Write content to a file path",
    grep_search: "Search files with regex",
    glob_search: "Glob file patterns",
    Config: "Read merged runtime config",
    MCP: "Call a configured MCP tool",
    ListMcpResources: "List MCP resources",
    ReadMcpResource: "Read an MCP resource"
  };
  return descriptions[name] ?? `Tool ${name}`;
}

function defaultInputSchemaForTool(name: string): Record<string, unknown> {
  if (name === "bash") {
    return {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"]
    };
  }
  if (name === "read_file" || name === "write_file") {
    return {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    };
  }
  if (name === "MCP") {
    return {
      type: "object",
      properties: {
        server: { type: "string" },
        toolName: { type: "string" },
        arguments: { type: "object" }
      },
      required: ["server", "toolName"]
    };
  }
  if (name === "ListMcpResources" || name === "ReadMcpResource") {
    return {
      type: "object",
      properties: {
        server: { type: "string" },
        uri: { type: "string" }
      },
      required: ["server"]
    };
  }
  return {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" }
    }
  };
}
