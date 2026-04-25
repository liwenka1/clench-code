import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PluginDefinition } from "../plugins/index.js";
import { renderAgentsCommand } from "./agents";
import { resolveSkillsCommand } from "./skills";
import {
  DEFAULT_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_XAI_BASE_URL,
  detectProviderKind,
  hasOpenAiCompatApiKey,
  readAnthropicBaseUrl,
  readOpenAiBaseUrl,
  readXaiBaseUrl
} from "../api/index.js";
import { parseSlashCommand, renderSlashCommandHelp, SlashCommandParseError, type SlashCommand } from "../commands/index.js";
import {
  assignTaskTeam,
  PluginHealthcheck,
  UsageTracker,
  createCron,
  createTask,
  createTeam,
  credentialsPath,
  compactSession,
  deleteTask,
  deleteCron,
  deleteTeam,
  disableCron,
  getGlobalCronRegistry,
  stopTask,
  getGlobalTaskRegistry,
  getGlobalTeamRegistry,
  loadOauthConfig,
  loadOauthCredentials,
  loadRuntimeConfig,
  messageTeam,
  resolveSandboxStatus,
  runtimeSettingsPath,
  registryFromConfig,
  sessionToJsonl,
  Session,
  runTeam,
  runCron,
  updateTask,
  type ModelProviderKind,
  type McpServerConfig,
  type PluginConfigEntry,
  type RuntimeConfig
} from "../runtime/index.js";
import type { ProviderClientConnectOptions } from "../api/providers";
import { DEFAULT_MODEL, normalizeModelSelection } from "../api/providers";
import { oauthTokenIsExpired } from "../runtime/oauth.js";
import { loadPromptHistory, parsePromptHistoryLimit } from "./history";
import { initializeRepo } from "./init";
import { inferCliOutputFormat, writeCliError } from "./error-output";
import { printPromptSummary, runPromptMode } from "./prompt-run";
import { printCliUsage } from "./usage";
import {
  renderClearSessionView,
  renderCompactView,
  renderConfigView,
  renderCronCreateView,
  renderCronDeleteView,
  renderCronDisableView,
  renderCronDetailView,
  renderCronsListView,
  renderCronRunView,
  renderCronsUsageView,
  renderCostView,
  renderDoctorView,
  renderDiffView,
  renderExportView,
  renderHelpView,
  renderInitView,
  renderMcpHelpView,
  renderMcpListView,
  renderMcpServerView,
  renderMemoryView,
  renderModelView,
  renderPluginActionView,
  renderPromptHistoryView,
  renderPluginListView,
  renderResumeUsageView,
  renderSandboxStatusView,
  renderSessionChangeView,
  renderSessionsView,
  renderStatusView,
  renderTeamCreateView,
  renderTeamDeleteView,
  renderTeamDetailView,
  renderTeamMessageView,
  renderTeamRunView,
  renderTeamsListView,
  renderTeamsUsageView,
  renderTaskCreateView,
  renderTaskDeleteView,
  renderTaskDetailView,
  renderTaskMessagesView,
  renderTaskOutputView,
  renderTasksListView,
  renderTasksUsageView,
  renderTaskStopView,
  renderTaskUpdateView,
  renderVersionView
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

export interface RunCliMainOptions {
  interactivePrompter?: InteractivePrompter;
}

export async function runCliMainWithArgv(
  argv: string[] = process.argv.slice(2),
  options: RunCliMainOptions = {}
): Promise<void> {
  let outputFormat = inferCliOutputFormat(argv);
  try {
    if (argv.some((token) => token === "--help" || token === "-h")) {
      printCliUsage();
      return;
    }

    const cli = parseArgs(argv);
    outputFormat = normalizeCliOutputFormat(cli.outputFormat);
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
        case "agents":
          printAgents(cli.cwd, parsed.args);
          break;
        case "skills":
          await printSkills(cli, sessionInfo, parsed.args);
          break;
        case "tasks":
          printTasks(parsed.action, parsed.target, {
            prompt: parsed.prompt,
            description: parsed.description,
            message: parsed.message
          });
          break;
        case "teams":
          printTeams(parsed.action, parsed.target, { name: parsed.name, taskIds: parsed.taskIds, message: parsed.message });
          break;
        case "crons":
          printCrons(parsed.action, parsed.target, {
            schedule: parsed.schedule,
            prompt: parsed.prompt,
            description: parsed.description,
            teamId: parsed.teamId
          });
          break;
        case "version":
          printVersion();
          break;
        case "init":
          printInit(cli.cwd);
          break;
        case "doctor":
          printDoctor(cli.cwd, cli.model);
          break;
        case "sandbox":
          printSandbox(cli.cwd);
          break;
        case "cost":
          printCost(cli, sessionInfo);
          break;
        case "diff":
          printDiff(cli.cwd);
          break;
        case "memory":
          printMemory(cli.cwd);
          break;
        case "resume":
          sessionInfo = handleResumeSlash(cli.cwd, parsed.target);
          break;
        case "model":
          if (parsed.action === "add") {
            await applyModelAddSlash(cli, parsed.providerId, options.interactivePrompter);
          } else {
            applyModelSlash(cli, parsed.model);
          }
          break;
        case "history":
          process.stdout.write(
            renderPromptHistoryView(
              loadPromptHistory(cli.cwd, sessionInfo?.path),
              parsePromptHistoryLimit(parsed.count)
            )
          );
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
    writeCliError(error, outputFormat);
    process.exitCode = 1;
  }
}

export function runCliMain(): void {
  void runCliMainWithArgv();
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

function normalizeCliOutputFormat(value: string | undefined): "text" | "json" | "ndjson" {
  return value === "json" || value === "ndjson" ? value : "text";
}

function configuredModelForCwd(cwd: string): string {
  const merged = loadRuntimeConfig(cwd).merged;
  const configured = merged.model;
  return configured ? normalizeModelSelection(configured, merged) : DEFAULT_MODEL;
}

function parseArgs(argv: string[]): ParsedCli {
  const cwd = process.cwd();
  const mergedConfig = loadRuntimeConfig(cwd).merged;
  const cli: ParsedCli = {
    cwd,
    model: configuredModelForCwd(cwd),
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
      cli.model = normalizeModelSelection(token.slice("--model=".length), mergedConfig);
      index += 1;
      continue;
    }
    if (token === "--model") {
      cli.model = normalizeModelSelection(argv[index + 1] ?? cli.model, mergedConfig);
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

function applyModelSlash(cli: ParsedCli, nextModel: string | undefined): void {
  if (!nextModel) {
    process.stdout.write(renderModelView({ current: cli.model }));
    return;
  }
  const previous = cli.model;
  const merged = loadRuntimeConfig(cli.cwd).merged;
  cli.model = normalizeModelSelection(nextModel, merged);
  const localPath = path.join(cli.cwd, ".clench", "settings.local.json");
  const existing = readLocalConfig(localPath);
  writeLocalConfig(localPath, { ...existing, model: cli.model });
  process.stdout.write(renderModelView({ current: cli.model, previous }));
}

interface ModelProviderAnswers {
  providerId: string;
  kind: ModelProviderKind;
  baseUrl?: string;
  apiKey?: string;
  modelId: string;
  setCurrentModel: boolean;
}

export interface InteractivePrompter {
  question(prompt: string): Promise<string>;
  close(): void;
}

const LOCAL_OPENAI_COMPAT_PROVIDER_IDS = new Set(["local", "ollama", "lmstudio", "vllm", "llamacpp"]);
const OPENAI_COMPAT_PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = {
  openai: DEFAULT_OPENAI_BASE_URL,
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com/v1"
};

function defaultKindForProvider(providerId: string): ModelProviderKind {
  if (providerId === "anthropic") {
    return "anthropic";
  }
  if (providerId === "xai") {
    return "xai";
  }
  return "openai";
}

function defaultBaseUrlForProvider(providerId: string, kind: ModelProviderKind): string | undefined {
  if (kind === "anthropic") {
    return providerId === "anthropic" ? DEFAULT_BASE_URL : undefined;
  }
  if (kind === "xai") {
    return providerId === "xai" ? DEFAULT_XAI_BASE_URL : undefined;
  }
  if (LOCAL_OPENAI_COMPAT_PROVIDER_IDS.has(providerId)) {
    return "http://127.0.0.1:11434/v1";
  }
  return OPENAI_COMPAT_PROVIDER_DEFAULT_BASE_URLS[providerId];
}

function isLikelyLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    const url = new URL(baseUrl);
    return ["127.0.0.1", "localhost", "0.0.0.0"].includes(url.hostname);
  } catch {
    return false;
  }
}

function defaultApiKeyForProvider(providerId: string, kind: ModelProviderKind, baseUrl: string | undefined): string | undefined {
  if (kind === "openai" && (LOCAL_OPENAI_COMPAT_PROVIDER_IDS.has(providerId) || isLikelyLocalBaseUrl(baseUrl))) {
    return "dummy";
  }
  return undefined;
}

function parseYesNo(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["y", "yes"].includes(normalized)) {
    return true;
  }
  if (["n", "no"].includes(normalized)) {
    return false;
  }
  throw new Error(`expected yes or no, received '${value}'`);
}

async function promptQuestion(
  prompter: InteractivePrompter,
  message: string,
  defaultValue?: string,
  allowEmpty = false
): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await prompter.question(`${message}${suffix}: `)).trim();
  if (!answer) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    if (allowEmpty) {
      return "";
    }
    throw new Error(`${message} is required`);
  }
  return answer;
}

function createInteractivePrompter(): InteractivePrompter {
  const queuedLines: string[] = [];
  const pendingResolvers: Array<(line: string) => void> = [];
  let buffer = "";

  const flushBufferedLines = () => {
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      const resolve = pendingResolvers.shift();
      if (resolve) {
        resolve(line);
      } else {
        queuedLines.push(line);
      }
    }
  };

  const onData = (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    flushBufferedLines();
  };

  process.stdin.on("data", onData);
  process.stdin.resume();

  return {
    async question(prompt: string) {
      process.stdout.write(prompt);
      if (queuedLines.length > 0) {
        return queuedLines.shift() ?? "";
      }
      return await new Promise((resolve) => {
        pendingResolvers.push(resolve);
      });
    },
    close() {
      process.stdin.off("data", onData);
      process.stdin.pause();
      if (buffer.length > 0) {
        let line = buffer;
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }
        const resolve = pendingResolvers.shift();
        if (resolve) {
          resolve(line);
        }
        buffer = "";
      }
      while (pendingResolvers.length > 0) {
        pendingResolvers.shift()!("");
      }
    }
  };
}

async function promptForModelProviderConfig(
  existing: RuntimeConfig,
  providerIdHint?: string,
  prompter?: InteractivePrompter
): Promise<ModelProviderAnswers> {
  const activePrompter = prompter ?? createInteractivePrompter();
  const ownsPrompter = prompter === undefined;
  try {
    const providerId = await promptQuestion(activePrompter, "Provider ID", providerIdHint?.trim() || "local");
    if (!/^[a-zA-Z0-9._-]+$/.test(providerId)) {
      throw new Error("provider id must contain only letters, numbers, dot, underscore, or dash");
    }

    const existingProvider = existing.providers?.[providerId];
    const kind = (await promptQuestion(
      activePrompter,
      "Provider kind (openai/anthropic/xai)",
      existingProvider?.kind ?? defaultKindForProvider(providerId)
    )) as ModelProviderKind;
    if (!["openai", "anthropic", "xai"].includes(kind)) {
      throw new Error(`unsupported provider kind '${kind}'`);
    }

    const baseUrl = await promptQuestion(
      activePrompter,
      "Base URL",
      existingProvider?.baseUrl ?? defaultBaseUrlForProvider(providerId, kind),
      true
    );
    const apiKey = await promptQuestion(
      activePrompter,
      "API key",
      existingProvider?.apiKey ?? defaultApiKeyForProvider(providerId, kind, baseUrl),
      true
    );
    const modelId = await promptQuestion(activePrompter, "Default model ID");
    const setCurrentModel = parseYesNo(
      await promptQuestion(activePrompter, "Set as current model? (y/n)", "y"),
      true
    );

    return {
      providerId,
      kind,
      baseUrl: baseUrl || undefined,
      apiKey: apiKey || undefined,
      modelId,
      setCurrentModel
    };
  } finally {
    if (ownsPrompter) {
      activePrompter.close();
    }
  }
}

async function applyModelAddSlash(
  cli: ParsedCli,
  providerIdHint: string | undefined,
  prompter?: InteractivePrompter
): Promise<void> {
  const localPath = path.join(cli.cwd, ".clench", "settings.local.json");
  const existing = readLocalConfig(localPath);
  const answers = prompter
    ? await promptForModelProviderConfig(existing, providerIdHint, prompter)
    : await promptForModelProviderConfig(existing, providerIdHint);
  const providers = {
    ...(existing.providers ?? {}),
    [answers.providerId]: {
      kind: answers.kind,
      ...(answers.baseUrl ? { baseUrl: answers.baseUrl } : {}),
      ...(answers.apiKey ? { apiKey: answers.apiKey } : {})
    }
  };
  const nextConfig: RuntimeConfig = {
    ...existing,
    providers,
    ...(answers.setCurrentModel
      ? { model: normalizeModelSelection(`${answers.providerId}/${answers.modelId}`, { ...existing, providers }) }
      : {})
  };
  writeLocalConfig(localPath, nextConfig);
  if (answers.setCurrentModel && nextConfig.model) {
    cli.model = nextConfig.model;
  }
  process.stdout.write(renderConfigView([localPath], "providers", providers));
  process.stdout.write(renderModelView({ current: cli.model }));
}

function printHelp(): void {
  process.stdout.write(renderHelpView());
}

function printAgents(cwd: string, args: string[]): void {
  process.stdout.write(renderAgentsCommand(cwd, args));
}

function printTasks(
  action: "list" | "get" | "stop" | "output" | "create" | "update" | "messages" | "delete" | undefined,
  target: string | undefined,
  options?: { prompt?: string; description?: string; message?: string }
): void {
  const registry = getGlobalTaskRegistry();
  if (!action || action === "list") {
    const tasks = registry.list();
    process.stdout.write(renderTasksListView({
      count: tasks.length,
      tasks: tasks.map((task) => ({
        taskId: task.taskId,
        status: task.status,
        prompt: task.prompt,
        description: task.description
      }))
    }));
    return;
  }
  if (action === "create") {
    const prompt = options?.prompt?.trim();
    if (!prompt) {
      process.stdout.write(renderTasksUsageView());
      return;
    }
    const task = createTask(prompt, options?.description?.trim() || undefined);
    process.stdout.write(renderTaskCreateView({
      taskId: task.taskId,
      status: task.status,
      prompt: task.prompt,
      description: task.description
    }));
    return;
  }
  if (action === "update") {
    const message = options?.message?.trim();
    if (!target || !message) {
      process.stdout.write(renderTasksUsageView());
      return;
    }
    const task = updateTask(target, message);
    process.stdout.write(renderTaskUpdateView({
      taskId: task.taskId,
      status: task.status,
      messageCount: task.messages.length,
      message
    }));
    return;
  }
  if (action === "messages") {
    if (!target) {
      process.stdout.write(renderTasksUsageView());
      return;
    }
    const task = registry.get(target);
    if (!task) {
      throw new Error(`task not found: ${target}`);
    }
    process.stdout.write(renderTaskMessagesView({
      taskId: task.taskId,
      messages: task.messages
    }));
    return;
  }
  if (action === "delete") {
    if (!target) {
      process.stdout.write(renderTasksUsageView());
      return;
    }
    const task = deleteTask(target);
    process.stdout.write(renderTaskDeleteView({
      taskId: task.taskId,
      prompt: task.prompt
    }));
    return;
  }
  if (!target) {
    process.stdout.write(renderTasksUsageView());
    return;
  }
  if (action === "get") {
    const task = registry.get(target);
    if (!task) {
      throw new Error(`task not found: ${target}`);
    }
    process.stdout.write(renderTaskDetailView({
      taskId: task.taskId,
      status: task.status,
      prompt: task.prompt,
      description: task.description,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      messageCount: task.messages.length,
      teamId: task.teamId
    }));
    return;
  }
  if (action === "output") {
    const output = registry.output(target);
    process.stdout.write(renderTaskOutputView({
      taskId: target,
      output,
      hasOutput: Boolean(output)
    }));
    return;
  }
  const task = stopTask(target);
  process.stdout.write(renderTaskStopView({
    taskId: task.taskId,
    status: task.status,
    message: "Task stopped"
  }));
}

function printTeams(
  action: "list" | "get" | "delete" | "create" | "message" | "run" | undefined,
  target: string | undefined,
  options?: { name?: string; taskIds?: string[]; message?: string }
): void {
  const registry = getGlobalTeamRegistry();
  if (!action || action === "list") {
    const teams = registry.list();
    process.stdout.write(renderTeamsListView({
      count: teams.length,
      teams: teams.map((team) => ({
        teamId: team.teamId,
        name: team.name,
        status: team.status,
        taskCount: team.taskIds.length,
        taskStatusSummary: summarizeTeamTaskStatuses(team.taskIds),
        missingTaskCount: countMissingTasks(team.taskIds)
      }))
    }));
    return;
  }
  if (action === "create") {
    const name = options?.name?.trim();
    if (!name) {
      process.stdout.write(renderTeamsUsageView());
      return;
    }
    const team = createTeam(name, options?.taskIds ?? []);
    for (const taskId of team.taskIds) {
      try {
        assignTaskTeam(taskId, team.teamId);
      } catch {
        // Missing tasks do not block team creation.
      }
    }
    process.stdout.write(renderTeamCreateView({
      teamId: team.teamId,
      name: team.name,
      status: team.status,
      taskIds: team.taskIds
    }));
    return;
  }
  if (action === "message") {
    const message = options?.message?.trim();
    if (!target || !message) {
      process.stdout.write(renderTeamsUsageView());
      return;
    }
    const result = messageTeam(target, message);
    process.stdout.write(renderTeamMessageView({
      teamId: result.team.teamId,
      status: result.team.status,
      message,
      updatedCount: result.updatedTasks.length,
      skippedTaskIds: result.skippedTaskIds
    }));
    return;
  }
  if (action === "run") {
    if (!target) {
      process.stdout.write(renderTeamsUsageView());
      return;
    }
    const result = runTeam(target);
    process.stdout.write(renderTeamRunView({
      teamId: result.team.teamId,
      status: result.team.status,
      updatedCount: result.updatedTasks.length,
      skippedTaskIds: result.skippedTaskIds
    }));
    return;
  }
  if (!target) {
    process.stdout.write(renderTeamsUsageView());
    return;
  }
  if (action === "get") {
    const team = registry.get(target);
    if (!team) {
      throw new Error(`team not found: ${target}`);
    }
    const taskSummaries = team.taskIds
      .map((taskId) => getGlobalTaskRegistry().get(taskId))
      .filter((task): task is NonNullable<typeof task> => Boolean(task))
      .map((task) => ({
        taskId: task.taskId,
        status: task.status,
        prompt: task.prompt,
        messageCount: task.messages.length
      }));
    const resolvedTaskIds = new Set(taskSummaries.map((task) => task.taskId));
    process.stdout.write(renderTeamDetailView({
      teamId: team.teamId,
      name: team.name,
      status: team.status,
      taskIds: team.taskIds,
      taskSummaries,
      missingTaskIds: team.taskIds.filter((taskId) => !resolvedTaskIds.has(taskId)),
      createdAt: team.createdAt,
      updatedAt: team.updatedAt
    }));
    return;
  }
  const team = deleteTeam(target);
  process.stdout.write(renderTeamDeleteView({
    teamId: team.teamId,
    name: team.name,
    status: team.status
  }));
}

function summarizeTeamTaskStatuses(taskIds: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const taskId of taskIds) {
    const task = getGlobalTaskRegistry().get(taskId);
    if (!task) {
      continue;
    }
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return undefined;
  }
  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([status, count]) => `${status}:${count}`)
    .join(", ");
}

function countMissingTasks(taskIds: string[]): number {
  return taskIds.filter((taskId) => !getGlobalTaskRegistry().get(taskId)).length;
}

function printCrons(
  action: "list" | "get" | "delete" | "create" | "create-team" | "disable" | "run" | undefined,
  target: string | undefined,
  options?: { schedule?: string; prompt?: string; description?: string; teamId?: string }
): void {
  const registry = getGlobalCronRegistry();
  if (!action || action === "list") {
    const entries = registry.list(false);
    process.stdout.write(renderCronsListView({
      count: entries.length,
      crons: entries.map((entry) => ({
        cronId: entry.cronId,
        schedule: entry.schedule,
        enabled: entry.enabled,
        runCount: entry.runCount,
        description: entry.description,
        teamId: entry.teamId
      }))
    }));
    return;
  }
  if (action === "create") {
    const schedule = options?.schedule?.trim();
    const prompt = options?.prompt?.trim();
    if (!schedule || !prompt) {
      process.stdout.write(renderCronsUsageView());
      return;
    }
    const cron = createCron(schedule, prompt, options?.description?.trim() || undefined);
    process.stdout.write(renderCronCreateView({
      cronId: cron.cronId,
      schedule: cron.schedule,
      prompt: cron.prompt,
      description: cron.description,
      teamId: cron.teamId,
      enabled: cron.enabled
    }));
    return;
  }
  if (action === "create-team") {
    const schedule = options?.schedule?.trim();
    const teamId = options?.teamId?.trim();
    if (!schedule || !teamId) {
      process.stdout.write(renderCronsUsageView());
      return;
    }
    const cron = createCron(schedule, `Run team ${teamId}`, options?.description?.trim() || undefined, teamId);
    process.stdout.write(renderCronCreateView({
      cronId: cron.cronId,
      schedule: cron.schedule,
      prompt: cron.prompt,
      description: cron.description,
      teamId: cron.teamId,
      enabled: cron.enabled
    }));
    return;
  }
  if (action === "disable") {
    if (!target) {
      process.stdout.write(renderCronsUsageView());
      return;
    }
    const cron = disableCron(target);
    process.stdout.write(renderCronDisableView({
      cronId: cron.cronId,
      schedule: cron.schedule,
      enabled: cron.enabled
    }));
    return;
  }
  if (action === "run") {
    if (!target) {
      process.stdout.write(renderCronsUsageView());
      return;
    }
    const result = runCron(target);
    process.stdout.write(renderCronRunView({
      cronId: result.cron.cronId,
      schedule: result.cron.schedule,
      runCount: result.cron.runCount,
      targetType: result.targetType,
      taskId: result.targetType === "task" ? result.task.taskId : undefined,
      taskPrompt: result.targetType === "task" ? result.task.prompt : undefined,
      teamId: result.targetType === "team" ? result.team.teamId : undefined,
      updatedCount: result.targetType === "team" ? result.updatedTasks.length : undefined,
      skippedTaskIds: result.targetType === "team" ? result.skippedTaskIds : undefined
    }));
    return;
  }
  if (!target) {
    process.stdout.write(renderCronsUsageView());
    return;
  }
  if (action === "get") {
    const cron = registry.get(target);
    if (!cron) {
      throw new Error(`cron not found: ${target}`);
    }
    process.stdout.write(renderCronDetailView({
      cronId: cron.cronId,
      schedule: cron.schedule,
      prompt: cron.prompt,
      description: cron.description,
      teamId: cron.teamId,
      enabled: cron.enabled,
      runCount: cron.runCount,
      lastRunAt: cron.lastRunAt,
      createdAt: cron.createdAt,
      updatedAt: cron.updatedAt
    }));
    return;
  }
  const cron = deleteCron(target);
  process.stdout.write(renderCronDeleteView({
    cronId: cron.cronId,
    schedule: cron.schedule
  }));
}

async function printSkills(cli: ParsedCli, sessionInfo: SessionInfo | undefined, args: string[]): Promise<void> {
  const resolved = resolveSkillsCommand(cli.cwd, args);
  if (resolved.kind === "local") {
    process.stdout.write(resolved.output);
    return;
  }
  const summary = await runPromptMode({
    prompt: resolved.invocation.prompt,
    model: cli.model,
    permissionMode: cli.permissionMode as "read-only" | "workspace-write" | "danger-full-access",
    outputFormat: normalizeCliOutputFormat(cli.outputFormat),
    allowedTools: cli.allowedTools?.split(",").map((tool) => tool.trim()).filter(Boolean),
    extraSystemPrompts: [resolved.invocation.systemPrompt],
    resumeSessionPath: sessionInfo?.path
  });
  printPromptSummary(summary, normalizeCliOutputFormat(cli.outputFormat), { model: cli.model });
}

function printVersion(): void {
  process.stdout.write(renderVersionView({ version: readCliVersion() }));
}

function printInit(cwd: string): void {
  process.stdout.write(renderInitView(initializeRepo(cwd)));
}

function printDoctor(cwd: string, model: string): void {
  process.stdout.write(renderDoctorView(readDoctorReport(cwd, model)));
}

function printSandbox(cwd: string): void {
  process.stdout.write(renderSandboxStatusView(readSandboxReport(cwd)));
}

function printCost(cli: ParsedCli, sessionInfo: SessionInfo | undefined): void {
  process.stdout.write(renderCostView(readCostReport(cli.model, sessionInfo)));
}

function printDiff(cwd: string): void {
  process.stdout.write(renderDiffView(readDiffReport(cwd)));
}

function printMemory(cwd: string): void {
  process.stdout.write(renderMemoryView(readMemoryReport(cwd)));
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

function readDiffReport(cwd: string): {
  result: "no_git_repo" | "clean" | "changes";
  detail?: string;
  staged?: string;
  unstaged?: string;
} {
  if (!isInsideGitWorkTree(cwd)) {
    return {
      result: "no_git_repo",
      detail: `${cwd} is not inside a git project`
    };
  }
  const staged = runGitDiffCommand(cwd, ["diff", "--cached"]).trim();
  const unstaged = runGitDiffCommand(cwd, ["diff"]).trim();
  if (!staged && !unstaged) {
    return {
      result: "clean",
      detail: "no current changes"
    };
  }
  return {
    result: "changes",
    staged,
    unstaged
  };
}

function readMemoryReport(cwd: string): {
  cwd: string;
  files: Array<{ path: string; lines: number; preview: string }>;
} {
  return {
    cwd,
    files: discoverInstructionFiles(cwd).map((file) => ({
      path: file.path,
      lines: file.content.split("\n").length,
      preview: file.content.split("\n")[0]?.trim() ?? ""
    }))
  };
}

function readCostReport(
  model: string,
  sessionInfo: SessionInfo | undefined
): {
  model: string;
  turns: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
} {
  const tracker = sessionInfo
    ? UsageTracker.fromSession(Session.loadFromPath(sessionInfo.path))
    : new UsageTracker();
  return {
    model,
    turns: tracker.turns(),
    usage: tracker.cumulativeUsage()
  };
}

function readSandboxReport(cwd: string) {
  const { merged } = loadRuntimeConfig(cwd);
  return resolveSandboxStatus(
    {
      enabled: merged.sandbox?.enabled,
      namespaceRestrictions: (merged.sandbox as Record<string, unknown> | undefined)?.namespaceRestrictions as boolean | undefined,
      networkIsolation: (merged.sandbox as Record<string, unknown> | undefined)?.networkIsolation as boolean | undefined,
      filesystemMode: (merged.sandbox as Record<string, unknown> | undefined)?.filesystemMode as "off" | "workspace-only" | "allow-list" | undefined,
      allowedMounts: Array.isArray((merged.sandbox as Record<string, unknown> | undefined)?.allowedMounts)
        ? ((merged.sandbox as Record<string, unknown>).allowedMounts as string[])
        : []
    },
    cwd
  );
}

function readDoctorReport(cwd: string, model: string) {
  const runtimeConfig = loadRuntimeConfig(cwd);
  const provider = detectProviderKind(model, runtimeConfig.merged);
  const savedOauth = loadOauthCredentials();
  const oauthConfig = loadOauthConfig();
  const anthropicApiKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  const anthropicBearer = Boolean(process.env.ANTHROPIC_AUTH_TOKEN?.trim());
  const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; message: string }> = [];

  if (anthropicApiKey || anthropicBearer) {
    checks.push({
      name: "auth",
      status: "pass",
      message: `anthropic env credentials detected (api_key=${anthropicApiKey}, bearer=${anthropicBearer})`
    });
  } else if (savedOauth && !oauthTokenIsExpired(savedOauth)) {
    checks.push({
      name: "auth",
      status: "pass",
      message: `saved oauth bearer available at ${credentialsPath()}`
    });
  } else if (savedOauth?.refreshToken && oauthConfig) {
    checks.push({
      name: "auth",
      status: "warn",
      message: "saved oauth token is expired but refresh config is present"
    });
  } else {
    checks.push({
      name: "auth",
      status: "fail",
      message: "no usable Anthropic credentials found in env or saved oauth credentials"
    });
  }

  const openAiPresent = hasOpenAiCompatApiKey("OPENAI_API_KEY");
  const xaiPresent = hasOpenAiCompatApiKey("XAI_API_KEY");
  checks.push({
    name: "provider endpoints",
    status: "pass",
    message: `anthropic=${readAnthropicBaseUrl()} openai=${readOpenAiBaseUrl()} xai=${readXaiBaseUrl()} env(openai=${openAiPresent}, xai=${xaiPresent})`
  });

  checks.push({
    name: "config",
    status: runtimeConfig.loadedFiles.length > 0 ? "pass" : "warn",
    message: runtimeConfig.loadedFiles.length > 0
      ? `loaded ${runtimeConfig.loadedFiles.length} runtime config file(s)`
      : `no runtime config files loaded (settings path ${runtimeSettingsPath()})`
  });

  const sandbox = readSandboxReport(cwd);
  checks.push({
    name: "sandbox",
    status: sandbox.enabled && !sandbox.active ? "warn" : "pass",
    message: sandbox.enabled
      ? `enabled=${sandbox.enabled} active=${sandbox.active}${sandbox.fallbackReason ? ` fallback=${sandbox.fallbackReason}` : ""}`
      : "sandbox disabled in config"
  });

  return {
    cwd,
    model,
    provider,
    configFiles: runtimeConfig.loadedFiles,
    checks
  };
}

function discoverInstructionFiles(cwd: string): Array<{ path: string; content: string }> {
  const directories: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  directories.reverse();

  const files: Array<{ path: string; content: string }> = [];
  for (const dir of directories) {
    for (const candidate of [
      path.join(dir, "CLAUDE.md"),
      path.join(dir, "CLAUDE.local.md"),
      path.join(dir, ".clench", "CLAUDE.md"),
      path.join(dir, ".clench", "instructions.md")
    ]) {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const content = fs.readFileSync(candidate, "utf8");
      if (content.trim()) {
        files.push({ path: candidate, content });
      }
    }
  }

  const seen = new Set<string>();
  return files.filter((file) => {
    const normalized = file.content.replace(/\n{3,}/g, "\n\n").trim();
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function readCliVersion(): string {
  const packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: string };
  return parsed.version ?? "0.0.0";
}

function isInsideGitWorkTree(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}

function runGitDiffCommand(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}

function parseSlashCommandOrThrow(command: { name: string; args: string[] }): SlashCommand {
  try {
    const parsed = parseSlashCommand([command.name, ...command.args.map(quoteSlashArgIfNeeded)].join(" "));
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

function quoteSlashArgIfNeeded(value: string): string {
  if (!/[\s"'\\]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

  if (command.action === "delete") {
    if (!command.target) {
      throw new Error("/session delete requires a target");
    }
    const deletePath = resolveSessionFilePath(cwd, command.target);
    const deletingActiveSession = sessionInfo
      ? path.resolve(sessionInfo.path) === path.resolve(deletePath)
      : false;
    if (deletingActiveSession && !command.force) {
      throw new Error("Refusing to delete the active session without --force.");
    }
    if (!fs.existsSync(deletePath)) {
      throw new Error(`/session delete requires an existing session`);
    }
    fs.rmSync(deletePath, { force: true });
    process.stdout.write(renderSessionChangeView({ action: "deleted", path: deletePath }));
    return deletingActiveSession ? undefined : sessionInfo;
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

function handleResumeSlash(cwd: string, target: string | undefined): SessionInfo | undefined {
  if (!target) {
    process.stdout.write(renderResumeUsageView());
    return undefined;
  }
  const next = resolveSession(cwd, target);
  process.stdout.write(renderSessionChangeView({ action: "resumed", path: next.path, messages: next.messages.length }));
  return next;
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
  action: "list" | "install" | "enable" | "disable" | "uninstall" | "update" | undefined,
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
  const existing = readLocalConfig(localPath);
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

  if (action === "update") {
    const existingEntry = plugins[target];
    if (!existingEntry) {
      throw new Error(`/plugin update requires an installed plugin`);
    }
    if (!existingEntry.path) {
      throw new Error(`/plugin update requires a plugin path`);
    }
    const refreshed = loadPluginConfigEntry(existingEntry.path, target);
    plugins[target] = {
      ...refreshed,
      enabled: existingEntry.enabled
    };
    writeLocalConfig(localPath, { ...existing, plugins });
    process.stdout.write(
      renderPluginActionView("Plugin", [
        { key: "updated", value: target },
        { key: "path", value: refreshed.path ?? existingEntry.path },
        { key: "version", value: refreshed.version ?? existingEntry.version ?? "unknown" },
        { key: "tools", value: refreshed.toolCount ?? existingEntry.toolCount ?? 0 },
        { key: "health", value: refreshed.health ?? existingEntry.health ?? "validated" },
        { key: "enabled", value: existingEntry.enabled }
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

function readLocalConfig(filePath: string): RuntimeConfig {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as RuntimeConfig;
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
      lines.push(...renderExportBlock(block));
    }
    lines.push("");
  }
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });
  fs.writeFileSync(exportPath, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(renderExportView(exportPath));
}

function renderExportBlock(block: Record<string, unknown> & { type: string }): string[] {
  if (block.type === "text") {
    return [String(block.text ?? "")];
  }
  if (block.type === "tool_use") {
    return [
      `### tool_use ${String(block.name ?? "")} (${String(block.id ?? "")})`,
      "```json",
      safePrettyJson(String(block.input ?? "")),
      "```"
    ];
  }
  return [
    `### tool_result ${String(block.tool_name ?? "")} (${String(block.tool_use_id ?? "")}) error=${block.is_error ? "true" : "false"}`,
    "```text",
    String(block.output ?? ""),
    "```"
  ];
}

function safePrettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
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
