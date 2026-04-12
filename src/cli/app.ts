import type { CliOutputFormat, CliPermissionMode } from "./args";

export interface SessionConfig {
  model: string;
  permissionMode: CliPermissionMode;
  config?: string;
  outputFormat: CliOutputFormat;
}

export interface SessionState {
  turns: number;
  compactedMessages: number;
  lastModel: string;
}

export type SlashCommand =
  | { type: "help" }
  | { type: "status" }
  | { type: "cost" }
  | { type: "compact" }
  | { type: "model"; model?: string }
  | { type: "permissions"; mode?: string }
  | { type: "config"; section?: string }
  | { type: "memory" }
  | { type: "clear"; confirm: boolean }
  | { type: "unknown"; name: string };

export function newSessionState(model: string): SessionState {
  return {
    turns: 0,
    compactedMessages: 0,
    lastModel: model
  };
}

export function parseSlashCommand(input: string): SlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0] ?? "";

  if (command === "help") return { type: "help" };
  if (command === "status") return { type: "status" };
  if (command === "cost") return { type: "cost" };
  if (command === "compact") return { type: "compact" };
  if (command === "model") return { type: "model", model: parts[1] };
  if (command === "permissions") return { type: "permissions", mode: parts[1] };
  if (command === "config") return { type: "config", section: parts[1] };
  if (command === "memory") return { type: "memory" };
  if (command === "clear") return { type: "clear", confirm: parts[1] === "--confirm" };
  return { type: "unknown", name: command };
}

export function renderHelp(): string {
  return [
    "Available commands:",
    "  /help      Show command help",
    "  /status    Show current session status",
    "  /cost      Show cumulative token and cost usage",
    "  /compact   Compact local session history",
    "  /model     Show or switch the active model",
    "  /clear     Start a fresh local session"
  ].join("\n");
}
