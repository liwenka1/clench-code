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
  | { type: "version" }
  | { type: "init" }
  | { type: "doctor" }
  | { type: "sandbox" }
  | { type: "resume"; target?: string }
  | { type: "cost" }
  | { type: "compact" }
  | { type: "model"; model?: string }
  | { type: "permissions"; mode?: string }
  | { type: "config"; section?: string }
  | { type: "memory" }
  | { type: "session"; action?: "list" | "switch" | "fork" | "delete"; target?: string; force?: boolean }
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
  if (command === "version") return { type: "version" };
  if (command === "init") return { type: "init" };
  if (command === "doctor") return { type: "doctor" };
  if (command === "sandbox") return { type: "sandbox" };
  if (command === "resume") return { type: "resume", target: parts[1] };
  if (command === "cost") return { type: "cost" };
  if (command === "compact") return { type: "compact" };
  if (command === "model") return { type: "model", model: parts[1] };
  if (command === "permissions") return { type: "permissions", mode: parts[1] };
  if (command === "config") return { type: "config", section: parts[1] };
  if (command === "memory") return { type: "memory" };
  if (command === "session") return { type: "session", action: parts[1] as "list" | "switch" | "fork" | "delete" | undefined, target: parts[2], force: parts[3] === "--force" };
  if (command === "clear") return { type: "clear", confirm: parts[1] === "--confirm" };
  return { type: "unknown", name: command };
}

export function renderHelp(): string {
  return [
    "Available commands:",
    "  /help      Show command help",
    "  /status    Show current session status",
    "  /version   Show local CLI version",
    "  /init      Bootstrap local repo guidance files",
    "  /doctor    Show environment and auth diagnostics",
    "  /sandbox   Show resolved sandbox status",
    "  /resume    Resume a saved local session",
    "  /cost      Show cumulative token and cost usage",
    "  /compact   Compact local session history",
    "  /model     Show or switch the active model",
    "  /session   List, switch, fork, or delete saved sessions",
    "  /clear     Start a fresh local session"
  ].join("\n");
}
