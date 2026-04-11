import path from "node:path";
import * as readline from "node:readline";

import { parseSlashCommand, type SlashCommand } from "../commands/index.js";
import { Session, type PermissionMode } from "../runtime";
import { completeSlashCommand } from "./input";
import { createTerminalPermissionPrompter, TerminalTurnPresenter } from "./presenter";
import { printPromptSummary, runPromptMode } from "./prompt-run";
import { resolveSessionFilePath, runCliMainWithArgv } from "./run";
import { renderReplBanner } from "./views";

export interface RunReplLoopOptions {
  model: string;
  permissionMode: PermissionMode;
  outputFormat: "text" | "json" | "ndjson";
  allowedTools?: string[];
  resumeSessionPath?: string;
}

/**
 * Minimal stdin/stdout REPL: one line → one `runPromptMode` turn (same stack as one-shot prompt).
 */
export async function runReplLoop(options: RunReplLoopOptions): Promise<void> {
  let currentPermissionMode = options.permissionMode;
  let currentSessionPath = options.resumeSessionPath;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 500,
    completer: (line: string) => {
      const { start, matches } = completeSlashCommand(line, line.length, SLASH_COMPLETIONS);
      return [matches, line.slice(start)];
    }
  });
  const permissionPrompter = createTerminalPermissionPrompter({
    suspendInput: () => rl.pause(),
    resumeInput: () => rl.resume()
  });
  process.stdout.write(
    `${renderReplBanner({
      model: options.model,
      permissionMode: currentPermissionMode,
      sessionLabel: currentSessionPath ? path.basename(currentSessionPath) : "ephemeral",
      cwd: process.cwd()
    })}\n\n`
  );
  const prompt = () => {
    rl.setPrompt(`clench(${currentPermissionMode})> `);
    rl.prompt();
  };

  prompt();

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === "exit" || trimmed === "quit") {
        break;
      }
      if (!trimmed) {
        prompt();
        continue;
      }
      if (isSlashCommandToken(trimmed)) {
        try {
          const next = handleInteractiveSlash(trimmed, {
            model: options.model,
            permissionMode: currentPermissionMode,
            resumeSessionPath: currentSessionPath
          });
          currentPermissionMode = next.permissionMode;
          currentSessionPath = next.resumeSessionPath;
        } catch (error) {
          process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        prompt();
        continue;
      }
      const presenter = options.outputFormat === "text" ? new TerminalTurnPresenter({ interactive: true }) : undefined;
      try {
        presenter?.beginTurn();
        const summary = await runPromptMode({
          prompt: trimmed,
          model: options.model,
          permissionMode: currentPermissionMode,
          outputFormat: options.outputFormat,
          allowedTools: options.allowedTools,
          resumeSessionPath: currentSessionPath,
          prompter: currentPermissionMode === "workspace-write" ? permissionPrompter : undefined,
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
          printPromptSummary(summary, options.outputFormat);
        }
      } catch (error) {
        presenter?.fail(error);
        process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      prompt();
    }
  } finally {
    rl.close();
  }
}

const SLASH_COMPLETIONS = [
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

function isSlashCommandToken(value: string): boolean {
  return value.startsWith("/") && value.length > 1 && !value.slice(1).includes("/");
}

function handleInteractiveSlash(
  line: string,
  state: { model: string; permissionMode: PermissionMode; resumeSessionPath?: string }
): { permissionMode: PermissionMode; resumeSessionPath?: string } {
  const parsed = parseSlashCommand(line);
  const argv = [
    "--model",
    state.model,
    "--permission-mode",
    state.permissionMode,
    ...(state.resumeSessionPath ? ["--resume", state.resumeSessionPath] : []),
    ...line.trim().split(/\s+/)
  ];
  runCliMainWithArgv(argv);

  if (!parsed) {
    return state;
  }
  if (parsed.type === "permissions" && parsed.mode) {
    return { ...state, permissionMode: parsed.mode };
  }
  if (parsed.type === "session" && parsed.action === "switch" && parsed.target) {
    return { ...state, resumeSessionPath: resolveSessionFilePath(process.cwd(), parsed.target) };
  }
  if (parsed.type === "session" && parsed.action === "fork" && state.resumeSessionPath) {
    const forked = Session.loadFromPath(state.resumeSessionPath).forkSession(parsed.target);
    return {
      ...state,
      resumeSessionPath: path.join(process.cwd(), ".clench", "sessions", `${forked.sessionId}.jsonl`)
    };
  }
  return state;
}
