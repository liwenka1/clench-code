import fs from "node:fs";
import path from "node:path";

import { PluginDefinition } from "../plugins/index.js";
import { parseSlashCommand, renderSlashCommandHelp, SlashCommandParseError, type SlashCommand } from "../commands/index.js";
import {
  PluginHealthcheck,
  compactSession,
  loadRuntimeConfig,
  registryFromConfig,
  sessionToJsonl,
  Session,
  type McpServerConfig,
  type PluginConfigEntry,
  type RuntimeConfig
} from "../runtime/index.js";
import type { ProviderClientConnectOptions } from "../api/providers";
import { resolveModelAlias } from "../api/providers";
import { printCliUsage } from "./usage";
import {
  renderClearSessionView,
  renderCompactView,
  renderConfigView,
  renderExportView,
  renderHelpView,
  renderMcpHelpView,
  renderMcpListView,
  renderMcpServerView,
  renderPluginActionView,
  renderPluginListView,
  renderSessionChangeView,
  renderSessionsView,
  renderStatusView
} from "./views";

const PERMISSION_SLASH_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

export interface SessionInfo {
  path: string;
  sessionId: string;
  messages: Array<{
    role: string;
    blocks?: Array<{ type: string; text?: string }>;
  }>;
}

/** Use with `ProviderClient.fromModel(model, promptCacheOptionsForSession(sessionInfo))` when wiring the API. */
export function promptCacheOptionsForSession(
  sessionInfo: SessionInfo | undefined
): ProviderClientConnectOptions {
  const sid = sessionInfo?.sessionId?.trim();
  if (!sid) {
    return {};
  }
  return { promptCacheSessionId: sid };
}

export function runCliMainWithArgv(argv: string[] = process.argv.slice(2)): void {
  try {
    if (argv.some((token) => token === "--help" || token === "-h")) {
      printCliUsage();
      return;
    }

    const cli = parseArgs(argv);
    let sessionInfo: SessionInfo | undefined = cli.resume
      ? resolveSession(cli.cwd, cli.resume)
      : undefined;

    if (cli.command === "status") {
      printStatus(cli, sessionInfo);
      return;
    }

    if (cli.slashCommands.length === 0) {
      printStatus(cli, sessionInfo);
      return;
    }

    for (const command of cli.slashCommands) {
      const parsed = parseSlashCommandOrThrow(command);
      switch (parsed.type) {
        case "help":
          printHelp();
          break;
        case "status":
          printStatus(cli, sessionInfo);
          break;
        case "permissions":
          applyPermissionsSlash(cli, parsed.mode ? [parsed.mode] : []);
          break;
        case "config":
          printConfig(cli.cwd, parsed.section);
          break;
        case "export":
          if (!sessionInfo) {
            throw new Error("/export requires a resumed session");
          }
          if (!parsed.destination) {
            throw new Error("/export requires a destination path");
          }
          exportSession(sessionInfo, parsed.destination);
          break;
        case "clear":
          if (!sessionInfo) {
            throw new Error("/clear requires a resumed session");
          }
          sessionInfo = clearSession(sessionInfo, parsed.confirm);
          break;
        case "compact":
          if (!sessionInfo) {
            throw new Error("/compact requires a resumed session");
          }
          sessionInfo = compactExistingSession(sessionInfo);
          break;
        case "session":
          sessionInfo = handleSessionSlash(cli.cwd, sessionInfo, parsed);
          break;
        case "mcp":
          printMcp(cli.cwd, parsed.action, parsed.target);
          break;
        case "plugin":
          handlePluginCommand(cli.cwd, parsed.action, parsed.target);
          break;
        default:
          failUnknownSlashCommand(command.name);
      }
    }
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export function runCliMain(): void {
  runCliMainWithArgv();
}

interface ParsedCli {
  cwd: string;
  model: string;
  permissionMode: string;
  outputFormat: string | undefined;
  allowedTools: string | undefined;
  resume: string | undefined;
  command: string | undefined;
  slashCommands: Array<{ name: string; args: string[] }>;
}

function parseArgs(argv: string[]): ParsedCli {
  const cli: ParsedCli = {
    cwd: process.cwd(),
    model: "claude-opus-4-6",
    permissionMode: "danger-full-access",
    outputFormat: undefined,
    allowedTools: undefined,
    resume: undefined,
    command: undefined,
    slashCommands: []
  };

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token?.startsWith("--model=")) {
      cli.model = resolveModelAlias(token.slice("--model=".length));
      index += 1;
      continue;
    }
    if (token === "--model") {
      cli.model = resolveModelAlias(argv[index + 1] ?? cli.model);
      index += 2;
      continue;
    }
    if (token?.startsWith("--permission-mode=")) {
      const value = token.slice("--permission-mode=".length);
      cli.permissionMode = value.trim() ? value : cli.permissionMode;
      index += 1;
      continue;
    }
    if (token === "--permission-mode") {
      cli.permissionMode = argv[index + 1] ?? cli.permissionMode;
      index += 2;
      continue;
    }
    if (token === "--output-format") {
      const value = argv[index + 1]?.trim();
      cli.outputFormat = value ? value : cli.outputFormat;
      index += 2;
      continue;
    }
    if (token?.startsWith("--output-format=")) {
      const value = token.slice("--output-format=".length).trim();
      cli.outputFormat = value ? value : cli.outputFormat;
      index += 1;
      continue;
    }
    if (token === "--allowed-tools") {
      const value = argv[index + 1]?.trim();
      cli.allowedTools = value ? value : cli.allowedTools;
      index += 2;
      continue;
    }
    if (token?.startsWith("--allowed-tools=")) {
      const value = token.slice("--allowed-tools=".length).trim();
      cli.allowedTools = value ? value : cli.allowedTools;
      index += 1;
      continue;
    }
    if (token?.startsWith("--resume=")) {
      const value = token.slice("--resume=".length).trim();
      cli.resume = value ? value : cli.resume;
      index += 1;
      continue;
    }
    if (token === "--resume") {
      cli.resume = argv[index + 1];
      index += 2;
      continue;
    }
    if (token?.startsWith("--session=")) {
      const value = token.slice("--session=".length).trim();
      cli.resume = value ? value : cli.resume;
      index += 1;
      continue;
    }
    if (token === "--session") {
      cli.resume = argv[index + 1];
      index += 2;
      continue;
    }
    if (token === "--persist") {
      index += 1;
      continue;
    }
    if (token === "status") {
      cli.command = "status";
      index += 1;
      continue;
    }
    if (isSlashCommandLike(token)) {
      const args: string[] = [];
      index += 1;
      while (index < argv.length && !isSlashCommandLike(argv[index])) {
        args.push(argv[index]!);
        index += 1;
      }
      cli.slashCommands.push({ name: token!, args });
      continue;
    }
    if (token?.startsWith("--")) {
      throw new Error(
        `unknown option: ${token}\nTry one of: --help, --model, --output-format, --permission-mode, --allowed-tools, --resume, --session, --persist`
      );
    }
    index += 1;
  }

  return cli;
}

/** Resolves `--resume latest` or a path to an on-disk session file (shared with prompt mode). */
export function resolveSessionFilePath(cwd: string, reference: string): string {
  if (reference === "latest") {
    const sessionsDir = path.join(cwd, ".clench", "sessions");
    const sessionPaths = fs.existsSync(sessionsDir)
      ? fs
          .readdirSync(sessionsDir)
          .filter((name) => name.endsWith(".jsonl") || name.endsWith(".json"))
          .map((name) => path.join(sessionsDir, name))
          .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
      : [];
    if (sessionPaths.length === 0) {
      throw new Error("no managed sessions found");
    }
    return sessionPaths[0]!;
  }

  return path.isAbsolute(reference) ? reference : path.join(cwd, reference);
}

function resolveSession(cwd: string, reference: string): SessionInfo {
  return loadSession(resolveSessionFilePath(cwd, reference));
}

function loadSession(filePath: string): SessionInfo {
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) {
    return { path: filePath, sessionId: path.basename(filePath), messages: [] };
  }

  try {
    const parsed = JSON.parse(content) as { messages?: SessionInfo["messages"]; sessionId?: string };
    if (Array.isArray(parsed.messages)) {
      return {
        path: filePath,
        sessionId: parsed.sessionId ?? path.basename(filePath),
        messages: parsed.messages
      };
    }
  } catch {
    // fall through
  }

  const lines = content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const meta = lines.find(
    (line) => line.type === "meta" || line.type === "session_meta"
  ) as { sessionId?: string; session_id?: string } | undefined;
  const messages = lines
    .filter((line) => line.type === "message")
    .map((line) => (line as { message: SessionInfo["messages"][number] }).message);
  return {
    path: filePath,
    sessionId: meta?.sessionId ?? meta?.session_id ?? path.basename(filePath),
    messages
  };
}

function saveSession(filePath: string, session: SessionInfo): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    JSON.stringify({ type: "meta", sessionId: session.sessionId }),
    ...session.messages.map((message) => JSON.stringify({ type: "message", message }))
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function printStatus(
  cli: ParsedCli,
  sessionInfo: SessionInfo | undefined
): void {
  const mcpSummary = summarizeMcpStatus(cli.cwd);
  process.stdout.write(
    renderStatusView({
      model: cli.model,
      permissionMode: cli.permissionMode,
      outputFormat: cli.outputFormat,
      allowedTools: cli.allowedTools,
      sessionPath: sessionInfo?.path,
      messageCount: sessionInfo?.messages.length,
      mcpSummary
    })
  );
}

function applyPermissionsSlash(cli: ParsedCli, args: string[]): void {
  if (args.length === 0) {
    process.stdout.write(`Permission mode  ${cli.permissionMode}\n`);
    return;
  }
  const mode = args[0]!;
  if (!(PERMISSION_SLASH_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `Unsupported /permissions mode '${mode ?? ""}'. Use read-only, workspace-write, or danger-full-access.`
    );
  }
  if (args.length > 1) {
    throw new Error(
      "Unexpected arguments for /permissions.\n  Usage            /permissions [read-only|workspace-write|danger-full-access]"
    );
  }
  cli.permissionMode = mode;
}

function printHelp(): void {
  process.stdout.write(renderHelpView());
}

function isSlashCommandLike(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith("/") && !value.slice(1).includes("/");
}

function failUnknownSlashCommand(command: string): never {
  const suggestion = "/status";
  throw new Error(`unknown slash command outside the REPL: ${command}\nDid you mean ${suggestion}?`);
}

function printConfig(cwd: string, section: string | undefined): void {
  const { loadedFiles, merged } = loadRuntimeConfig(cwd);
  const mergedRecord = merged as Record<string, unknown>;
  process.stdout.write(renderConfigView(loadedFiles, section, section ? mergedRecord[section] : undefined));
}

function parseSlashCommandOrThrow(command: { name: string; args: string[] }): SlashCommand {
  try {
    const parsed = parseSlashCommand([command.name, ...command.args].join(" "));
    if (!parsed) {
      failUnknownSlashCommand(command.name);
    }
    return parsed;
  } catch (error) {
    if (error instanceof SlashCommandParseError && error.message.startsWith("Unknown slash command")) {
      failUnknownSlashCommand(command.name);
    }
    throw error;
  }
}

function compactExistingSession(sessionInfo: SessionInfo): SessionInfo {
  const loaded = Session.loadFromPath(sessionInfo.path);
  const result = compactSession(loaded, { preserveRecentMessages: 2 });
  if (result.removedMessageCount === 0) {
    process.stdout.write(renderCompactView(0));
    return sessionInfo;
  }
  fs.writeFileSync(sessionInfo.path, sessionToJsonl(result.compactedSession), "utf8");
  process.stdout.write(renderCompactView(result.removedMessageCount, result.formattedSummary.split("\n")[0] ?? ""));
  return loadSession(sessionInfo.path);
}

function handleSessionSlash(
  cwd: string,
  sessionInfo: SessionInfo | undefined,
  command: Extract<SlashCommand, { type: "session" }>
): SessionInfo | undefined {
  if (!command.action || command.action === "list") {
    const sessionsDir = path.join(cwd, ".clench", "sessions");
    const sessionPaths = fs.existsSync(sessionsDir)
      ? fs
          .readdirSync(sessionsDir)
          .filter((name) => name.endsWith(".jsonl") || name.endsWith(".json"))
          .map((name) => path.join(sessionsDir, name))
          .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
      : [];
    process.stdout.write(renderSessionsView(sessionPaths));
    return sessionInfo;
  }

  if (command.action === "switch") {
    if (!command.target) {
      throw new Error("/session switch requires a target");
    }
    const next = resolveSession(cwd, command.target);
    process.stdout.write(renderSessionChangeView({ action: "switched", path: next.path, messages: next.messages.length }));
    return next;
  }

  if (!sessionInfo) {
    throw new Error("/session fork requires a resumed session");
  }
  const source = Session.loadFromPath(sessionInfo.path);
  const forked = source.forkSession(command.target);
  const forkPath = path.join(cwd, ".clench", "sessions", `${forked.sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(forkPath), { recursive: true });
  fs.writeFileSync(forkPath, sessionToJsonl(forked.withPersistencePath(forkPath)), "utf8");
  process.stdout.write(
    renderSessionChangeView({ action: "forked", path: forkPath, branch: command.target ?? "<default>" })
  );
  return loadSession(forkPath);
}

function printMcp(
  cwd: string,
  action: "list" | "show" | "help" | undefined,
  target: string | undefined
): void {
  const { merged } = loadRuntimeConfig(cwd);
  const servers = normalizeMcpConfigMap(merged.mcp);
  const registry = registryFromConfig(servers);
  if (!action || action === "list") {
    process.stdout.write(renderMcpListView(registry.listServers()));
    return;
  }
  if (action === "help") {
    process.stdout.write(renderMcpHelpView());
    return;
  }
  if (!target || !servers[target]) {
    throw new Error(`/mcp show requires a configured server`);
  }
  const state = registry.getServer(target)!;
  process.stdout.write(renderMcpServerView(target, state, servers[target]!));
}

function handlePluginCommand(
  cwd: string,
  action: "list" | "install" | "enable" | "disable" | "uninstall" | undefined,
  target: string | undefined
): void {
  if (!action || action === "list") {
    const { merged } = loadRuntimeConfig(cwd);
    const plugins = normalizePluginMap(merged.plugins);
    process.stdout.write(renderPluginListView(plugins));
    return;
  }

  if (!target) {
    throw new Error(`/plugin ${action} requires a target`);
  }

  const localPath = path.join(cwd, ".clench", "settings.local.json");
  const existing = fs.existsSync(localPath)
    ? (JSON.parse(fs.readFileSync(localPath, "utf8")) as RuntimeConfig)
    : {};
  const plugins = normalizePluginMap(existing.plugins);

  if (action === "install") {
    const name = path.basename(target).replace(/\.[^.]+$/, "") || "plugin";
    const installed = loadPluginConfigEntry(target, name);
    plugins[name] = installed;
    writeLocalConfig(localPath, { ...existing, plugins });
    process.stdout.write(
      renderPluginActionView("Plugin", [
        { key: "installed", value: name },
        { key: "path", value: installed.path ?? target },
        { key: "version", value: installed.version ?? "unknown" },
        { key: "tools", value: installed.toolCount ?? 0 },
        { key: "health", value: installed.health ?? "validated" }
      ])
    );
    return;
  }

  if (action === "uninstall") {
    const existingEntry = plugins[target];
    if (!existingEntry) {
      throw new Error(`/plugin uninstall requires an installed plugin`);
    }
    delete plugins[target];
    writeLocalConfig(localPath, { ...existing, plugins });
    process.stdout.write(
      renderPluginActionView("Plugin", [
        { key: "uninstalled", value: target },
        { key: "path", value: existingEntry.path }
      ])
    );
    return;
  }

  const current = plugins[target] ?? { enabled: false };
  plugins[target] = {
    ...current,
    enabled: action === "enable",
    health: action === "enable" ? current.health ?? "validated" : "stopped"
  };
  writeLocalConfig(localPath, { ...existing, plugins });
  process.stdout.write(
    renderPluginActionView("Plugin", [{ key: `${action}d`, value: target }])
  );
}

function normalizeStringRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizePluginMap(
  value: RuntimeConfig["plugins"]
): Record<string, PluginConfigEntry> {
  const source = value ?? {};
  const out: Record<string, PluginConfigEntry> = {};
  for (const [name, raw] of Object.entries(source)) {
    out[name] = {
      enabled: Boolean(raw.enabled),
      ...(typeof raw.path === "string" ? { path: raw.path } : {}),
      ...(typeof raw.version === "string" ? { version: raw.version } : {}),
      ...(typeof raw.kind === "string" ? { kind: raw.kind } : {}),
      ...(typeof raw.toolCount === "number" ? { toolCount: raw.toolCount } : {}),
      ...(typeof raw.health === "string" ? { health: raw.health } : {})
    };
  }
  return out;
}

function normalizeMcpConfigMap(value: RuntimeConfig["mcp"]): Record<string, McpServerConfig> {
  const source = value ?? {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(source)) {
    if (raw && typeof raw === "object" && "type" in raw) {
      out[name] = raw as McpServerConfig;
    }
  }
  return out;
}

function summarizeMcpStatus(cwd: string):
  | {
      serverCount: number;
      sseServerCount: number;
      activeSseSessions: number;
      totalReconnects: number;
    }
  | undefined {
  const { merged } = loadRuntimeConfig(cwd);
  const servers = normalizeMcpConfigMap(merged.mcp);
  if (Object.keys(servers).length === 0) {
    return undefined;
  }
  const registry = registryFromConfig(servers);
  const states = registry.listServers();
  const sseStates = states.filter((state) => state.runtimeSession);
  return {
    serverCount: states.length,
    sseServerCount: sseStates.length,
    activeSseSessions: sseStates.filter((state) => state.runtimeSession?.connection === "open").length,
    totalReconnects: sseStates.reduce((count, state) => count + (state.runtimeSession?.reconnectCount ?? 0), 0)
  };
}

function loadPluginConfigEntry(target: string, fallbackName: string): PluginConfigEntry {
  if (!fs.existsSync(target)) {
    return {
      enabled: false,
      path: target,
      version: "unknown",
      kind: "external",
      toolCount: 0,
      health: "unconfigured"
    };
  }

  const plugin = PluginDefinition.loadFromFile(target);
  plugin.validate();
  const summary = plugin.summary();
  const serverHealth = plugin.tools.map((tool) => ({
    serverName: tool.definition.name,
    status: "healthy" as const,
    capabilities: [tool.definition.name]
  }));
  const healthcheck = new PluginHealthcheck(summary.name, serverHealth);
  const health = healthcheck.state.state === "healthy" ? "healthy" : "validated";
  return {
    enabled: false,
    path: target,
    version: summary.version,
    kind: summary.kind,
    toolCount: summary.toolNames.length,
    health
  };
}

function writeLocalConfig(filePath: string, config: RuntimeConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function exportSession(sessionInfo: SessionInfo, exportPath: string): void {
  const lines = ["# Conversation Export", ""];
  for (const message of sessionInfo.messages) {
    lines.push(`## ${message.role}`);
    for (const block of message.blocks ?? []) {
      if (block.type === "text" && "text" in block) {
        lines.push((block as { text: string }).text);
      }
    }
    lines.push("");
  }
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });
  fs.writeFileSync(exportPath, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(renderExportView(exportPath));
}

function clearSession(sessionInfo: SessionInfo, confirmed: boolean): SessionInfo {
  if (!confirmed) {
    process.stdout.write("Refusing to clear without confirmation. Re-run as /clear --confirm\n");
    return sessionInfo;
  }

  const backupPath = `${sessionInfo.path}.bak`;
  fs.copyFileSync(sessionInfo.path, backupPath);
  const cleared: SessionInfo = { ...sessionInfo, messages: [] };
  saveSession(sessionInfo.path, cleared);

  process.stdout.write(
    renderClearSessionView({
      mode: "resumed session reset",
      previousSession: sessionInfo.path,
      resumePrevious: `clench --resume ${backupPath}`,
      backupPath,
      sessionFile: sessionInfo.path
    })
  );
  return cleared;
}
