import { handlePluginCommand, printConfig, printMcp } from "./admin";
import { printCrons, printTasks, printTeams } from "./automation";
import { parseArgs } from "./entry-args";
import { printSkills } from "./skills-command";
import { failUnknownSlashCommand, parseSlashCommandOrThrow } from "./slash-parser";
import { resolveCliOutputFormat } from "./args";
import { inferCliOutputFormat, writeCliError } from "./error-output";
import {
  applyModelAddSlash,
  applyModelListSlash,
  applyModelSlash,
  type InteractivePrompter
} from "./model";
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

function normalizeCliOutputFormat(value: string | undefined): "text" | "json" | "ndjson" {
  return value ? resolveCliOutputFormat(value) : "text";
}

