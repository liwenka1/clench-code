import { parseArgs } from "./entry-args";
import { parseSlashCommandOrThrow } from "./slash-parser";
import { dispatchSlashCommand } from "./slash-dispatch";
import { resolveCliOutputFormat } from "./args";
import { inferCliOutputFormat, writeCliError } from "./error-output";
import {
  type InteractivePrompter
} from "./model";
import {
  resolveSession,
  type SessionInfo
} from "./session";
import { printStatus } from "./status";
import { printCliUsage } from "./usage";

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
      sessionInfo = await dispatchSlashCommand(cli, sessionInfo, parsed, command.name, {
        interactivePrompter: options.interactivePrompter
      });
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

