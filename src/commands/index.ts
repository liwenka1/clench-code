export type SlashCommand =
  | { type: "help" }
  | { type: "status" }
  | { type: "compact" }
  | { type: "export"; destination?: string }
  | { type: "permissions"; mode?: "read-only" | "workspace-write" | "danger-full-access" }
  | { type: "clear"; confirm: boolean }
  | { type: "config"; section?: string }
  | { type: "session"; action?: "list" | "switch" | "fork"; target?: string }
  | { type: "mcp"; action?: "list" | "show" | "help"; target?: string }
  | { type: "plugin"; action?: "list" | "install" | "enable" | "disable"; target?: string };

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
  "Start here        /status, /help, /compact, /permissions",
  "/compact",
  "/export <path>",
  "/permissions [read-only|workspace-write|danger-full-access]",
  "/clear [--confirm]",
  "/config [env|hooks|model|plugins]",
  "/session [list|switch <session-id>|fork [branch-name]]",
  "/mcp [list|show <server>|help]",
  "/plugin [list|install <path>|enable <name>|disable <name>]",
  "aliases: /plugins, /marketplace"
];

export function parseSlashCommand(input: string): SlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const [rawCommand, ...args] = trimmed.slice(1).split(/\s+/);
  const command = normalizeCommand(rawCommand);

  if (!command) {
    throw new SlashCommandParseError("Slash command name is missing. Use /help to list available slash commands.");
  }

  switch (command) {
    case "help":
    case "status":
    case "compact":
      if (args.length > 0) {
        throw new SlashCommandParseError(`Unexpected arguments for /${command}.\n  Usage            /${command}`);
      }
      return { type: command };
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

function parseExport(args: string[]): SlashCommand {
  if (args.length > 1) {
    throw new SlashCommandParseError("Unexpected arguments for /export.\n  Usage            /export <path>");
  }
  return { type: "export", destination: args[0] };
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
  throw new SlashCommandParseError(
    `Unexpected arguments for /session ${action ?? ""}.\n  Usage            /session [list|switch <session-id>|fork [branch-name]]`
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
  if (["install", "enable", "disable"].includes(action ?? "") && rest.length === 1) {
    return {
      type: "plugin",
      action: action as "install" | "enable" | "disable",
      target: rest[0]
    };
  }
  throw new SlashCommandParseError(
    `Unexpected arguments for /plugin ${action ?? ""}.\n  Usage            /plugin [list|install <path>|enable <name>|disable <name>]`
  );
}

function normalizeCommand(command: string): string | undefined {
  const normalized = command.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "stats") {
    return "status";
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
