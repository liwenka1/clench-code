import * as readline from "node:readline";

import type { PermissionMode } from "../runtime";
import { printPromptSummary, runPromptMode } from "./prompt-run";

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
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => {
    process.stdout.write("> ");
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
      try {
        const summary = await runPromptMode({
          prompt: trimmed,
          model: options.model,
          permissionMode: options.permissionMode,
          outputFormat: options.outputFormat,
          allowedTools: options.allowedTools,
          resumeSessionPath: options.resumeSessionPath
        });
        printPromptSummary(summary, options.outputFormat);
      } catch (error) {
        process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      prompt();
    }
  } finally {
    rl.close();
  }
}
