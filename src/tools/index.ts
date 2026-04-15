import type { ToolDefinition } from "../api/types.js";
import { PluginDefinition } from "../plugins/index.js";
import { PermissionPolicy, type PermissionMode } from "../runtime/index.js";
import {
  assignTaskTeam,
  createCron,
  createTask,
  createTaskFromPacket,
  createTeam,
  deleteTask,
  deleteCron,
  deleteTeam,
  disableCron,
  getGlobalCronRegistry,
  getGlobalTaskRegistry,
  getGlobalTeamRegistry,
  loadRuntimeConfig,
  messageTeam,
  mcpToolName,
  registryFromConfig,
  registryFromConfigAsync,
  runTeam,
  runCron,
  stopTask,
  type TaskPacket,
  updateTask,
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
    if (entry.name === "TaskCreate") {
      return JSON.stringify(serializeTaskSummary(createTask(String(input.prompt ?? ""), optionalString(input.description))));
    }
    if (entry.name === "RunTaskPacket") {
      return JSON.stringify(serializeTaskSummary(createTaskFromPacket(normalizeTaskPacketInput(input))));
    }
    if (entry.name === "TaskGet") {
      const taskId = String(input.task_id ?? "");
      const task = getGlobalTaskRegistry().get(taskId);
      if (!task) {
        throw new Error(`task not found: ${taskId}`);
      }
      return JSON.stringify(serializeTaskDetail(task));
    }
    if (entry.name === "TaskList") {
      const tasks = getGlobalTaskRegistry().list();
      return JSON.stringify({
        tasks: tasks.map((task) => serializeTaskListEntry(task)),
        count: tasks.length
      });
    }
    if (entry.name === "TaskStop") {
      const taskId = String(input.task_id ?? "");
      const task = stopTask(taskId);
      return JSON.stringify({
        task_id: task.taskId,
        status: task.status,
        message: "Task stopped"
      });
    }
    if (entry.name === "TaskUpdate") {
      const taskId = String(input.task_id ?? "");
      const message = String(input.message ?? "");
      const task = updateTask(taskId, message);
      return JSON.stringify({
        task_id: task.taskId,
        status: task.status,
        message_count: task.messages.length,
        last_message: message
      });
    }
    if (entry.name === "TaskOutput") {
      const taskId = String(input.task_id ?? "");
      const output = getGlobalTaskRegistry().output(taskId);
      return JSON.stringify({
        task_id: taskId,
        output,
        has_output: Boolean(output)
      });
    }
    if (entry.name === "TaskMessages") {
      const taskId = String(input.task_id ?? "");
      const task = getGlobalTaskRegistry().get(taskId);
      if (!task) {
        throw new Error(`task not found: ${taskId}`);
      }
      return JSON.stringify({
        task_id: task.taskId,
        messages: task.messages.map((message) => ({
          role: message.role,
          content: message.content,
          timestamp: message.timestamp
        })),
        count: task.messages.length
      });
    }
    if (entry.name === "TaskDelete") {
      const taskId = String(input.task_id ?? "");
      const task = deleteTask(taskId);
      return JSON.stringify({
        task_id: task.taskId,
        status: "deleted",
        message: "Task deleted"
      });
    }
    if (entry.name === "TeamCreate") {
      const taskIds = normalizeTeamTaskIds(input);
      const team = createTeam(String(input.name ?? ""), taskIds);
      for (const taskId of team.taskIds) {
        try {
          assignTaskTeam(taskId, team.teamId);
        } catch {
          // Keep parity with reference behavior: missing tasks don't block team creation.
        }
      }
      return JSON.stringify({
        team_id: team.teamId,
        name: team.name,
        task_count: team.taskIds.length,
        task_ids: [...team.taskIds],
        status: team.status,
        created_at: team.createdAt
      });
    }
    if (entry.name === "TeamDelete") {
      const teamId = String(input.team_id ?? "");
      const team = deleteTeam(teamId);
      return JSON.stringify({
        team_id: team.teamId,
        name: team.name,
        status: team.status,
        message: "Team deleted"
      });
    }
    if (entry.name === "TeamMessage") {
      const teamId = String(input.team_id ?? "");
      const message = String(input.message ?? "");
      const result = messageTeam(teamId, message);
      return JSON.stringify({
        team_id: result.team.teamId,
        status: result.team.status,
        updated_task_ids: result.updatedTasks.map((task) => task.taskId),
        skipped_task_ids: result.skippedTaskIds,
        updated_count: result.updatedTasks.length,
        message: "Team message applied"
      });
    }
    if (entry.name === "TeamRun") {
      const teamId = String(input.team_id ?? "");
      const result = runTeam(teamId);
      return JSON.stringify({
        team_id: result.team.teamId,
        status: result.team.status,
        updated_task_ids: result.updatedTasks.map((task) => task.taskId),
        skipped_task_ids: result.skippedTaskIds,
        updated_count: result.updatedTasks.length,
        message: "Team run started"
      });
    }
    if (entry.name === "CronCreate") {
      const cron = createCron(
        String(input.schedule ?? ""),
        String(input.prompt ?? ""),
        optionalString(input.description),
        optionalString(input.team_id)
      );
      return JSON.stringify({
        cron_id: cron.cronId,
        schedule: cron.schedule,
        prompt: cron.prompt,
        description: cron.description,
        team_id: cron.teamId,
        enabled: cron.enabled,
        created_at: cron.createdAt
      });
    }
    if (entry.name === "CronDelete") {
      const cronId = String(input.cron_id ?? "");
      const cron = deleteCron(cronId);
      return JSON.stringify({
        cron_id: cron.cronId,
        schedule: cron.schedule,
        status: "deleted",
        message: "Cron entry removed"
      });
    }
    if (entry.name === "CronDisable") {
      const cronId = String(input.cron_id ?? "");
      const cron = disableCron(cronId);
      return JSON.stringify({
        cron_id: cron.cronId,
        schedule: cron.schedule,
        enabled: cron.enabled,
        message: "Cron disabled"
      });
    }
    if (entry.name === "CronRun") {
      const cronId = String(input.cron_id ?? "");
      const result = runCron(cronId);
      return JSON.stringify({
        cron_id: result.cron.cronId,
        schedule: result.cron.schedule,
        run_count: result.cron.runCount,
        last_run_at: result.cron.lastRunAt,
        team_id: result.cron.teamId,
        target_type: result.targetType,
        task: result.targetType === "task" ? serializeTaskSummary(result.task) : undefined,
        team: result.targetType === "team"
          ? {
              team_id: result.team.teamId,
              status: result.team.status,
              updated_task_ids: result.updatedTasks.map((task) => task.taskId),
              skipped_task_ids: result.skippedTaskIds
            }
          : undefined,
        message: "Cron run triggered"
      });
    }
    if (entry.name === "CronList") {
      const entries = getGlobalCronRegistry().list(false);
      return JSON.stringify({
        entries: entries.map((entry) => ({
          cron_id: entry.cronId,
          schedule: entry.schedule,
          prompt: entry.prompt,
          description: entry.description,
          team_id: entry.teamId,
          enabled: entry.enabled,
          run_count: entry.runCount,
          last_run_at: entry.lastRunAt,
          created_at: entry.createdAt
        })),
        count: entries.length
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
  return {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" }
    }
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeTaskPacketInput(input: Record<string, unknown>): TaskPacket {
  return {
    objective: String(input.objective ?? ""),
    scope: String(input.scope ?? ""),
    repo: String(input.repo ?? ""),
    branchPolicy: String(input.branchPolicy ?? input.branch_policy ?? ""),
    acceptanceTests: Array.isArray(input.acceptanceTests)
      ? input.acceptanceTests.map((value) => String(value))
      : Array.isArray(input.acceptance_tests)
        ? input.acceptance_tests.map((value) => String(value))
        : [],
    commitPolicy: String(input.commitPolicy ?? input.commit_policy ?? ""),
    reportingContract: String(input.reportingContract ?? input.reporting_contract ?? ""),
    escalationPolicy: String(input.escalationPolicy ?? input.escalation_policy ?? "")
  };
}

function normalizeTeamTaskIds(input: Record<string, unknown>): string[] {
  const taskValues = Array.isArray(input.tasks) ? input.tasks : [];
  const fromObjects = taskValues
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .map((value) => optionalString(value.task_id))
    .filter((value): value is string => Boolean(value));
  if (fromObjects.length > 0) {
    return fromObjects;
  }
  return Array.isArray(input.task_ids)
    ? input.task_ids.map((value) => String(value)).filter((value) => value.trim().length > 0)
    : [];
}

function serializeTaskSummary(task: {
  taskId: string;
  status: string;
  prompt: string;
  description?: string;
  taskPacket?: TaskPacket;
  createdAt: number;
}) {
  return {
    task_id: task.taskId,
    status: task.status,
    prompt: task.prompt,
    description: task.description,
    task_packet: task.taskPacket ? serializeTaskPacket(task.taskPacket) : undefined,
    created_at: task.createdAt
  };
}

function serializeTaskListEntry(task: {
  taskId: string;
  status: string;
  prompt: string;
  description?: string;
  taskPacket?: TaskPacket;
  createdAt: number;
  updatedAt: number;
  teamId?: string;
}) {
  return {
    ...serializeTaskSummary(task),
    updated_at: task.updatedAt,
    team_id: task.teamId
  };
}

function serializeTaskDetail(task: {
  taskId: string;
  status: string;
  prompt: string;
  description?: string;
  taskPacket?: TaskPacket;
  createdAt: number;
  updatedAt: number;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  teamId?: string;
}) {
  return {
    ...serializeTaskListEntry(task),
    messages: task.messages.map((message) => ({ ...message }))
  };
}

function serializeTaskPacket(packet: TaskPacket) {
  return {
    objective: packet.objective,
    scope: packet.scope,
    repo: packet.repo,
    branch_policy: packet.branchPolicy,
    acceptance_tests: [...packet.acceptanceTests],
    commit_policy: packet.commitPolicy,
    reporting_contract: packet.reportingContract,
    escalation_policy: packet.escalationPolicy
  };
}
