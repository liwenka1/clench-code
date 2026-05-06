import { handlePluginCommand, printConfig, printMcp } from "./admin";
import { printCrons, printTasks, printTeams } from "./automation";
import type { ParsedCli } from "./entry-args";
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
  type SessionInfo
} from "./session";
import { printSkills } from "./skills-command";
import { failUnknownSlashCommand } from "./slash-parser";
import {
  applyPermissionsSlash,
  printCost,
  printPromptHistory,
  printStatus
} from "./status";
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
import type { SlashCommand } from "../commands/index.js";

export interface SlashDispatchOptions {
  interactivePrompter?: InteractivePrompter;
}

export async function dispatchSlashCommand(
  cli: ParsedCli,
  sessionInfo: SessionInfo | undefined,
  parsed: SlashCommand,
  originalName: string,
  options: SlashDispatchOptions = {}
): Promise<SessionInfo | undefined> {
  switch (parsed.type) {
    case "help":
      printHelp();
      return sessionInfo;
    case "status":
      printStatus(cli, sessionInfo);
      return sessionInfo;
    case "agents":
      printAgents(cli.cwd, parsed.args);
      return sessionInfo;
    case "skills":
      await printSkills(cli, sessionInfo, parsed.args);
      return sessionInfo;
    case "tasks":
      printTasks(parsed.action, parsed.target, {
        prompt: parsed.prompt,
        description: parsed.description,
        message: parsed.message
      });
      return sessionInfo;
    case "teams":
      printTeams(parsed.action, parsed.target, { name: parsed.name, taskIds: parsed.taskIds, message: parsed.message });
      return sessionInfo;
    case "crons":
      printCrons(parsed.action, parsed.target, {
        schedule: parsed.schedule,
        prompt: parsed.prompt,
        description: parsed.description,
        teamId: parsed.teamId
      });
      return sessionInfo;
    case "version":
      printVersion();
      return sessionInfo;
    case "init":
      printInit(cli.cwd);
      return sessionInfo;
    case "doctor":
      printDoctor(cli.cwd, cli.model);
      return sessionInfo;
    case "sandbox":
      printSandbox(cli.cwd);
      return sessionInfo;
    case "cost":
      printCost(cli.model, sessionInfo);
      return sessionInfo;
    case "diff":
      printDiff(cli.cwd);
      return sessionInfo;
    case "memory":
      printMemory(cli.cwd);
      return sessionInfo;
    case "resume":
      return handleResumeSlash(cli.cwd, parsed.target);
    case "model":
      if (parsed.action === "add") {
        await applyModelAddSlash(cli, parsed.providerId, options.interactivePrompter);
      } else if (parsed.action === "list") {
        applyModelListSlash(cli);
      } else {
        applyModelSlash(cli, parsed.model);
      }
      return sessionInfo;
    case "history":
      printPromptHistory(cli.cwd, sessionInfo?.path, parsed.count);
      return sessionInfo;
    case "permissions":
      applyPermissionsSlash(cli, parsed.mode ? [parsed.mode] : []);
      return sessionInfo;
    case "config":
      printConfig(cli.cwd, parsed.section);
      return sessionInfo;
    case "export":
      if (!sessionInfo) {
        throw new Error("/export requires a resumed session");
      }
      if (!parsed.destination) {
        throw new Error("/export requires a destination path");
      }
      exportSession(sessionInfo, parsed.destination);
      return sessionInfo;
    case "clear":
      if (!sessionInfo) {
        throw new Error("/clear requires a resumed session");
      }
      return clearSession(sessionInfo, parsed.confirm);
    case "compact":
      if (!sessionInfo) {
        throw new Error("/compact requires a resumed session");
      }
      return compactExistingSession(sessionInfo);
    case "session":
      return handleSessionSlash(cli.cwd, sessionInfo, parsed);
    case "mcp":
      printMcp(cli.cwd, parsed.action, parsed.target);
      return sessionInfo;
    case "plugin":
      handlePluginCommand(cli.cwd, parsed.action, parsed.target);
      return sessionInfo;
    default:
      failUnknownSlashCommand(originalName);
  }
}
