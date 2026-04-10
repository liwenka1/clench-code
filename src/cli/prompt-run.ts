import path from "node:path";

import {
  maxTokensForModel,
  ProviderClient,
  type ProviderClientConnectOptions
} from "../api/providers";
import {
  ConversationRuntime,
  defaultRemoteMcpSseRuntimeState,
  getRemoteMcpSseRuntimeState,
  loadRuntimeConfig,
  type McpServerConfig,
  type McpSseSessionChange,
  type McpTurnRuntimeSummary,
  PermissionPolicy,
  ProviderRuntimeClient,
  Session,
  StaticToolExecutor,
  type PermissionMode,
  type ToolExecutionHooks,
  type TurnSummary
} from "../runtime";
import { PluginDefinition } from "../plugins/index.js";
import { HookRunner } from "../plugins/hooks.js";
import { clearRemoteMcpSseSessions } from "../runtime/mcp-remote.js";
import { loadWorkspaceToolRegistry, loadWorkspaceToolRegistryAsync } from "../tools";
import type { ToolDefinition } from "../api/types";

export interface RunPromptModeInput {
  prompt: string;
  model: string;
  permissionMode: PermissionMode;
  outputFormat: "text" | "json" | "ndjson";
  allowedTools?: string[];
  /** When set, opens or creates the session file so history persists across turns (JSONL append). */
  resumeSessionPath?: string;
}

function providerConnectOptionsForSession(session: Session): ProviderClientConnectOptions {
  const sid =
    session.sessionId?.trim() ||
    (session.persistencePath ? path.basename(session.persistencePath) : "") ||
    "default-session";
  return { promptCacheSessionId: sid };
}

function buildToolExecutor(
  registry: Awaited<ReturnType<typeof loadWorkspaceToolRegistryAsync>>,
  toolNames: string[]
): StaticToolExecutor {
  let exec = new StaticToolExecutor();
  for (const name of toolNames) {
    exec = exec.register(name, async (input) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(input) as Record<string, unknown>;
      } catch {
        parsed = { _raw: input };
      }
      return await registry.executeToolAsync(name, parsed);
    });
  }
  return exec;
}

/**
 * One-shot prompt using `ProviderClient` + `ConversationRuntime` (network required unless fetch is mocked).
 * With `resumeSessionPath`, loads prior messages (or creates the file) and appends new turns to the same JSONL file.
 */
export async function runPromptMode(input: RunPromptModeInput): Promise<TurnSummary> {
  const cwd = process.cwd();
  const session = input.resumeSessionPath
    ? Session.openAtPath(input.resumeSessionPath)
    : Session.new();
  const mcpRuntimeBefore = captureMcpTurnRuntime(cwd);

  const provider = await ProviderClient.fromModel(input.model, providerConnectOptionsForSession(session));
  const maxTokens = maxTokensForModel(input.model);
  const workspaceRegistry = await loadWorkspaceToolRegistryAsync(cwd, new PermissionPolicy(input.permissionMode));
  const defs = input.allowedTools?.length ? resolveToolDefinitionsFromRegistry(workspaceRegistry, input.allowedTools) : [];
  const toolNames = defs.map((d) => d.name);
  const pluginHooks = buildPluginHooks(cwd);
  const permissionPolicy = buildPermissionPolicy(input.permissionMode, workspaceRegistry);

  const apiClient = new ProviderRuntimeClient(provider, input.model, maxTokens, {
    tools: defs.length ? defs : undefined,
    toolChoice: defs.length ? { type: "auto" } : undefined
  });

  const runtime = new ConversationRuntime(
    session,
    apiClient,
    toolNames.length ? buildToolExecutor(workspaceRegistry, toolNames) : new StaticToolExecutor(),
    permissionPolicy,
    ["You are a concise, helpful assistant."],
    pluginHooks ? { hooks: pluginHooks } : undefined
  );

  try {
    const summary = await runtime.runTurn(input.prompt.trim());
    const mcpRuntimeAfter = captureMcpTurnRuntime(cwd);
    return {
      ...summary,
      ...(mcpRuntimeAfter ? { mcpTurnRuntime: summarizeMcpTurnRuntime(mcpRuntimeBefore, mcpRuntimeAfter) } : {})
    };
  } finally {
    await clearRemoteMcpSseSessions();
  }
}

function resolveToolDefinitionsFromRegistry(
  registry: Awaited<ReturnType<typeof loadWorkspaceToolRegistryAsync>>,
  cliNames: string[]
): ToolDefinition[] {
  const normalized = registry.normalizeAllowedTools(cliNames);
  const seen = new Set<string>();
  const defs: ToolDefinition[] = [];
  for (const name of normalized) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const definition = registry.toolDefinition(name) ?? {
      name,
      description: `Tool ${name}`,
      input_schema: { type: "object", additionalProperties: true }
    };
    defs.push(definition);
  }
  return defs;
}

function buildPluginHooks(cwd: string): ToolExecutionHooks | undefined {
  const plugins = loadEnabledPlugins(cwd).filter((plugin) => !plugin.hooks.isEmpty());
  if (plugins.length === 0) {
    return undefined;
  }
  const runners = plugins.map((plugin) => new HookRunner(plugin.hooks));
  return {
    preToolUse: async (toolName, input) => {
      const messages: string[] = [];
      for (const runner of runners) {
        const result = runner.runPreToolUse(toolName, input);
        messages.push(...result.messages);
        if (result.denied || result.failed) {
          return {
            decision: "deny",
            reason: result.messages.at(-1) ?? "plugin pre-tool hook blocked execution",
            messages
          };
        }
      }
      return messages.length > 0 ? { messages } : undefined;
    },
    postToolUse: async (toolName, input, output) => {
      const messages: string[] = [];
      for (const runner of runners) {
        const result = runner.runPostToolUse(toolName, input, output, false);
        messages.push(...result.messages);
        if (result.denied || result.failed) {
          return {
            decision: "deny",
            reason: result.messages.at(-1) ?? "plugin post-tool hook blocked execution",
            messages
          };
        }
      }
      return messages.length > 0 ? { messages } : undefined;
    },
    postToolUseFailure: async (toolName, input, error) => {
      const messages: string[] = [];
      for (const runner of runners) {
        const result = runner.runPostToolUseFailure(toolName, input, error);
        messages.push(...result.messages);
      }
      return messages.length > 0 ? { messages } : undefined;
    }
  };
}

function loadEnabledPlugins(cwd: string): PluginDefinition[] {
  const { merged } = loadRuntimeConfig(cwd);
  return Object.values(merged.plugins ?? {})
    .filter((plugin) => plugin.enabled && typeof plugin.path === "string")
    .map((plugin) => PluginDefinition.loadFromFile(plugin.path!));
}

function buildPermissionPolicy(
  mode: PermissionMode,
  registry: ReturnType<typeof loadWorkspaceToolRegistry>
): PermissionPolicy {
  return registry.entries().reduce(
    (policy, entry) => policy.withToolRequirement(entry.name, entry.requiredPermission),
    new PermissionPolicy(mode)
  );
}

export function printPromptSummary(summary: TurnSummary, outputFormat: RunPromptModeInput["outputFormat"]): void {
  if (outputFormat === "json") {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  if (outputFormat === "ndjson") {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }

  for (const msg of summary.assistantMessages) {
    for (const block of msg.blocks) {
      if (block.type === "text") {
        process.stdout.write(`${block.text}\n`);
      } else if (block.type === "tool_use") {
        process.stdout.write(`[tool_use ${block.name} id=${block.id}]\n`);
      }
    }
  }
  if (summary.mcpTurnRuntime) {
    process.stdout.write(
      `[mcp servers=${summary.mcpTurnRuntime.configuredServerCount} sse_sessions=${summary.mcpTurnRuntime.activeSseSessions}/${summary.mcpTurnRuntime.sseServerCount} reconnects=${summary.mcpTurnRuntime.totalReconnects}]\n`
    );
    for (const change of summary.mcpTurnRuntime.sessionChanges) {
      process.stdout.write(
        `[mcp ${change.serverName} session ${change.connectionBefore}->${change.connectionAfter} reconnects ${change.reconnectsBefore}->${change.reconnectsAfter}${change.lastError ? ` error=${change.lastError}` : ""}]\n`
      );
    }
  }
}

interface CapturedMcpTurnRuntime {
  configuredServerCount: number;
  sseSessions: Array<{
    serverName: string;
    connection: "idle" | "opening" | "open";
    reconnectCount: number;
    lastError?: string;
  }>;
}

function captureMcpTurnRuntime(cwd: string): CapturedMcpTurnRuntime | undefined {
  const { merged } = loadRuntimeConfig(cwd);
  const servers = normalizeMcpConfigMap(merged.mcp);
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    return undefined;
  }
  return {
    configuredServerCount: entries.length,
    sseSessions: entries
      .filter(([, config]) => config.type === "sse")
      .map(([serverName]) => {
        const runtime = getRemoteMcpSseRuntimeState(serverName) ?? defaultRemoteMcpSseRuntimeState();
        return {
          serverName,
          connection: runtime.connection,
          reconnectCount: runtime.reconnectCount,
          ...(runtime.lastError ? { lastError: runtime.lastError } : {})
        };
      })
  };
}

function summarizeMcpTurnRuntime(
  before: CapturedMcpTurnRuntime | undefined,
  after: CapturedMcpTurnRuntime
): McpTurnRuntimeSummary {
  const beforeByServer = new Map(before?.sseSessions.map((session) => [session.serverName, session]) ?? []);
  const sessionChanges: McpSseSessionChange[] = [];
  for (const session of after.sseSessions) {
    const previous = beforeByServer.get(session.serverName) ?? {
      serverName: session.serverName,
      connection: "idle" as const,
      reconnectCount: 0
    };
    if (
      previous.connection !== session.connection ||
      previous.reconnectCount !== session.reconnectCount ||
      previous.lastError !== session.lastError
    ) {
      sessionChanges.push({
        serverName: session.serverName,
        connectionBefore: previous.connection,
        connectionAfter: session.connection,
        reconnectsBefore: previous.reconnectCount,
        reconnectsAfter: session.reconnectCount,
        ...(session.lastError ? { lastError: session.lastError } : {})
      });
    }
  }
  return {
    configuredServerCount: after.configuredServerCount,
    sseServerCount: after.sseSessions.length,
    activeSseSessions: after.sseSessions.filter((session) => session.connection === "open").length,
    totalReconnects: after.sseSessions.reduce((count, session) => count + session.reconnectCount, 0),
    sessionChanges
  };
}

function normalizeMcpConfigMap(value: Record<string, unknown> | undefined): Record<string, McpServerConfig> {
  const source = value ?? {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(source)) {
    if (raw && typeof raw === "object" && "type" in raw) {
      out[name] = raw as McpServerConfig;
    }
  }
  return out;
}
