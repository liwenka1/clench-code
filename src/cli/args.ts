import { DEFAULT_MODEL, normalizeModelSelection } from "../api/providers";
import { loadRuntimeConfig } from "../runtime";

export type CliPermissionMode = "read-only" | "workspace-write" | "danger-full-access";
export type CliOutputFormat = "text" | "json" | "ndjson";

export type CliCommand =
  | { type: "version" }
  | { type: "init" }
  | { type: "dump-manifests" }
  | { type: "bootstrap-plan"; query: string[]; limit?: number }
  | { type: "doctor" }
  | { type: "sandbox" }
  | { type: "state" }
  | { type: "login" }
  | { type: "logout" }
  | { type: "mcp-serve" }
  | { type: "prompt"; prompt: string[] };

export interface CliOptions {
  model: string;
  permissionMode: CliPermissionMode;
  config?: string;
  outputFormat: CliOutputFormat;
  command?: CliCommand;
}

function configuredModelForCwd(cwd: string): string {
  const merged = loadRuntimeConfig(cwd).merged;
  const configured = merged.model;
  return configured ? normalizeModelSelection(configured, merged) : DEFAULT_MODEL;
}

export function parseCliArgs(argv: string[], cwd: string = process.cwd()): CliOptions {
  const merged = loadRuntimeConfig(cwd).merged;
  const result: CliOptions = {
    model: configuredModelForCwd(cwd),
    permissionMode: "danger-full-access",
    outputFormat: "text"
  };

  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (token === "--version" || token === "-V") {
      result.command = { type: "version" };
      break;
    }
    if (token === "--model") {
      result.model = normalizeModelSelection(argv[index + 1] ?? result.model, merged);
      index += 2;
      continue;
    }
    if (token === "--permission-mode") {
      result.permissionMode = (argv[index + 1] as CliPermissionMode) ?? result.permissionMode;
      index += 2;
      continue;
    }
    if (token === "--config") {
      result.config = argv[index + 1];
      index += 2;
      continue;
    }
    if (token === "--output-format") {
      result.outputFormat = (argv[index + 1] as CliOutputFormat) ?? result.outputFormat;
      index += 2;
      continue;
    }
    if (token === "--limit") {
      index += 2;
      continue;
    }

    if (token === "login") {
      result.command = { type: "login" };
      break;
    }
    if (token === "init") {
      result.command = { type: "init" };
      break;
    }
    if (token === "version") {
      result.command = { type: "version" };
      break;
    }
    if (token === "logout") {
      result.command = { type: "logout" };
      break;
    }
    if (token === "doctor") {
      result.command = { type: "doctor" };
      break;
    }
    if (token === "sandbox") {
      result.command = { type: "sandbox" };
      break;
    }
    if (token === "state") {
      result.command = { type: "state" };
      break;
    }
    if (token === "dump-manifests") {
      result.command = { type: "dump-manifests" };
      break;
    }
    if (token === "bootstrap-plan") {
      const args = argv.slice(index + 1);
      result.command = {
        type: "bootstrap-plan",
        query: args.filter((arg, argIndex) => !(arg === "--limit" || args[argIndex - 1] === "--limit") && !arg.startsWith("--limit=")),
        limit: parseLimit(args)
      };
      break;
    }
    if (token === "mcp") {
      const next = argv[index + 1]?.trim();
      if (next === "serve") {
        result.command = { type: "mcp-serve" };
        break;
      }
      // Other `mcp <sub>` forms (list/status/show/...) fall through to the
      // slash-command router, consistent with other multi-mode subcommands.
      index += 1;
      continue;
    }
    if (token === "prompt") {
      result.command = { type: "prompt", prompt: argv.slice(index + 1) };
      break;
    }

    index += 1;
  }

  return result;
}

function parseLimit(argv: string[]): number | undefined {
  const inline = argv.find((token) => token.startsWith("--limit="));
  if (inline) {
    return coercePositiveInt(inline.slice("--limit=".length));
  }
  const index = argv.indexOf("--limit");
  if (index === -1 || !argv[index + 1]) {
    return undefined;
  }
  return coercePositiveInt(argv[index + 1]);
}

function coercePositiveInt(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
