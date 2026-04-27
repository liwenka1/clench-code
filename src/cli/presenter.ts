import fs from "node:fs";

import type {
  AssistantEvent,
  PermissionPrompter,
  PermissionRequest,
  TurnSummary
} from "../runtime";
import { finishSpinner, newSpinner, tickSpinner } from "./render";
import {
  renderAutoCompactionNotice,
  renderMcpTurnSummary,
  renderPermissionPanel,
  renderPromptCacheEvents,
  renderPromptSummary,
  renderUsageSummary,
  renderToolTimeline,
  renderToolResultPanel,
  renderToolStartPanel
} from "./views";
import type { Usage } from "../api";

export interface TerminalTurnPresenterOptions {
  write?: (chunk: string) => void;
  interactive?: boolean;
  model?: string;
}

export class TerminalTurnPresenter {
  private readonly spinner = newSpinner();
  private readonly write: (chunk: string) => void;
  private readonly interactive: boolean;
  private readonly model: string | undefined;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private spinnerLabel = "Thinking...";
  private streamedAssistantText = false;
  private printedToolPanels = false;
  private lineOpen = false;
  constructor(options: TerminalTurnPresenterOptions = {}) {
    this.write = options.write ?? ((chunk) => process.stdout.write(chunk));
    this.interactive = options.interactive ?? Boolean(process.stdout.isTTY);
    this.model = options.model;
  }

  beginTurn(label = "Thinking..."): void {
    this.spinnerLabel = label;
    if (!this.interactive) {
      this.write(`${tickSpinner(this.spinner, label)}\n`);
      return;
    }
    this.stopSpinner();
    this.spinnerTimer = setInterval(() => {
      this.write(`\r${tickSpinner(this.spinner, this.spinnerLabel)}`);
    }, 80);
  }

  onAssistantEvent(event: AssistantEvent): void {
    if (event.type === "text_delta") {
      this.stopSpinner();
      this.streamedAssistantText = true;
      this.write(event.text);
      this.lineOpen = !event.text.endsWith("\n");
      return;
    }
    if (event.type === "tool_use") {
      this.stopSpinner();
      this.ensureSeparated();
      this.write(`${renderToolStartPanel(event.name, event.input)}\n`);
      this.printedToolPanels = true;
      this.lineOpen = false;
      return;
    }
    if (event.type === "usage") {
      this.spinnerLabel = formatSpinnerLabel(event.usage);
      return;
    }
    if (event.type === "prompt_cache") {
      return;
    }
    if (event.type === "message_stop" && this.lineOpen) {
      this.write("\n");
      this.lineOpen = false;
    }
  }

  onToolResult(toolName: string, output: string, isError: boolean): void {
    this.stopSpinner();
    this.ensureSeparated();
    this.write(`${renderToolResultPanel(toolName, output, isError)}\n`);
    this.printedToolPanels = true;
    this.lineOpen = false;
  }

  finish(summary: TurnSummary): void {
    this.stopSpinner(summary.assistantMessages.length > 0 ? finishSpinner("Turn complete") : undefined);
    if (!this.streamedAssistantText && !this.printedToolPanels) {
      const rendered = renderPromptSummary(summary);
      if (rendered.trim()) {
        this.ensureSeparated();
        this.write(`${rendered}\n`);
      }
    } else if (summary.mcpTurnRuntime) {
      this.ensureSeparated();
      this.write(`${renderMcpTurnSummary(summary.mcpTurnRuntime)}\n`);
    }
    const toolTimeline = renderToolTimeline(summary.toolResults);
    if (toolTimeline) {
      this.ensureSeparated();
      this.write(`${toolTimeline}\n`);
    }
    const autoCompaction = renderAutoCompactionNotice(summary);
    if (autoCompaction) {
      this.ensureSeparated();
      this.write(`${autoCompaction}\n`);
    }
    const promptCache = renderPromptCacheEvents(summary);
    if (promptCache) {
      this.ensureSeparated();
      this.write(`${promptCache}\n`);
    }
    const usageSummary = renderUsageSummary(summary, this.model);
    if (usageSummary) {
      this.ensureSeparated();
      this.write(`${usageSummary}\n`);
    }
    this.lineOpen = false;
  }

  fail(error: unknown): void {
    this.stopSpinner(finishSpinner("Turn failed", "error"));
    if (this.lineOpen) {
      this.write("\n");
      this.lineOpen = false;
    }
  }

  private ensureSeparated(): void {
    if (this.lineOpen) {
      this.write("\n");
      this.lineOpen = false;
      return;
    }
    this.write("\n");
  }

  private stopSpinner(finalLine?: string): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
      this.write("\r\x1b[2K");
    }
    if (finalLine) {
      this.write(`${finalLine}\n`);
    }
  }
}

function formatSpinnerLabel(usage: Usage): string {
  return `Thinking... in ${usage.input_tokens} out ${usage.output_tokens}`;
}

export function createTerminalPermissionPrompter(options: {
  write?: (chunk: string) => void;
  suspendInput?: () => void;
  resumeInput?: () => void;
} = {}): PermissionPrompter {
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  return {
    decide(request: PermissionRequest) {
      options.suspendInput?.();
      try {
        write(`\n${renderPermissionPanel(request)}\n`);
        const response = readLineFromStdin().trim().toLowerCase();
        if (response === "y" || response === "yes") {
          return { type: "allow" };
        }
        return { type: "deny", reason: request.reason ?? `tool '${request.toolName}' denied by user` };
      } finally {
        options.resumeInput?.();
      }
    }
  };
}

function readLineFromStdin(): string {
  const buffer = Buffer.alloc(1);
  let out = "";
  while (true) {
    const read = fs.readSync(process.stdin.fd, buffer, 0, 1, null);
    if (read === 0) {
      break;
    }
    const char = buffer.toString("utf8", 0, read);
    if (char === "\r") {
      continue;
    }
    if (char === "\n") {
      break;
    }
    out += char;
  }
  return out;
}
