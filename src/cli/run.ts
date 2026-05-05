import { handlePluginCommand, printConfig, printMcp } from "./admin";
import { printCrons, printTasks, printTeams } from "./automation";
import { resolveSkillsCommand } from "./skills";
import { parseSlashCommand, renderSlashCommandHelp, SlashCommandParseError, type SlashCommand } from "../commands/index.js";
import { loadRuntimeConfig } from "../runtime/index.js";
import { DEFAULT_MODEL, normalizeModelSelection } from "../api/providers";
import { resolveCliOutputFormat, resolveCliPermissionMode } from "./args";
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
  printAgents,
  printDiff,
  printDoctor,
  printHelp,
  printInit,
  printMemory,
  printSandbox,
  printVersion
} from "./utility";

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

function isSlashCommandLike(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith("/") && !value.slice(1).includes("/");
}

function failUnknownSlashCommand(command: string): never {
  const suggestion = "/status";
  throw new Error(`unknown slash command outside the REPL: ${command}\nDid you mean ${suggestion}?`);
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

