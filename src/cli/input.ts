import fs from "node:fs";
import path from "node:path";

import { listActiveSkillNames } from "./skills";

export type ReadOutcome =
  | { type: "submit"; value: string }
  | { type: "cancel" }
  | { type: "exit" };

export interface InteractiveCompletionContext {
  slashCommands: string[];
  currentModel?: string;
  sessionTargets?: string[];
  activeSessionTarget?: string;
  mcpServers?: string[];
  pluginNames?: string[];
  cwd?: string;
}

export function slashCommandPrefix(line: string, pos: number): string | undefined {
  if (pos !== line.length) {
    return undefined;
  }
  const prefix = line.slice(0, pos);
  if (!prefix.startsWith("/")) {
    return undefined;
  }
  return prefix;
}

export function normalizeCompletions(completions: string[]): string[] {
  return [...new Set(completions.filter((candidate) => candidate.startsWith("/")))];
}

export function completeSlashCommand(
  line: string,
  pos: number,
  completions: string[]
): { start: number; matches: string[] } {
  const prefix = slashCommandPrefix(line, pos);
  if (!prefix) {
    return { start: 0, matches: [] };
  }
  return {
    start: 0,
    matches: normalizeCompletions(completions).filter((candidate) => candidate.startsWith(prefix))
  };
}

export function completeInteractiveSlashCommand(
  line: string,
  pos: number,
  context: InteractiveCompletionContext
): { start: number; matches: string[] } {
  const prefix = slashCommandPrefix(line, pos);
  if (!prefix) {
    return { start: 0, matches: [] };
  }
  const trimmed = prefix.trimEnd();
  const hasTrailingSpace = /\s$/.test(prefix);
  const parts = trimmed.split(/\s+/);
  const command = parts[0] ?? "";
  const normalizedCommand = command.toLowerCase();

  if (parts.length === 1 && !hasTrailingSpace) {
    const workflowCompletions = workflowCandidates(context);
    return {
      start: 0,
      matches: normalizeCompletions([...context.slashCommands, ...workflowCompletions]).filter((candidate) => candidate.startsWith(prefix))
    };
  }

  const commandStart = command.length + 1;
  const args = prefix.slice(commandStart);
  const argStart = prefix.lastIndexOf(" ") + 1;
  const currentArg = prefix.slice(argStart);
  const tokens = prefix.slice(commandStart).trim().split(/\s+/).filter(Boolean);
  const candidates = candidatesForSlashCommand(normalizedCommand, tokens, hasTrailingSpace, context);
  return {
    start: argStart,
    matches: candidates.filter((candidate) => candidate.startsWith(currentArg))
  };
}

export function parseReadResult(value: string | null | undefined): ReadOutcome {
  if (value == null) {
    return { type: "exit" };
  }
  return { type: "submit", value };
}

function candidatesForSlashCommand(
  command: string,
  tokens: string[],
  hasTrailingSpace: boolean,
  context: InteractiveCompletionContext
): string[] {
  const normalized = normalizeSlashCommandName(command);
  const nextIndex = hasTrailingSpace ? tokens.length : Math.max(tokens.length - 1, 0);
  switch (normalized) {
    case "/agents":
      return nextIndex === 0 ? ["list", "help"] : [];
    case "/tasks":
      if (nextIndex === 0) return ["list", "get", "stop", "output"];
      return [];
    case "/teams":
      if (nextIndex === 0) return ["list", "get", "delete", "create"];
      return [];
    case "/crons":
      if (nextIndex === 0) return ["list", "get", "delete", "create", "disable", "run"];
      return [];
    case "/skills":
      if (nextIndex === 0) return uniqueCandidates(["list", "install", "help", ...skillCandidates(context.cwd)]);
      if (tokens[0] === "install" && nextIndex === 1) {
        return pathCandidates(context.cwd, tokens[1] ?? "");
      }
      return [];
    case "/resume":
      return nextIndex === 0
        ? uniqueCandidates(["latest", ...(context.sessionTargets ?? []), ...pathCandidates(context.cwd, tokens[0] ?? "")])
        : [];
    case "/model":
      return nextIndex === 0
        ? uniqueCandidates(["opus", "sonnet", "haiku", context.currentModel ?? ""])
        : [];
    case "/permissions":
      return nextIndex === 0 ? ["read-only", "workspace-write", "danger-full-access"] : [];
    case "/config":
      return nextIndex === 0 ? ["env", "hooks", "model", "plugins"] : [];
    case "/history":
      return nextIndex === 0 ? ["10", "20", "50"] : [];
    case "/session":
      if (nextIndex === 0) return ["list", "switch", "fork", "delete"];
      if (tokens[0] === "switch" && nextIndex === 1) {
        return uniqueCandidates(["latest", ...(context.sessionTargets ?? []), ...pathCandidates(context.cwd, tokens[1] ?? "")]);
      }
      if (tokens[0] === "delete" && nextIndex === 1) {
        return uniqueCandidates([...(context.sessionTargets ?? []), ...pathCandidates(context.cwd, tokens[1] ?? "")]);
      }
      if (tokens[0] === "delete" && nextIndex === 2) {
        return ["--force"];
      }
      return [];
    case "/mcp":
      if (nextIndex === 0) return ["list", "show", "help"];
      if (tokens[0] === "show" && nextIndex === 1) {
        return context.mcpServers ?? [];
      }
      return [];
    case "/plugin":
      if (nextIndex === 0) return ["list", "install", "enable", "disable", "uninstall", "update"];
      if (tokens[0] === "install" && nextIndex === 1) {
        return pathCandidates(context.cwd, tokens[1] ?? "");
      }
      if (["enable", "disable", "uninstall", "update"].includes(tokens[0] ?? "") && nextIndex === 1) {
        return context.pluginNames ?? [];
      }
      return [];
    case "/export":
      return nextIndex === 0 ? pathCandidates(context.cwd, tokens[0] ?? "") : [];
    case "/clear":
      return nextIndex === 0 ? ["--confirm"] : [];
    default:
      return [];
  }
}

function workflowCandidates(context: InteractiveCompletionContext): string[] {
  return uniqueCandidates([
    "/history ",
    "/history 10",
    "/history 20",
    "/history 50",
    "/agents",
    "/agents list",
    "/agents help",
    "/tasks",
    "/tasks list",
    "/tasks get ",
    "/tasks stop ",
    "/tasks output ",
    "/teams",
    "/teams list",
    "/teams get ",
    "/teams delete ",
    "/teams create ",
    "/crons",
    "/crons list",
    "/crons get ",
    "/crons delete ",
    "/crons create ",
    "/crons disable ",
    "/crons run ",
    "/skills",
    "/skills list",
    "/skills install ",
    "/skills help",
    ...skillCandidates(context.cwd).map((skill) => `/skills ${skill}`),
    "/version",
    "/init",
    "/doctor",
    "/sandbox",
    "/resume ",
    "/resume latest",
    "/cost",
    "/diff",
    "/memory",
    "/model ",
    "/model opus",
    "/model sonnet",
    "/model haiku",
    ...(context.currentModel ? [`/model ${context.currentModel}`] : []),
    "/clear --confirm",
    "/config ",
    "/config env",
    "/config hooks",
    "/config model",
    "/config plugins",
    "/export ",
    "/mcp ",
    "/mcp list",
    "/mcp show ",
    "/mcp help",
    ...(context.mcpServers ?? []).map((server) => `/mcp show ${server}`),
    "/permissions ",
    "/permissions read-only",
    "/permissions workspace-write",
    "/permissions danger-full-access",
    "/plugin list",
    "/plugin install ",
    "/plugin enable ",
    "/plugin disable ",
    "/plugin uninstall ",
    "/plugin update ",
    "/plugins list",
    "/marketplace list",
    "/session list",
    "/session switch ",
    "/session switch latest",
    "/session fork ",
    "/session delete ",
    "/session delete --force",
    ...(context.activeSessionTarget ? [`/session switch ${context.activeSessionTarget}`] : []),
    ...(context.sessionTargets ?? []).flatMap((target) => [`/session switch ${target}`, `/session delete ${target}`])
  ]);
}

function normalizeSlashCommandName(command: string): string {
  if (command === "/plugins" || command === "/marketplace") {
    return "/plugin";
  }
  return command;
}

function pathCandidates(cwd: string | undefined, rawPrefix: string): string[] {
  if (!cwd) {
    return [];
  }
  const prefix = rawPrefix.trim();
  const targetPrefix = prefix || ".";
  const absoluteTarget = path.isAbsolute(targetPrefix)
    ? targetPrefix
    : path.resolve(cwd, targetPrefix);
  const directory = fs.existsSync(absoluteTarget) && fs.statSync(absoluteTarget).isDirectory()
    ? absoluteTarget
    : path.dirname(absoluteTarget);
  if (!fs.existsSync(directory)) {
    return [];
  }
  const basenamePrefix = fs.existsSync(absoluteTarget) && fs.statSync(absoluteTarget).isDirectory()
    ? ""
    : path.basename(targetPrefix);
  const suggestions = fs.readdirSync(directory)
    .filter((name) => name.startsWith(basenamePrefix))
    .map((name) => {
      const joined = path.join(directory, name);
      const relative = path.isAbsolute(targetPrefix)
        ? joined
        : path.relative(cwd, joined) || ".";
      return fs.statSync(joined).isDirectory() ? `${relative}${path.sep}` : relative;
    });
  if (!prefix) {
    return suggestions;
  }
  return suggestions.filter((candidate) => candidate.startsWith(prefix));
}

function uniqueCandidates(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function skillCandidates(cwd: string | undefined): string[] {
  if (!cwd) {
    return [];
  }
  try {
    return listActiveSkillNames(cwd);
  } catch {
    return [];
  }
}
