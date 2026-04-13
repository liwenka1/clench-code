export type SlashCommand =
  | { type: "help" }
  | { type: "status" }
  | { type: "agents"; args: string[] }
  | { type: "skills"; args: string[] }
  | { type: "tasks"; action?: "list" | "get" | "stop" | "output"; target?: string }
  | { type: "teams"; action?: "list" | "get" | "delete" | "create"; target?: string; name?: string; taskIds?: string[] }
  | {
      type: "crons";
      action?: "list" | "get" | "delete" | "create" | "disable" | "run";
      target?: string;
      schedule?: string;
      prompt?: string;
      description?: string;
    }
  | { type: "version" }
  | { type: "init" }
  | { type: "doctor" }
  | { type: "sandbox" }
  | { type: "cost" }
  | { type: "diff" }
  | { type: "memory" }
  | { type: "resume"; target?: string }
  | { type: "model"; model?: string }
  | { type: "history"; count?: number }
  | { type: "compact" }
  | { type: "export"; destination?: string }
  | { type: "permissions"; mode?: "read-only" | "workspace-write" | "danger-full-access" }
  | { type: "clear"; confirm: boolean }
  | { type: "config"; section?: string }
  | { type: "session"; action?: "list" | "switch" | "fork" | "delete"; target?: string; force?: boolean }
  | { type: "mcp"; action?: "list" | "show" | "help"; target?: string }
  | { type: "plugin"; action?: "list" | "install" | "enable" | "disable" | "uninstall" | "update"; target?: string };

export type CommandSource = "builtin" | "feature-gated" | "internal-only";

export interface CommandManifestEntry {
  name: string;
  source: CommandSource;
}

export class CommandRegistry {
  constructor(private readonly manifestEntries: CommandManifestEntry[]) {}

  entries(): CommandManifestEntry[] {
    return [...this.manifestEntries];
  }
}

export class SlashCommandParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlashCommandParseError";
  }
}

const HELP_LINES = [
  "Start here        /status, /help, /agents, /skills, /tasks, /teams, /crons, /version, /init, /doctor, /sandbox, /resume, /cost, /diff, /memory, /model, /history, /compact, /permissions",
  "/agents [list|help]",
  "/skills [list|install <path>|help|<skill> [args]]",
  "/tasks [list|get <task-id>|stop <task-id>|output <task-id>]",
  "/teams [list|get <team-id>|delete <team-id>|create <name> [task-id...]]",
  "/crons [list|get <cron-id>|delete <cron-id>|create \"<schedule>\" \"<prompt>\" [description]|disable <cron-id>|run <cron-id>]",
  "/version",
  "/init",
  "/doctor",
  "/sandbox",
  "/resume <session-path|session-id|latest>",
  "/cost",
  "/diff",
  "/memory",
  "/model [alias|id]",
  "/compact",
  "/history [count]",
  "/export <path>",
  "/permissions [read-only|workspace-write|danger-full-access]",
  "/clear [--confirm]",
  "/config [env|hooks|model|plugins]",
  "/session [list|switch <session-id>|fork [branch-name]|delete <session-id> [--force]]",
  "/mcp [list|show <server>|help]",
  "/plugin [list|install <path>|enable <name>|disable <name>|uninstall <name>|update <name>]",
  "aliases: /plugins, /marketplace"
];

export function parseSlashCommand(input: string): SlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const [rawCommand, ...args] = tokenizeSlashTokens(trimmed.slice(1));
  const command = normalizeCommand(rawCommand);

  if (!command) {
    throw new SlashCommandParseError("Slash command name is missing. Use /help to list available slash commands.");
  }

  switch (command) {
    case "help":
    case "status":
    case "version":
    case "init":
    case "doctor":
    case "sandbox":
    case "cost":
    case "diff":
    case "memory":
    case "compact":
      if (args.length > 0) {
        throw new SlashCommandParseError(`Unexpected arguments for /${command}.\n  Usage            /${command}`);
      }
      return { type: command };
    case "history":
      return parseHistory(args);
    case "agents":
      return { type: "agents", args };
    case "skills":
      return { type: "skills", args };
    case "tasks":
      return parseTasks(args);
    case "teams":
      return parseTeams(args);
    case "crons":
      return parseCrons(args);
    case "resume":
      return parseResume(args);
    case "model":
      return parseModel(args);
    case "export":
      return parseExport(args);
    case "permissions":
      return parsePermissions(args);
    case "clear":
      return parseClear(args);
    case "config":
      return parseConfig(args);
    case "session":
      return parseSession(args);
    case "mcp":
      return parseMcp(args);
    case "plugin":
      return parsePlugin(args);
    default:
      throw new SlashCommandParseError(`Unknown slash command '/${command}'.`);
  }
}

export function renderSlashCommandHelp(): string {
  return HELP_LINES.join("\n");
}

export function suggestSlashCommands(input: string, limit: number): string[] {
  const target = normalizeCommand(input.replace(/^\//, "")) ?? input.replace(/^\//, "").trim().toLowerCase();
  const candidates = [
    "/help",
    "/status",
    "/agents",
    "/skills",
    "/tasks",
    "/teams",
    "/crons",
    "/version",
    "/init",
    "/doctor",
    "/sandbox",
    "/resume",
    "/cost",
    "/diff",
    "/memory",
    "/model",
    "/history",
    "/compact",
    "/export",
    "/permissions",
    "/clear",
    "/config",
    "/session",
    "/mcp",
    "/plugin"
  ];

  return candidates
    .map((candidate) => ({ candidate, score: levenshtein(candidate.slice(1), target) }))
    .sort((left, right) => left.score - right.score || left.candidate.localeCompare(right.candidate))
    .filter((entry) => entry.score <= Math.max(2, Math.floor(target.length / 2)))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

function parseResume(args: string[]): SlashCommand {
  if (args.length === 0) {
    return { type: "resume" };
  }
  if (args.length > 1) {
    throw new SlashCommandParseError(
      "Unexpected arguments for /resume.\n  Usage            /resume <session-path|session-id|latest>"
    );
  }
  return { type: "resume", target: args[0] };
}

function parseTasks(args: string[]): SlashCommand {
  if (args.length === 0) {
    return { type: "tasks", action: "list" };
  }
  const [action, ...rest] = args;
  if (action === "list" && rest.length === 0) {
    return { type: "tasks", action: "list" };
  }
  if ((action === "get" || action === "stop" || action === "output") && rest.length === 1) {
    return { type: "tasks", action, target: rest[0] };
  }
  throw new SlashCommandParseError(
    `Unexpected arguments for /tasks ${action ?? ""}.\n  Usage            /tasks [list|get <task-id>|stop <task-id>|output <task-id>]`
  );
}

function parseTeams(args: string[]): SlashCommand {
  if (args.length === 0) {
    return { type: "teams", action: "list" };
  }
  const [action, ...rest] = args;
  if (action === "list" && rest.length === 0) {
    return { type: "teams", action: "list" };
  }
  if (action === "create" && rest.length >= 1) {
    return { type: "teams", action: "create", name: rest[0], taskIds: rest.slice(1) };
  }
  if ((action === "get" || action === "delete") && rest.length === 1) {
    return { type: "teams", action, target: rest[0] };
  }
  throw new SlashCommandParseError(
    `Unexpected arguments for /teams ${action ?? ""}.\n  Usage            /teams [list|get <team-id>|delete <team-id>|create <name> [task-id...]]`
  );
}

function parseCrons(args: string[]): SlashCommand {
  if (args.length === 0) {
    return { type: "crons", action: "list" };
  }
  const [action, ...rest] = args;
  if (action === "list" && rest.length === 0) {
    return { type: "crons", action: "list" };
  }
  if (action === "create" && rest.length >= 2 && rest.length <= 3) {
    return { type: "crons", action: "create", schedule: rest[0], prompt: rest[1], description: rest[2] };
  }
  if ((action === "get" || action === "delete" || action === "disable" || action === "run") && rest.length === 1) {
    return { type: "crons", action, target: rest[0] };
  }
  throw new SlashCommandParseError(
    `Unexpected arguments for /crons ${action ?? ""}.\n  Usage            /crons [list|get <cron-id>|delete <cron-id>|create "<schedule>" "<prompt>" [description]|disable <cron-id>|run <cron-id>]`
  );
}

function tokenizeSlashTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (quote) {
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping || quote) {
    throw new SlashCommandParseError("Unterminated quoted argument in slash command.");
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function parseModel(args: string[]): SlashCommand {
  if (args.length === 0) {
    return { type: "model" };
  }
  if (args.length > 1) {
    throw new SlashCommandParseError("Unexpected arguments for /model.\n  Usage            /model [alias|id]");
  }
  return { type: "model", model: args[0] };
}

function parseExport(args: string[]): SlashCommand {
  if (args.length > 1) {
    throw new SlashCommandParseError("Unexpected arguments for /export.\n  Usage            /export <path>");
  }
  return { type: "export", destination: args[0] };
}

function parseHistory(args: string[]): SlashCommand {
  if (args.length === 0) {
    return { type: "history" };
  }
  if (args.length > 1) {
    throw new SlashCommandParseError("Unexpected arguments for /history.\n  Usage            /history [count]");
  }
  const count = Number(args[0]);
  if (!Number.isInteger(count) || count <= 0) {
    throw new SlashCommandParseError(`history: invalid count '${args[0] ?? ""}'. Expected a positive integer.`);
  }
  return { type: "history", count };
}

function parsePermissions(args: string[]): SlashCommand {
  if (args.length === 0) {
    return { type: "permissions" };
  }
  const mode = args[0];
  if (!mode || !["read-only", "workspace-write", "danger-full-access"].includes(mode)) {
    throw new SlashCommandParseError(
      `Unsupported /permissions mode '${mode ?? ""}'. Use read-only, workspace-write, or danger-full-access.`
    );
  }
  if (args.length > 1) {
    throw new SlashCommandParseError(
      "Unexpected arguments for /permissions.\n  Usage            /permissions [read-only|workspace-write|danger-full-access]"
    );
  }
  return { type: "permissions", mode: mode as "read-only" | "workspace-write" | "danger-full-access" };
}

function parseClear(args: string[]): SlashCommand {
  if (args.length === 0) {
    return { type: "clear", confirm: false };
  }
  if (args.length === 1 && args[0] === "--confirm") {
    return { type: "clear", confirm: true };
  }
  throw new SlashCommandParseError("Unexpected arguments for /clear.\n  Usage            /clear [--confirm]");
}

function parseConfig(args: string[]): SlashCommand {
  if (args.length === 0) {
    return { type: "config" };
  }
  const section = args[0];
  if (!section || args.length > 1) {
    throw new SlashCommandParseError("Unexpected arguments for /config.\n  Usage            /config [env|hooks|model|plugins]");
  }
  return { type: "config", section };
}

function parseSession(args: string[]): SlashCommand {
  if (args.length === 0) {
    return { type: "session" };
  }
  const [action, ...rest] = args;
  if (action === "list" && rest.length === 0) {
    return { type: "session", action: "list" };
  }
  if (action === "switch" && rest.length === 1) {
    return { type: "session", action: "switch", target: rest[0] };
  }
  if (action === "fork" && rest.length <= 1) {
    return { type: "session", action: "fork", target: rest[0] };
  }
  if (action === "delete" && rest.length === 1) {
    return { type: "session", action: "delete", target: rest[0], force: false };
  }
  if (action === "delete" && rest.length === 2 && rest[1] === "--force") {
    return { type: "session", action: "delete", target: rest[0], force: true };
  }
  if (action === "delete" && rest.length >= 2 && rest[1] !== "--force") {
    throw new SlashCommandParseError(
      `Unsupported /session delete flag '${rest[1] ?? ""}'. Use --force to skip confirmation.`
    );
  }
  throw new SlashCommandParseError(
    `Unexpected arguments for /session ${action ?? ""}.\n  Usage            /session [list|switch <session-id>|fork [branch-name]|delete <session-id> [--force]]`
  );
}

function parseMcp(args: string[]): SlashCommand {
  if (args.length === 0) {
    return { type: "mcp" };
  }
  const [action, ...rest] = args;
  if (action === "list" && rest.length === 0) {
    return { type: "mcp", action: "list" };
  }
  if (action === "help" && rest.length === 0) {
    return { type: "mcp", action: "help" };
  }
  if (action === "show" && rest.length === 1) {
    return { type: "mcp", action: "show", target: rest[0] };
  }
  throw new SlashCommandParseError("Unexpected arguments for /mcp.\n  Usage            /mcp [list|show <server>|help]");
}

function parsePlugin(args: string[]): SlashCommand {
  if (args.length === 0) {
    return { type: "plugin" };
  }
  const [action, ...rest] = args;
  if (action === "list" && rest.length === 0) {
    return { type: "plugin", action: "list" };
  }
  if (["install", "enable", "disable", "uninstall", "update"].includes(action ?? "") && rest.length === 1) {
    return {
      type: "plugin",
      action: action as "install" | "enable" | "disable" | "uninstall" | "update",
      target: rest[0]
    };
  }
  throw new SlashCommandParseError(
    `Unexpected arguments for /plugin ${action ?? ""}.\n  Usage            /plugin [list|install <path>|enable <name>|disable <name>|uninstall <name>|update <name>]`
  );
}

function normalizeCommand(command: string): string | undefined {
  const normalized = command.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "skill") {
    return "skills";
  }
  if (normalized === "stats") {
    return "cost";
  }
  if (normalized === "plugins" || normalized === "marketplace") {
    return "plugin";
  }
  return normalized;
}

function levenshtein(left: string, right: string): number {
  const matrix = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[left.length][right.length];
}
