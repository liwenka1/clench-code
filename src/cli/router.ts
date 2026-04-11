import path from "node:path";

import { parseMainArgs } from "./main";
import { createTerminalPermissionPrompter, TerminalTurnPresenter } from "./presenter";
import { runReplLoop } from "./repl";
import { printPromptSummary, runPromptMode } from "./prompt-run";
import { resolveSessionFilePath, runCliMainWithArgv } from "./run";
import { printCliUsage } from "./usage";

/** `/help` yes; `/var/foo/session.jsonl` no (absolute path). */
function looksLikeSlashCommandToken(token: string): boolean {
  return token.startsWith("/") && token.length > 1 && !token.slice(1).includes("/");
}

/** `--resume` is checked before `--session` (same resolution rules). */
function extractSessionReference(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--resume") {
      return argv[i + 1];
    }
    if (token?.startsWith("--resume=")) {
      return token.slice("--resume=".length);
    }
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--session") {
      return argv[i + 1];
    }
    if (token?.startsWith("--session=")) {
      return token.slice("--session=".length);
    }
  }
  return undefined;
}

function hasPersistFlag(argv: string[]): boolean {
  return argv.includes("--persist");
}

/**
 * Top-level CLI router: thin slash/status session commands vs one-shot `parseMainArgs` prompt mode.
 */
export async function runCliEntry(argv: string[]): Promise<void> {
  const resumeRef = extractSessionReference(argv);
  const persistFlag = hasPersistFlag(argv);

  if (argv.some(looksLikeSlashCommandToken)) {
    runCliMainWithArgv(argv);
    return;
  }
  if (argv.includes("status")) {
    runCliMainWithArgv(argv);
    return;
  }

  const action = parseMainArgs(argv);
  if (action.type === "help") {
    printCliUsage();
    return;
  }

  if (action.type === "repl") {
    let resumePath: string | undefined;
    if (resumeRef) {
      resumePath = resolveSessionFilePath(process.cwd(), resumeRef);
    } else if (persistFlag) {
      resumePath = path.join(process.cwd(), ".clench", "sessions", "default.jsonl");
    }
    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (tty) {
      await runReplLoop({
        model: action.model,
        permissionMode: action.permissionMode,
        outputFormat: action.outputFormat,
        allowedTools: action.allowedTools,
        resumeSessionPath: resumePath
      });
      return;
    }
    runCliMainWithArgv(argv);
    return;
  }

  if (action.type === "prompt" && action.prompt.trim()) {
    let resumePath: string | undefined;
    if (resumeRef) {
      resumePath = resolveSessionFilePath(process.cwd(), resumeRef);
    } else if (persistFlag) {
      resumePath = path.join(process.cwd(), ".clench", "sessions", "default.jsonl");
    }
    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const presenter = tty && action.outputFormat === "text"
      ? new TerminalTurnPresenter({ interactive: true })
      : undefined;
    try {
      presenter?.beginTurn();
      const summary = await runPromptMode({
        prompt: action.prompt,
        model: action.model,
        permissionMode: action.permissionMode,
        outputFormat: action.outputFormat,
        allowedTools: action.allowedTools,
        resumeSessionPath: resumePath,
        prompter: tty && action.permissionMode === "workspace-write" ? createTerminalPermissionPrompter() : undefined,
        observer: presenter
          ? {
              onToolResult: ({ toolName, output, isError }) => presenter.onToolResult(toolName, output, isError)
            }
          : undefined,
        onAssistantEvent: presenter ? (event) => presenter.onAssistantEvent(event) : undefined
      });
      if (presenter) {
        presenter.finish(summary);
      } else {
        printPromptSummary(summary, action.outputFormat);
      }
    } catch (error) {
      presenter?.fail(error);
      throw error;
    }
    return;
  }

  if (resumeRef) {
    runCliMainWithArgv(argv);
    return;
  }

  runCliMainWithArgv(argv);
}
