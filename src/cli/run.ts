import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { handlePluginCommand, printConfig, printMcp } from "./admin";
import { renderAgentsCommand } from "./agents";
import { printCrons, printTasks, printTeams } from "./automation";
import { resolveSkillsCommand } from "./skills";
import {
  detectProviderKind,
  hasOpenAiCompatApiKey,
  readAnthropicBaseUrl,
  readOpenAiBaseUrl,
  readXaiBaseUrl
} from "../api/index.js";
import { parseSlashCommand, renderSlashCommandHelp, SlashCommandParseError, type SlashCommand } from "../commands/index.js";
import {
  credentialsPath,
  loadOauthConfig,
  loadOauthCredentials,
  loadRuntimeConfig,
  resolveSandboxStatus,
  runtimeSettingsPath,
  type RuntimeConfig
} from "../runtime/index.js";
import { DEFAULT_MODEL, normalizeModelSelection } from "../api/providers";
import { oauthTokenIsExpired } from "../runtime/oauth.js";
import { resolveCliOutputFormat, resolveCliPermissionMode } from "./args";
import { initializeRepo } from "./init";
import { inferCliOutputFormat, writeCliError } from "./error-output";
import {
  applyModelAddSlash,
  applyModelListSlash,
  applyModelSlash,
  type InteractivePrompter
} from "./model";
import { printPromptSummary, runPromptMode } from "./prompt-run";
import {
  clearSession,
  compactExistingSession,
  exportSession,
  handleResumeSlash,
  handleSessionSlash,
  resolveSession,
  type SessionInfo
} from "./session";
import {
  applyPermissionsSlash,
  printCost,
  printPromptHistory,
  printStatus
} from "./status";
import { printCliUsage } from "./usage";
import {
  renderConfigView,
  renderDoctorView,
  renderDiffView,
  renderHelpView,
  renderInitView,
  renderMemoryView,
  renderSandboxStatusView,
  renderVersionView
} from "./views";

export {
  type InteractivePrompter
} from "./model";

export {
  promptCacheOptionsForSession,
  resolveSessionFilePath,
  type SessionInfo
} from "./session";

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
          printCost(cli.model, sessionInfo);
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
          printPromptHistory(cli.cwd, sessionInfo?.path, parsed.count);
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

