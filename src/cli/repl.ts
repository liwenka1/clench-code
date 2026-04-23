import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";

import { parseSlashCommand, type SlashCommand } from "../commands/index.js";
import { normalizeModelSelection } from "../api/providers";
import { loadRuntimeConfig, Session, type PermissionMode } from "../runtime";
import { loadReplHistory, saveReplHistory } from "./history";
import { completeInteractiveSlashCommand } from "./input";
import {
  beginMultiline,
  consumeMultilineLine,
  MULTILINE_CANCEL_COMMAND,
  MULTILINE_START_COMMAND,
  MULTILINE_SUBMIT_COMMAND,
  type MultilineComposeState,
  shouldEnterMultiline
} from "./multiline";
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
  compact?: boolean;
}

/**
 * Minimal stdin/stdout REPL: one line → one `runPromptMode` turn (same stack as one-shot prompt).
 */
export async function runReplLoop(options: RunReplLoopOptions): Promise<void> {
  let currentModel = options.model;
  let currentPermissionMode = options.permissionMode;
  let currentSessionPath = options.resumeSessionPath;
  let multilineState: MultilineComposeState | undefined;
  const cwd = process.cwd();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 500,
    completer: (line: string) => {
      const { start, matches } = completeInteractiveSlashCommand(
        line,
        line.length,
        completionContextForCwd(cwd, currentSessionPath, currentModel)
      );
      return [matches, line.slice(start)];
    }
  });
  const historyCapable = rl as readline.Interface & { history: string[] };
  const buffered = rl as readline.Interface & { line?: string; cursor?: number };
  historyCapable.history = loadReplHistory(cwd).reverse();
  const permissionPrompter = createTerminalPermissionPrompter({
    suspendInput: () => rl.pause(),
    resumeInput: () => rl.resume()
  });
  process.stdout.write(
    `${renderReplBanner({
      model: currentModel,
      permissionMode: currentPermissionMode,
      sessionLabel: currentSessionPath ? path.basename(currentSessionPath) : "ephemeral",
      cwd: process.cwd()
    })}\n\n`
  );
  const prompt = () => {
    rl.setPrompt(multilineState ? "... " : `clench(${currentPermissionMode})> `);
    rl.prompt();
  };

  rl.on("SIGINT", () => {
    if (multilineState) {
      multilineState = undefined;
      process.stdout.write("\nmultiline input cancelled\n");
      prompt();
      return;
    }
    if ((buffered.line ?? "").trim().length > 0) {
      process.stdout.write("\ninput cancelled\n");
      clearReadlineBuffer(rl, buffered);
      return;
    }
    process.stdout.write("\n");
    rl.close();
  });

  prompt();

  try {
    for await (const line of rl) {
      if (multilineState) {
        const step = consumeMultilineLine(multilineState, line);
        multilineState = step.state;
        if (step.cancelled) {
          process.stdout.write("multiline input cancelled\n");
          prompt();
          continue;
        }
        if (!step.submittedText?.trim()) {
          prompt();
          continue;
        }
        const presenter = options.outputFormat === "text" && !options.compact
          ? new TerminalTurnPresenter({ interactive: true, model: currentModel })
          : undefined;
        try {
          presenter?.beginTurn();
          const summary = await runPromptMode({
            prompt: step.submittedText,
            model: currentModel,
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
            printPromptSummary(summary, options.outputFormat, { compact: options.compact, model: currentModel });
          }
        } catch (error) {
          presenter?.fail(error);
          process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        prompt();
        continue;
      }
      const trimmed = line.trim();
      if (trimmed === "exit" || trimmed === "quit") {
        break;
      }
      if (!trimmed) {
        prompt();
        continue;
      }
      if (shouldEnterMultiline(line)) {
        multilineState = beginMultiline(line);
        process.stdout.write(
          `multiline input started (${MULTILINE_SUBMIT_COMMAND} to send, ${MULTILINE_CANCEL_COMMAND} to discard)\n`
        );
        prompt();
        continue;
      }
      if (isSlashCommandToken(trimmed)) {
        try {
          const next = await handleInteractiveSlash(trimmed, {
            model: currentModel,
            permissionMode: currentPermissionMode,
            resumeSessionPath: currentSessionPath
          });
          currentModel = next.model;
          currentPermissionMode = next.permissionMode;
          currentSessionPath = next.resumeSessionPath;
        } catch (error) {
          process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        prompt();
        continue;
      }
      const presenter = options.outputFormat === "text" && !options.compact
        ? new TerminalTurnPresenter({ interactive: true, model: currentModel })
        : undefined;
      try {
        presenter?.beginTurn();
        const summary = await runPromptMode({
          prompt: trimmed,
          model: currentModel,
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
          printPromptSummary(summary, options.outputFormat, { compact: options.compact, model: currentModel });
        }
      } catch (error) {
        presenter?.fail(error);
        process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      prompt();
    }
  } finally {
    saveReplHistory(cwd, historyCapable.history.slice().reverse());
    rl.close();
  }
}

const SLASH_COMPLETIONS = [
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
  "/plugin",
  "/plugins",
  "/marketplace",
  MULTILINE_START_COMMAND,
  MULTILINE_SUBMIT_COMMAND,
  MULTILINE_CANCEL_COMMAND
];

function isSlashCommandToken(value: string): boolean {
  return value.startsWith("/") && value.length > 1 && !value.slice(1).includes("/");
}

async function handleInteractiveSlash(
  line: string,
  state: { model: string; permissionMode: PermissionMode; resumeSessionPath?: string }
): Promise<{ model: string; permissionMode: PermissionMode; resumeSessionPath?: string }> {
  const parsed = parseSlashCommand(line);
  const argv = [
    "--model",
    state.model,
    "--permission-mode",
    state.permissionMode,
    ...(state.resumeSessionPath ? ["--resume", state.resumeSessionPath] : []),
    ...line.trim().split(/\s+/)
  ];
  await runCliMainWithArgv(argv);

  if (!parsed) {
    return state;
  }
  if (parsed.type === "model" && parsed.model) {
    return { ...state, model: normalizeModelSelection(parsed.model) };
  }
  if (parsed.type === "resume" && parsed.target) {
    return { ...state, resumeSessionPath: resolveSessionFilePath(process.cwd(), parsed.target) };
  }
  if (parsed.type === "permissions" && parsed.mode) {
    return { ...state, permissionMode: parsed.mode };
  }
  if (parsed.type === "session" && parsed.action === "switch" && parsed.target) {
    return { ...state, resumeSessionPath: resolveSessionFilePath(process.cwd(), parsed.target) };
  }
  if (parsed.type === "session" && parsed.action === "delete" && parsed.target && parsed.force && state.resumeSessionPath) {
    const deletePath = resolveSessionFilePath(process.cwd(), parsed.target);
    if (path.resolve(deletePath) === path.resolve(state.resumeSessionPath)) {
      return { ...state, resumeSessionPath: undefined };
    }
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

function completionContextForCwd(cwd: string, currentSessionPath?: string, currentModel?: string) {
  const sessionsDir = path.join(cwd, ".clench", "sessions");
  const sessionTargets = sessionsDirExists(sessionsDir)
    ? listSortedSessionTargets(sessionsDir)
    : [];
  const { merged } = loadRuntimeConfig(cwd);
  const activeSessionTarget = currentSessionPath ? toRelativeSessionTarget(cwd, currentSessionPath) : undefined;
  return {
    slashCommands: SLASH_COMPLETIONS,
    currentModel,
    sessionTargets,
    activeSessionTarget,
    mcpServers: Object.keys(merged.mcp ?? {}),
    pluginNames: Object.keys(merged.plugins ?? {}),
    cwd
  };
}

function sessionsDirExists(dir: string): boolean {
  try {
    return fs.existsSync(dir);
  } catch {
    return false;
  }
}

function listSortedSessionTargets(sessionsDir: string): string[] {
  return fs
    .readdirSync(sessionsDir)
    .filter((name: string) => name.endsWith(".jsonl") || name.endsWith(".json"))
    .sort()
    .map((name: string) => path.join(".clench", "sessions", name));
}

function toRelativeSessionTarget(cwd: string, sessionPath: string): string {
  const relative = path.relative(cwd, sessionPath);
  return relative && !relative.startsWith("..") ? relative : sessionPath;
}

function clearReadlineBuffer(
  rl: readline.Interface,
  buffered: readline.Interface & { line?: string; cursor?: number }
): void {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  buffered.line = "";
  buffered.cursor = 0;
  rl.prompt();
}
