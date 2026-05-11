import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
import {
  allowedToolsForSubagent,
  executeTaskTeamCronTool,
  isTaskTeamCronTool
} from "./task-tools.js";
import { executeWebFetch, executeWebSearch } from "./web-tools.js";

export {
  extractPdfText,
  extractPdfTextFromBytes,
  looksLikePdfPath,
  maybeExtractPdfFromPrompt
} from "./pdf-extract.js";
export { allowedToolsForSubagent } from "./task-tools.js";

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
  { name: "TaskCreate", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "RunTaskPacket", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "TaskGet", source: "runtime", requiredPermission: "read-only" },
  { name: "TaskList", source: "runtime", requiredPermission: "read-only" },
  { name: "TaskStop", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "TaskUpdate", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "TaskOutput", source: "runtime", requiredPermission: "read-only" },
  { name: "TaskMessages", source: "runtime", requiredPermission: "read-only" },
  { name: "TaskDelete", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "TeamCreate", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "TeamDelete", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "TeamMessage", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "TeamRun", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "CronCreate", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "CronDelete", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "CronDisable", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "CronRun", source: "runtime", requiredPermission: "danger-full-access" },
  { name: "CronList", source: "runtime", requiredPermission: "read-only" },
  { name: "ToolSearch", source: "runtime", requiredPermission: "read-only" }
];

const TOOL_ALIASES = new Map<string, string>([
  ["Read", "read_file"],
  ["read", "read_file"],
  ["Write", "write_file"],
  ["write", "write_file"],
  ["Grep", "grep_search"],
  ["grep", "grep_search"],
  ["Glob", "glob_search"],
  ["glob", "glob_search"],
  ["Bash", "bash"],
  ["bash", "bash"],
  ["Config", "Config"],
  ["config", "Config"],
  ["Mcp", "MCP"],
  ["mcp", "MCP"],
  ["task", "Task"],
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
    const canonical = canonicalToolName(name);
    const entry = this.registry.entries().find((tool) => tool.name === canonical);
    if (entry) {
      return {
        name: entry.name,
        description: defaultDescriptionForTool(entry.name, entry.source),
        input_schema: defaultInputSchemaForTool(entry.name)
      };
    }
    const pluginTool = this.pluginTools.get(canonical);
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
      const canonical = canonicalToolName(tool);
      const known = this.registry.entries().some((entry) => entry.name === canonical);
      if (!known && !canonical.startsWith("mcp__")) {
        throw new Error(`unknown tool '${tool}'`);
      }
      return canonical;
    });
  }

  executeTool(name: string, input: Record<string, unknown>): string {
    const canonicalName = canonicalToolName(name);
    const entry = this.registry.entries().find((tool) => tool.name === canonicalName);
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
    if (entry.name === "read_file") {
      return JSON.stringify(executeReadFile(input));
    }
    if (entry.name === "grep_search") {
      return JSON.stringify(executeGrepSearch(input));
    }
    if (entry.name === "glob_search") {
      return JSON.stringify(executeGlobSearch(input));
    }
    if (entry.name === "bash") {
      return JSON.stringify(executeBash(input));
    }
    if (entry.name === "ToolSearch") {
      return JSON.stringify(this.search(String(input.query ?? ""), Number(input.maxResults ?? 5)));
    }
    if (isTaskTeamCronTool(entry.name)) {
      return executeTaskTeamCronTool(entry.name, input);
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
      throw new Error("WebFetch requires async execution");
    }
    if (entry.name === "WebSearch") {
      throw new Error("WebSearch requires async execution");
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
    const mcpTool = this.mcpTools.get(canonicalName);
    if (mcpTool && this.mcpRegistry) {
      return JSON.stringify(this.mcpRegistry.callTool(mcpTool.serverName, mcpTool.toolName, input));
    }
    return JSON.stringify(input);
  }

  async executeToolAsync(name: string, input: Record<string, unknown>): Promise<string> {
    const canonicalName = canonicalToolName(name);
    const entry = this.registry.entries().find((tool) => tool.name === canonicalName);
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
    if (entry.name === "WebFetch") {
      return JSON.stringify(await executeWebFetch(input));
    }
    if (entry.name === "WebSearch") {
      return JSON.stringify(await executeWebSearch(input));
    }
    const mcpTool = this.mcpTools.get(canonicalName);
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

export function canonicalToolName(tool: string): string {
  return TOOL_ALIASES.get(tool) ?? tool;
}

export function executeTool(
  name: string,
  input: Record<string, unknown>,
  permissionPolicy = new PermissionPolicy("danger-full-access")
): string {
  return GlobalToolRegistry.builtin().withPermissionPolicy(permissionPolicy).executeTool(name, input);
}

function executeReadFile(input: Record<string, unknown>): { path: string; content: string; size: number } {
  const filePath = resolveToolPath(requiredString(input.path ?? input.file_path ?? input.filePath, "path"));
  const content = fs.readFileSync(filePath, "utf8");
  return {
    path: filePath,
    content,
    size: Buffer.byteLength(content, "utf8")
  };
}

function executeBash(input: Record<string, unknown>): {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
} {
  const command = requiredString(input.command, "command");
  const cwd = resolveToolPath(optionalString(input.cwd) ?? process.cwd());
  const timeoutMs = coercePositiveInteger(input.timeout_ms ?? input.timeoutMs ?? input.timeout, 30_000);
  const result = spawnSync(command, {
    cwd,
    shell: process.env.SHELL || "/bin/sh",
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024
  });
  return {
    command,
    cwd,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
    signal: result.signal
  };
}

function executeGlobSearch(input: Record<string, unknown>): {
  pattern: string;
  path: string;
  matches: string[];
  num_matches: number;
} {
  const pattern = requiredString(input.glob_pattern ?? input.pattern ?? input.glob, "glob_pattern");
  const basePath = resolveToolPath(optionalString(input.path) ?? process.cwd());
  const maxResults = coercePositiveInteger(input.max_results ?? input.maxResults ?? input.limit, 200);
  const matcher = globMatcher(pattern);
  const matches = listTextFileCandidates(basePath)
    .map((filePath) => path.relative(basePath, filePath) || path.basename(filePath))
    .filter((relativePath) => matcher(relativePath))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maxResults);
  return {
    pattern,
    path: basePath,
    matches,
    num_matches: matches.length
  };
}

function executeGrepSearch(input: Record<string, unknown>): {
  pattern: string;
  path: string;
  matches: Array<{ path: string; line_number: number; line: string }>;
  num_matches: number;
  num_files: number;
} {
  const pattern = requiredString(input.pattern ?? input.query, "pattern");
  const basePath = resolveToolPath(optionalString(input.path) ?? process.cwd());
  const maxResults = coercePositiveInteger(input.max_results ?? input.maxResults ?? input.limit, 200);
  const flags = input.case_sensitive === false || input.caseSensitive === false ? "i" : "";
  const regex = new RegExp(pattern, flags);
  const matches: Array<{ path: string; line_number: number; line: string }> = [];
  const files = fs.existsSync(basePath) && fs.statSync(basePath).isFile() ? [basePath] : listTextFileCandidates(basePath);
  const matchedFiles = new Set<string>();

  for (const filePath of files) {
    if (matches.length >= maxResults) {
      break;
    }
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= maxResults) {
        break;
      }
      if (regex.test(lines[index] ?? "")) {
        const relativePath = path.relative(fs.statSync(basePath).isFile() ? path.dirname(basePath) : basePath, filePath) || path.basename(filePath);
        matches.push({ path: relativePath, line_number: index + 1, line: lines[index] ?? "" });
        matchedFiles.add(filePath);
      }
    }
  }

  return {
    pattern,
    path: basePath,
    matches,
    num_matches: matches.length,
    num_files: matchedFiles.size
  };
}

function requiredString(value: unknown, field: string): string {
  const resolved = optionalString(value);
  if (!resolved) {
    throw new Error(`${field} is required`);
  }
  return resolved;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveToolPath(value: string): string {
  return path.resolve(process.cwd(), value);
}

function coercePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function listTextFileCandidates(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) {
    return out;
  }
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    return [root];
  }
  if (!stat.isDirectory()) {
    return out;
  }
  walkDirectory(root, out);
  return out;
}

function walkDirectory(directory: string, out: string[]): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(entryPath, out);
      continue;
    }
    if (entry.isFile()) {
      out.push(entryPath);
    }
  }
}

function globMatcher(rawPattern: string): (relativePath: string) => boolean {
  const normalizedPattern = normalizeGlobPattern(rawPattern);
  const regex = new RegExp(`^${globToRegExpSource(normalizedPattern)}$`);
  return (relativePath) => regex.test(relativePath.split(path.sep).join("/"));
}

function normalizeGlobPattern(pattern: string): string {
  const normalized = pattern.split(path.sep).join("/");
  return normalized.includes("/") ? normalized : `**/${normalized}`;
}

function globToRegExpSource(pattern: string): string {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      const following = pattern[index + 2];
      if (following === "/") {
        out += "(?:.*/)?";
        index += 2;
      } else {
        out += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += escapeRegExp(char);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
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
    TaskCreate: "Create a background task record",
    RunTaskPacket: "Create a task from a task packet",
    TaskGet: "Read a task record by id",
    TaskList: "List known task records",
    TaskStop: "Stop a task record",
    TaskUpdate: "Append a user message to a task record",
    TaskOutput: "Read accumulated output for a task record",
    TaskMessages: "Read recorded messages for a task record",
    TaskDelete: "Delete a task record",
    TeamCreate: "Create a task team",
    TeamDelete: "Delete a task team",
    TeamMessage: "Append a message to all tasks in a team",
    TeamRun: "Mark all tasks in a team as running",
    CronCreate: "Create a cron entry",
    CronDelete: "Delete a cron entry",
    CronDisable: "Disable a cron entry",
    CronRun: "Trigger a cron entry immediately",
    CronList: "List cron entries",
    Config: "Read merged runtime config",
    MCP: "Call a configured MCP tool",
    ListMcpResources: "List MCP resources",
    ReadMcpResource: "Read an MCP resource",
    WebFetch: "Fetch a URL and summarize the content",
    WebSearch: "Search the web and return cited results"
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
  if (name === "TaskCreate") {
    return {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: { type: "string" }
      },
      required: ["prompt"]
    };
  }
  if (name === "RunTaskPacket") {
    return {
      type: "object",
      properties: {
        objective: { type: "string" },
        scope: { type: "string" },
        repo: { type: "string" },
        branch_policy: { type: "string" },
        acceptance_tests: { type: "array", items: { type: "string" } },
        commit_policy: { type: "string" },
        reporting_contract: { type: "string" },
        escalation_policy: { type: "string" }
      },
      required: [
        "objective",
        "scope",
        "repo",
        "branch_policy",
        "acceptance_tests",
        "commit_policy",
        "reporting_contract",
        "escalation_policy"
      ]
    };
  }
  if (name === "TaskGet" || name === "TaskStop" || name === "TaskOutput" || name === "TaskMessages" || name === "TaskDelete") {
    return {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"]
    };
  }
  if (name === "TaskUpdate") {
    return {
      type: "object",
      properties: {
        task_id: { type: "string" },
        message: { type: "string" }
      },
      required: ["task_id", "message"]
    };
  }
  if (name === "TaskList") {
    return {
      type: "object",
      properties: {},
      additionalProperties: false
    };
  }
  if (name === "TeamCreate") {
    return {
      type: "object",
      properties: {
        name: { type: "string" },
        tasks: { type: "array", items: { type: "object" } }
      },
      required: ["name", "tasks"]
    };
  }
  if (name === "TeamDelete") {
    return {
      type: "object",
      properties: { team_id: { type: "string" } },
      required: ["team_id"]
    };
  }
  if (name === "TeamMessage") {
    return {
      type: "object",
      properties: {
        team_id: { type: "string" },
        message: { type: "string" }
      },
      required: ["team_id", "message"]
    };
  }
  if (name === "TeamRun") {
    return {
      type: "object",
      properties: {
        team_id: { type: "string" }
      },
      required: ["team_id"]
    };
  }
  if (name === "CronCreate") {
    return {
      type: "object",
      properties: {
        schedule: { type: "string" },
        prompt: { type: "string" },
        description: { type: "string" },
        team_id: { type: "string" }
      },
      required: ["schedule", "prompt"]
    };
  }
  if (name === "CronDelete") {
    return {
      type: "object",
      properties: { cron_id: { type: "string" } },
      required: ["cron_id"]
    };
  }
  if (name === "CronDisable" || name === "CronRun") {
    return {
      type: "object",
      properties: { cron_id: { type: "string" } },
      required: ["cron_id"]
    };
  }
  if (name === "CronList") {
    return {
      type: "object",
      properties: {},
      additionalProperties: false
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
  if (name === "WebFetch") {
    return {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        prompt: { type: "string" }
      },
      required: ["url", "prompt"],
      additionalProperties: false
    };
  }
  if (name === "WebSearch") {
    return {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2 },
        search_term: { type: "string", minLength: 2 },
        allowed_domains: { type: "array", items: { type: "string" } },
        blocked_domains: { type: "array", items: { type: "string" } }
      },
      additionalProperties: false
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

