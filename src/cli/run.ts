import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { handlePluginCommand, printConfig, printMcp, summarizeMcpStatus } from "./admin";
import { renderAgentsCommand } from "./agents";
import { printCrons, printTasks, printTeams } from "./automation";
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
  UsageTracker,
  credentialsPath,
  compactSession,
  loadOauthConfig,
  loadOauthCredentials,
  loadRuntimeConfig,
  resolveSandboxStatus,
  runtimeSettingsPath,
  sessionToJsonl,
  Session,
  type ModelProviderKind,
  type RuntimeConfig
} from "../runtime/index.js";
import type { ProviderClientConnectOptions } from "../api/providers";
import { DEFAULT_MODEL, normalizeModelSelection, resolveModelSelection, resolveProviderConnection } from "../api/providers";
import { oauthTokenIsExpired } from "../runtime/oauth.js";
import { resolveCliOutputFormat, resolveCliPermissionMode } from "./args";
import { loadPromptHistory, parsePromptHistoryLimit } from "./history";
import { initializeRepo } from "./init";
import { inferCliOutputFormat, writeCliError } from "./error-output";
import { readLocalConfig, writeLocalConfig } from "./local-config";
import { printPromptSummary, runPromptMode } from "./prompt-run";
import { printCliUsage } from "./usage";
import {
  renderClearSessionView,
  renderCompactView,
  renderConfigView,
  renderCostView,
  renderDoctorView,
  renderDiffView,
  renderExportView,
  renderHelpView,
  renderInitView,
  renderMemoryView,
  renderModelListView,
  renderModelView,
  renderPromptHistoryView,
  renderResumeUsageView,
  renderSandboxStatusView,
  renderSessionChangeView,
  renderSessionsView,
  renderStatusView,
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
          } else if (parsed.action === "list") {
            applyModelListSlash(cli);
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
  return value ? resolveCliOutputFormat(value) : "text";
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
      cli.permissionMode = value.trim() ? resolveCliPermissionMode(value) : cli.permissionMode;
      index += 1;
      continue;
    }
    if (token === "--permission-mode") {
      cli.permissionMode = resolveCliPermissionMode(optionValue(argv, index, token));
      index += 2;
      continue;
    }
    if (token === "--output-format") {
      cli.outputFormat = resolveCliOutputFormat(optionValue(argv, index, token));
      index += 2;
      continue;
    }
    if (token?.startsWith("--output-format=")) {
      const value = token.slice("--output-format=".length).trim();
      cli.outputFormat = value ? resolveCliOutputFormat(value) : cli.outputFormat;
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

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${option}`);
  }
  return value;
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
  assertKnownModelSelection(nextModel, merged);
  const selection = resolveModelSelection(nextModel, merged);
  cli.model = selection.configuredModel;
  const localPath = path.join(cli.cwd, ".clench", "settings.local.json");
  const existing = readLocalConfig(localPath);
  const providerDefaults = selection.providerId && selection.apiModel && existing.providers?.[selection.providerId]
    ? {
        ...(existing.providers ?? {}),
        [selection.providerId]: {
          ...existing.providers[selection.providerId],
          defaultModel: selection.apiModel
        }
      }
    : existing.providers;
  writeLocalConfig(localPath, {
    ...existing,
    ...(providerDefaults ? { providers: providerDefaults } : {}),
    model: cli.model
  });
  process.stdout.write(renderModelView({ current: cli.model, previous }));
}

const BUILTIN_BARE_MODEL_SELECTIONS = new Set([
  "opus",
  "sonnet",
  "haiku",
  "grok",
  "grok-2",
  "grok-3",
  "grok-mini",
  "grok-3-mini"
]);

function buildModelSelectionGuidance(
  summary: string,
  actions: string[],
  runtimeConfig?: RuntimeConfig,
  showConfiguredProviders = false
): string {
  const lines = [summary];
  if (showConfiguredProviders) {
    const providerIds = Object.keys(runtimeConfig?.providers ?? {}).sort();
    if (providerIds.length > 0) {
      lines.push(`Configured providers: ${providerIds.join(", ")}`);
    }
  }
  lines.push("Try:");
  lines.push(...actions.map((action) => `  ${action}`));
  return lines.join("\n");
}

function assertKnownModelSelection(selection: string, runtimeConfig: RuntimeConfig): void {
  const trimmed = selection.trim();
  if (!trimmed) {
    throw new Error("model selection is required");
  }

  const resolved = resolveModelSelection(trimmed, runtimeConfig);
  if (resolved.providerId) {
    return;
  }

  const configuredProvider = runtimeConfig.providers?.[trimmed];
  if (configuredProvider) {
    throw new Error(
      buildModelSelectionGuidance(
        `provider '${trimmed}' is configured, but it has no default model yet.`,
        [
          `/model ${trimmed}/<model-id> to switch with an explicit model`,
          `/model add ${trimmed} to set its default model`,
          "/model list to inspect configured providers"
        ]
      )
    );
  }

  const lower = trimmed.toLowerCase();
  if (BUILTIN_BARE_MODEL_SELECTIONS.has(lower) || lower.startsWith("claude") || lower.startsWith("grok")) {
    return;
  }

  if (trimmed.includes("/")) {
    const providerToken = trimmed.slice(0, trimmed.indexOf("/")).trim() || trimmed;
    throw new Error(
      buildModelSelectionGuidance(
        `unknown provider '${providerToken}'.`,
        [
          `/model add ${providerToken} to configure it`,
          "/model <provider-id>/<model-id> to select an explicit model",
          "/model list to inspect configured providers"
        ],
        runtimeConfig,
        true
      )
    );
  }

  throw new Error(
    buildModelSelectionGuidance(
      `unknown model selection '${trimmed}'.`,
      [
        "/model sonnet to use a built-in alias",
        "/model <provider-id> to use a provider default model",
        "/model <provider-id>/<model-id> to select an explicit model",
        "/model list to inspect configured providers"
      ],
      runtimeConfig,
      true
    )
  );
}

function applyModelListSlash(cli: ParsedCli): void {
  const merged = loadRuntimeConfig(cli.cwd).merged;
  const currentSelection = resolveModelSelection(cli.model, merged);
  const currentConnection = resolveProviderConnection(cli.model, merged);
  const defaultModel = normalizeModelSelection(merged.model ?? DEFAULT_MODEL, merged);
  const defaultSelection = resolveModelSelection(defaultModel, merged);

  const providers = Object.entries(merged.providers ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([providerId, provider]) => ({
      id: providerId,
      kind: provider.kind,
      baseUrl: effectiveProviderBaseUrl(provider.kind, provider.baseUrl),
      defaultModel: provider.defaultModel ?? (defaultSelection.providerId === providerId ? defaultSelection.apiModel : undefined),
      current: currentSelection.providerId === providerId
    }));

  process.stdout.write(
    renderModelListView({
      current: cli.model,
      defaultModel,
      currentProvider: currentSelection.providerId ?? detectProviderKind(cli.model, merged),
      currentBaseUrl: currentConnection
        ? effectiveProviderBaseUrl(currentConnection.provider, currentConnection.baseUrl)
        : undefined,
      providers
    })
  );
}

function effectiveProviderBaseUrl(kind: ModelProviderKind, configuredBaseUrl?: string): string {
  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }
  if (kind === "anthropic") {
    return readAnthropicBaseUrl();
  }
  if (kind === "xai") {
    return readXaiBaseUrl();
  }
  return readOpenAiBaseUrl();
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
    const modelId = await promptQuestion(activePrompter, "Default model ID", existingProvider?.defaultModel);
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
      ...(answers.apiKey ? { apiKey: answers.apiKey } : {}),
      defaultModel: answers.modelId
    }
  };
  const defaultModel = resolveModelSelection(`${answers.providerId}/${answers.modelId}`, { ...existing, providers }).apiModel;
  providers[answers.providerId] = {
    ...providers[answers.providerId],
    defaultModel
  };
  const nextConfig: RuntimeConfig = {
    ...existing,
    providers,
    ...(answers.setCurrentModel
      ? { model: normalizeModelSelection(`${answers.providerId}/${defaultModel}`, { ...existing, providers }) }
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

  const validationErrorCount = countConfigValidationErrors(runtimeConfig.validation);
  const validationWarningCount = countConfigValidationWarnings(runtimeConfig.validation);
  const skippedConfigCount = runtimeConfig.loadDiagnostics.length;
  checks.push({
    name: "config",
    status: skippedConfigCount > 0 || validationErrorCount > 0
      ? "fail"
      : runtimeConfig.loadedFiles.length > 0
        ? validationWarningCount > 0 ? "warn" : "pass"
        : "warn",
    message: runtimeConfig.loadedFiles.length > 0 || skippedConfigCount > 0
      ? `loaded ${runtimeConfig.loadedFiles.length} runtime config file(s), skipped ${skippedConfigCount}, diagnostics ${validationErrorCount} error(s) ${validationWarningCount} warning(s)`
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

function countConfigValidationErrors(validation: ReturnType<typeof loadRuntimeConfig>["validation"]): number {
  return Object.values(validation).reduce((count, result) => count + result.errors.length, 0);
}

function countConfigValidationWarnings(validation: ReturnType<typeof loadRuntimeConfig>["validation"]): number {
  return Object.values(validation).reduce((count, result) => count + result.warnings.length, 0);
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
