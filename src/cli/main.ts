import { DEFAULT_MODEL, normalizeModelSelection } from "../api/providers";
import { loadRuntimeConfig } from "../runtime";
import { normalizeAllowedTools as normalizeWorkspaceAllowedTools } from "../tools/index.js";
import { parseCliArgs, type CliPermissionMode } from "./args";
import { parseSlashCommand } from "./app";

export type MainCliAction =
  | {
      type: "repl";
      model: string;
      permissionMode: CliPermissionMode;
      outputFormat: "text" | "json" | "ndjson";
      allowedTools?: string[];
      compact: boolean;
    }
  | { type: "prompt"; prompt: string; model: string; permissionMode: CliPermissionMode; outputFormat: "text" | "json" | "ndjson"; allowedTools?: string[]; compact: boolean }
  | { type: "slash"; command: string; model: string; permissionMode: CliPermissionMode }
  | { type: "help" };

const CLI_OPTION_SUGGESTIONS = [
  "--help",
  "--model",
  "--output-format",
  "--permission-mode",
  "--allowed-tools",
  "--compact",
  "--resume",
  "--session",
  "--persist"
];

function configuredModelForCwd(cwd: string): string {
  const merged = loadRuntimeConfig(cwd).merged;
  const configured = merged.model;
  return configured ? normalizeModelSelection(configured, merged) : DEFAULT_MODEL;
}

export function parseMainArgs(args: string[], cwd: string = process.cwd()): MainCliAction {
  const mergedConfig = loadRuntimeConfig(cwd).merged;
  const model = extractOption(args, "--model")
    ? normalizeModelSelection(extractOption(args, "--model")!, mergedConfig)
    : configuredModelForCwd(cwd);
  const permissionMode = extractOption(args, "--permission-mode")
    ? resolvePermissionMode(extractOption(args, "--permission-mode")!)
    : "danger-full-access";
  const outputFormat = (extractOption(args, "--output-format") as "text" | "json" | "ndjson" | undefined) ?? "text";
  const allowedTools = extractOption(args, "--allowed-tools")
    ? normalizeAllowedTools(extractOption(args, "--allowed-tools")!.split(","))
    : undefined;
  const compact = hasFlag(args, "--compact");

  const rest = stripKnownOptions(args);
  if (rest.length === 0) {
    return { type: "repl", model, permissionMode, outputFormat, allowedTools, compact };
  }
  // Only `/name` is a slash command; absolute paths like `/var/...` must fall through to prompt.
  if (
    rest[0]?.startsWith("/") &&
    rest[0].length > 1 &&
    !rest[0].slice(1).includes("/")
  ) {
    const parsed = parseSlashCommand(rest[0]);
    if (!parsed || parsed.type === "unknown") {
      throw new Error(unknownSlashCommandMessage(rest[0]!));
    }
    return { type: "slash", command: rest[0]!, model, permissionMode };
  }
  if (rest[0] === "prompt" || rest[0] === "--print" || rest[0] === "-p") {
    return {
      type: "prompt",
      prompt: rest.slice(1).join(" "),
      model,
      permissionMode,
      outputFormat,
      allowedTools,
      compact
    };
  }
  if (rest[0] === "--help" || rest[0] === "-h") {
    return { type: "help" };
  }
  if (rest[0]?.startsWith("--")) {
    throw new Error(unknownOptionMessage(rest[0]));
  }
  return {
    type: "prompt",
    prompt: rest.join(" "),
    model,
    permissionMode,
    outputFormat,
    allowedTools,
    compact
  };
}

export function resolvePermissionMode(value: string): CliPermissionMode {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  throw new Error(`unsupported permission mode: ${value}`);
}

export function normalizeAllowedTools(values: string[]): string[] {
  try {
    return [...new Set(
      normalizeWorkspaceAllowedTools(
        values
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => {
            const lowered = value.toLowerCase();
            return COMMON_CLI_TOOL_NAMES.has(lowered) ? lowered : value;
          })
      )
    )];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("unknown tool")) {
      throw new Error(`unsupported tool: ${message.slice("unknown tool ".length)}`);
    }
    throw new Error(`unsupported tool: ${message}`);
  }
}

const COMMON_CLI_TOOL_NAMES = new Set([
  "bash",
  "read",
  "read_file",
  "write",
  "write_file",
  "grep",
  "grep_search",
  "glob",
  "glob_search",
  "config",
  "mcp",
  "task"
]);

export function unknownOptionMessage(option: string): string {
  return `unknown option: ${option}\nTry one of: ${CLI_OPTION_SUGGESTIONS.join(", ")}`;
}

export function unknownSlashCommandMessage(command: string): string {
  return `unknown slash command: ${command}\nTry /help`;
}

function extractOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) {
    return args[index + 1];
  }
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }
  return undefined;
}

function stripKnownOptions(args: string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--persist" || token === "--compact") {
      continue;
    }
    if (
      ["--model", "--permission-mode", "--output-format", "--allowed-tools", "--resume", "--session"].includes(token)
    ) {
      index += 1;
      continue;
    }
    if (
      token.startsWith("--model=") ||
      token.startsWith("--permission-mode=") ||
      token.startsWith("--output-format=") ||
      token.startsWith("--allowed-tools=") ||
      token.startsWith("--resume=") ||
      token.startsWith("--session=")
    ) {
      continue;
    }
    stripped.push(token);
  }
  return stripped;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function parseThinCliArgs(args: string[]) {
  return parseCliArgs(args);
}
