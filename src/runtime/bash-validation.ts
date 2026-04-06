import type { PermissionMode } from "./permissions";

export type ValidationResult =
  | { type: "allow" }
  | { type: "block"; reason: string }
  | { type: "warn"; message: string };

export type CommandIntent =
  | "read-only"
  | "write"
  | "destructive"
  | "network"
  | "process-management"
  | "package-management"
  | "system-admin"
  | "unknown";

const WRITE_COMMANDS = [
  "cp",
  "mv",
  "rm",
  "mkdir",
  "rmdir",
  "touch",
  "chmod",
  "chown",
  "tee",
  "truncate"
];

const STATE_COMMANDS = [
  "npm",
  "yarn",
  "pnpm",
  "cargo",
  "docker",
  "systemctl",
  "kill",
  "pkill"
];

const READ_ONLY_COMMANDS = [
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "find",
  "pwd",
  "printf",
  "echo",
  "date",
  "sed",
  "git"
];

const NETWORK_COMMANDS = ["curl", "wget", "ssh", "scp", "rsync"];

export function validateReadOnly(command: string, mode: PermissionMode): ValidationResult {
  if (mode !== "read-only") {
    return { type: "allow" };
  }

  const first = extractFirstCommand(command);
  if (WRITE_COMMANDS.includes(first) || STATE_COMMANDS.includes(first)) {
    return {
      type: "block",
      reason: `Command is not allowed in read-only mode: ${command}`
    };
  }

  if (first === "git") {
    const parts = command.trim().split(/\s+/);
    const subcommand = parts.slice(1).find((part) => !part.startsWith("-"));
    if (subcommand && !["status", "log", "diff", "show", "branch", "remote", "fetch"].includes(subcommand)) {
      return {
        type: "block",
        reason: `Git subcommand '${subcommand}' modifies repository state and is not allowed in read-only mode`
      };
    }
  }

  if (command.includes(">")) {
    return {
      type: "block",
      reason: "Command contains write redirection which is not allowed in read-only mode"
    };
  }
  return { type: "allow" };
}

export function checkDestructive(command: string): ValidationResult {
  if (command.includes("rm -rf /")) {
    return { type: "warn", message: "Destructive command detected: root deletion" };
  }
  if (command.includes("rm -rf")) {
    return { type: "warn", message: "Recursive forced deletion detected" };
  }
  if (/\b(shred|wipefs)\b/.test(command)) {
    return { type: "warn", message: "Inherently destructive command detected" };
  }
  return { type: "allow" };
}

export function validateMode(command: string, mode: PermissionMode): ValidationResult {
  if (mode === "read-only") {
    return validateReadOnly(command, mode);
  }
  if (mode === "workspace-write") {
    if (/\/(etc|usr|var|dev|sys|proc)\//.test(command) && classifyCommand(command) !== "read-only") {
      return {
        type: "warn",
        message: "Command appears to target files outside the workspace"
      };
    }
  }
  return { type: "allow" };
}

export function validateSed(command: string, mode: PermissionMode): ValidationResult {
  if (extractFirstCommand(command) === "sed" && mode === "read-only" && /\s-i(\s|$)/.test(command)) {
    return {
      type: "block",
      reason: "sed -i (in-place editing) is not allowed in read-only mode"
    };
  }
  return { type: "allow" };
}

export function validatePaths(command: string): ValidationResult {
  if (command.includes("../")) {
    return {
      type: "warn",
      message: "Command contains directory traversal pattern '../'"
    };
  }
  if (command.includes("~/") || command.includes("$HOME")) {
    return {
      type: "warn",
      message: "Command references home directory"
    };
  }
  return { type: "allow" };
}

export function classifyCommand(command: string): CommandIntent {
  const first = extractFirstCommand(command);
  if (READ_ONLY_COMMANDS.includes(first)) {
    if (first === "sed" && /\s-i(\s|$)/.test(command)) {
      return "write";
    }
    if (first === "git") {
      return /\bgit\s+(status|log|diff|show|branch|remote|fetch)\b/.test(command)
        ? "read-only"
        : "write";
    }
    return "read-only";
  }
  if (first === "rm" || first === "shred" || first === "wipefs") {
    return "destructive";
  }
  if (WRITE_COMMANDS.includes(first)) {
    return "write";
  }
  if (NETWORK_COMMANDS.includes(first)) {
    return "network";
  }
  if (["kill", "pkill"].includes(first)) {
    return "process-management";
  }
  if (["npm", "yarn", "pnpm", "cargo"].includes(first)) {
    return "package-management";
  }
  if (["sudo", "systemctl", "service"].includes(first)) {
    return "system-admin";
  }
  return "unknown";
}

export function validateCommand(command: string, mode: PermissionMode): ValidationResult {
  const modeResult = validateMode(command, mode);
  if (modeResult.type !== "allow") {
    return modeResult;
  }

  const sedResult = validateSed(command, mode);
  if (sedResult.type !== "allow") {
    return sedResult;
  }

  const destructive = checkDestructive(command);
  if (destructive.type !== "allow") {
    return destructive;
  }

  return validatePaths(command);
}

function extractFirstCommand(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}
