export type CliPermissionMode = "read-only" | "workspace-write" | "danger-full-access";
export type CliOutputFormat = "text" | "json" | "ndjson";

export type CliCommand =
  | { type: "dump-manifests" }
  | { type: "bootstrap-plan" }
  | { type: "login" }
  | { type: "logout" }
  | { type: "prompt"; prompt: string[] };

export interface CliOptions {
  model: string;
  permissionMode: CliPermissionMode;
  config?: string;
  outputFormat: CliOutputFormat;
  command?: CliCommand;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const result: CliOptions = {
    model: "claude-opus-4-6",
    permissionMode: "danger-full-access",
    outputFormat: "text"
  };

  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (token === "--model") {
      result.model = argv[index + 1] ?? result.model;
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

    if (token === "login") {
      result.command = { type: "login" };
      break;
    }
    if (token === "logout") {
      result.command = { type: "logout" };
      break;
    }
    if (token === "dump-manifests") {
      result.command = { type: "dump-manifests" };
      break;
    }
    if (token === "bootstrap-plan") {
      result.command = { type: "bootstrap-plan" };
      break;
    }
    if (token === "prompt") {
      result.command = { type: "prompt", prompt: argv.slice(index + 1) };
      break;
    }

    index += 1;
  }

  return result;
}
