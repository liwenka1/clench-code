import path from "node:path";

import { parseCliArgs } from "./args";
import { parseMainArgs } from "./main";
import { createTerminalPermissionPrompter, TerminalTurnPresenter } from "./presenter";
import { runReplLoop } from "./repl";
import { printPromptSummary, runPromptMode } from "./prompt-run";
import { handleRouterCommand } from "./router-commands";
import {
  extractSessionReference,
  hasPersistFlag,
  looksLikeSlashCommandToken,
  translateHeadlessCommandArgv
} from "./router-entry";
import { handleRouterOAuthCommand } from "./router-oauth";
import { resolveSessionFilePath, runCliMainWithArgv } from "./run";
import { printCliUsage } from "./usage";

/**
 * Top-level CLI router: thin slash/status session commands vs one-shot `parseMainArgs` prompt mode.
 */
export async function runCliEntry(
  argv: string[],
  io: {
    stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
    openBrowser?: (url: string) => Promise<void>;
    waitForOAuthCallback?: (port: number) => Promise<{ code?: string; state?: string; error?: string; errorDescription?: string }>;
  } = {}
): Promise<void> {
  const stdin = io.stdin ?? process.stdin;
  const parsed = parseCliArgs(argv, process.cwd());
  if (await handleRouterCommand(parsed, process.cwd())) {
    return;
  }
  if (await handleRouterOAuthCommand(parsed, io)) {
    return;
  }
  const resumeRef = extractSessionReference(argv);
  const persistFlag = hasPersistFlag(argv);
  const translatedHeadlessArgv = translateHeadlessCommandArgv(argv);

  if (translatedHeadlessArgv) {
    await runCliMainWithArgv(translatedHeadlessArgv);
    return;
  }

  if (argv.some(looksLikeSlashCommandToken)) {
    await runCliMainWithArgv(argv);
    return;
  }
  if (argv.includes("status")) {
    await runCliMainWithArgv(argv);
    return;
  }

  const action = parseMainArgs(argv, process.cwd());
  const stdinContext = await readPipedStdin(stdin);
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
    const tty = Boolean(stdin.isTTY && process.stdout.isTTY);
    if (stdinContext) {
      await runPromptTurn({
        prompt: mergePromptWithStdin("", stdinContext),
        model: action.model,
        permissionMode: action.permissionMode,
        outputFormat: action.outputFormat,
        allowedTools: action.allowedTools,
        resumePath,
        compact: action.compact,
        tty
      });
      return;
    }
    if (tty) {
      await runReplLoop({
        model: action.model,
        permissionMode: action.permissionMode,
        outputFormat: action.outputFormat,
        allowedTools: action.allowedTools,
        resumeSessionPath: resumePath,
        compact: action.compact
      });
      return;
    }
    await runCliMainWithArgv(argv);
    return;
  }

  if (action.type === "prompt" && action.prompt.trim()) {
    let resumePath: string | undefined;
    if (resumeRef) {
      resumePath = resolveSessionFilePath(process.cwd(), resumeRef);
    } else if (persistFlag) {
      resumePath = path.join(process.cwd(), ".clench", "sessions", "default.jsonl");
    }
    const tty = Boolean(stdin.isTTY && process.stdout.isTTY);
    await runPromptTurn({
      prompt: mergePromptWithStdin(action.prompt, stdinContext),
      model: action.model,
      permissionMode: action.permissionMode,
      outputFormat: action.outputFormat,
      allowedTools: action.allowedTools,
      resumePath,
      compact: action.compact,
      tty
    });
    return;
  }

  if (resumeRef) {
    await runCliMainWithArgv(argv);
    return;
  }

  await runCliMainWithArgv(argv);
}

async function runPromptTurn(input: {
  prompt: string;
  model: string;
  permissionMode: "read-only" | "workspace-write" | "danger-full-access";
  outputFormat: "text" | "json" | "ndjson";
  allowedTools?: string[];
  resumePath?: string;
  compact: boolean;
  tty: boolean;
}): Promise<void> {
  const presenter = input.tty && input.outputFormat === "text" && !input.compact
    ? new TerminalTurnPresenter({ interactive: true, model: input.model })
    : undefined;
  try {
    presenter?.beginTurn();
    const summary = await runPromptMode({
      prompt: input.prompt,
      model: input.model,
      permissionMode: input.permissionMode,
      outputFormat: input.outputFormat,
      allowedTools: input.allowedTools,
      resumeSessionPath: input.resumePath,
      prompter: input.tty && input.permissionMode === "workspace-write" ? createTerminalPermissionPrompter() : undefined,
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
      printPromptSummary(summary, input.outputFormat, { compact: input.compact, model: input.model });
    }
  } catch (error) {
    presenter?.fail(error);
    throw error;
  }
}

async function readPipedStdin(
  stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin
): Promise<string | undefined> {
  if (stdin.isTTY) {
    return undefined;
  }
  let buffer = "";
  for await (const chunk of stdin) {
    buffer += String(chunk);
  }
  return buffer.trim() ? buffer : undefined;
}

function mergePromptWithStdin(prompt: string, stdinContent: string | undefined): string {
  const trimmedPrompt = prompt.trim();
  const trimmedStdin = stdinContent?.trim();
  if (!trimmedStdin) {
    return trimmedPrompt;
  }
  if (!trimmedPrompt) {
    return trimmedStdin;
  }
  return `${trimmedPrompt}\n\n${trimmedStdin}`;
}

