import fs from "node:fs";
import path from "node:path";

import type { ProviderClientConnectOptions } from "../api/providers";
import { resolveModelAlias } from "../api/providers";
import { printCliUsage } from "./usage";

const KNOWN_SLASH_COMMANDS = ["/help", "/status", "/config", "/export", "/clear", "/permissions"];

const PERMISSION_SLASH_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

export interface SessionInfo {
  path: string;
  sessionId: string;
  messages: Array<{
    role: string;
    blocks?: Array<{ type: string; text?: string }>;
  }>;
}

/** Use with `ProviderClient.fromModel(model, promptCacheOptionsForSession(sessionInfo))` when wiring the API. */
export function promptCacheOptionsForSession(
  sessionInfo: SessionInfo | undefined
): ProviderClientConnectOptions {
  const sid = sessionInfo?.sessionId?.trim();
  if (!sid) {
    return {};
  }
  return { promptCacheSessionId: sid };
}

export function runCliMainWithArgv(argv: string[] = process.argv.slice(2)): void {
  try {
    if (argv.some((token) => token === "--help" || token === "-h")) {
      printCliUsage();
      return;
    }

    const cli = parseArgs(argv);
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
      if (command.name === "/help") {
        printHelp();
        continue;
      }
      if (command.name === "/permissions") {
        applyPermissionsSlash(cli, command.args);
        continue;
      }
      if (command.name === "/status") {
        printStatus(cli, sessionInfo);
        continue;
      }
      if (command.name === "/config") {
        printConfig(cli.cwd, command.args[0]);
        continue;
      }
      if (command.name === "/export") {
        if (!sessionInfo) {
          throw new Error("/export requires a resumed session");
        }
        const dest = command.args[0];
        if (!dest) {
          throw new Error("/export requires a destination path");
        }
        exportSession(sessionInfo, dest);
        continue;
      }
      if (command.name === "/clear") {
        if (!sessionInfo) {
          throw new Error("/clear requires a resumed session");
        }
        sessionInfo = clearSession(sessionInfo, command.args.includes("--confirm"));
        continue;
      }
      failUnknownSlashCommand(command.name);
    }
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export function runCliMain(): void {
  runCliMainWithArgv();
}

interface ParsedCli {
  cwd: string;
  model: string;
  permissionMode: string;
  outputFormat: string | undefined;
  allowedTools: string | undefined;
  resume: string | undefined;
  command: string | undefined;
  slashCommands: Array<{ name: string; args: string[] }>;
}

function parseArgs(argv: string[]): ParsedCli {
  const cli: ParsedCli = {
    cwd: process.cwd(),
    model: "claude-opus-4-6",
    permissionMode: "danger-full-access",
    outputFormat: undefined,
    allowedTools: undefined,
    resume: undefined,
    command: undefined,
    slashCommands: []
  };

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token?.startsWith("--model=")) {
      cli.model = resolveModelAlias(token.slice("--model=".length));
      index += 1;
      continue;
    }
    if (token === "--model") {
      cli.model = resolveModelAlias(argv[index + 1] ?? cli.model);
      index += 2;
      continue;
    }
    if (token?.startsWith("--permission-mode=")) {
      const value = token.slice("--permission-mode=".length);
      cli.permissionMode = value.trim() ? value : cli.permissionMode;
      index += 1;
      continue;
    }
    if (token === "--permission-mode") {
      cli.permissionMode = argv[index + 1] ?? cli.permissionMode;
      index += 2;
      continue;
    }
    if (token === "--output-format") {
      const value = argv[index + 1]?.trim();
      cli.outputFormat = value ? value : cli.outputFormat;
      index += 2;
      continue;
    }
    if (token?.startsWith("--output-format=")) {
      const value = token.slice("--output-format=".length).trim();
      cli.outputFormat = value ? value : cli.outputFormat;
      index += 1;
      continue;
    }
    if (token === "--allowed-tools") {
      const value = argv[index + 1]?.trim();
      cli.allowedTools = value ? value : cli.allowedTools;
      index += 2;
      continue;
    }
    if (token?.startsWith("--allowed-tools=")) {
      const value = token.slice("--allowed-tools=".length).trim();
      cli.allowedTools = value ? value : cli.allowedTools;
      index += 1;
      continue;
    }
    if (token?.startsWith("--resume=")) {
      const value = token.slice("--resume=".length).trim();
      cli.resume = value ? value : cli.resume;
      index += 1;
      continue;
    }
    if (token === "--resume") {
      cli.resume = argv[index + 1];
      index += 2;
      continue;
    }
    if (token?.startsWith("--session=")) {
      const value = token.slice("--session=".length).trim();
      cli.resume = value ? value : cli.resume;
      index += 1;
      continue;
    }
    if (token === "--session") {
      cli.resume = argv[index + 1];
      index += 2;
      continue;
    }
    if (token === "--persist") {
      index += 1;
      continue;
    }
    if (token === "status") {
      cli.command = "status";
      index += 1;
      continue;
    }
    if (isSlashCommandLike(token)) {
      const args: string[] = [];
      index += 1;
      while (index < argv.length && !isSlashCommandLike(argv[index])) {
        args.push(argv[index]!);
        index += 1;
      }
      cli.slashCommands.push({ name: token!, args });
      continue;
    }
    if (token?.startsWith("--")) {
      throw new Error(
        `unknown option: ${token}\nTry one of: --help, --model, --output-format, --permission-mode, --allowed-tools, --resume, --session, --persist`
      );
    }
    index += 1;
  }

  return cli;
}

/** Resolves `--resume latest` or a path to an on-disk session file (shared with prompt mode). */
export function resolveSessionFilePath(cwd: string, reference: string): string {
  if (reference === "latest") {
    const sessionsDir = path.join(cwd, ".clench", "sessions");
    const sessionPaths = fs.existsSync(sessionsDir)
      ? fs
          .readdirSync(sessionsDir)
          .filter((name) => name.endsWith(".jsonl") || name.endsWith(".json"))
          .map((name) => path.join(sessionsDir, name))
          .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
      : [];
    if (sessionPaths.length === 0) {
      throw new Error("no managed sessions found");
    }
    return sessionPaths[0]!;
  }

  return path.isAbsolute(reference) ? reference : path.join(cwd, reference);
}

function resolveSession(cwd: string, reference: string): SessionInfo {
  return loadSession(resolveSessionFilePath(cwd, reference));
}

function loadSession(filePath: string): SessionInfo {
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) {
    return { path: filePath, sessionId: path.basename(filePath), messages: [] };
  }

  try {
    const parsed = JSON.parse(content) as { messages?: SessionInfo["messages"]; sessionId?: string };
    if (Array.isArray(parsed.messages)) {
      return {
        path: filePath,
        sessionId: parsed.sessionId ?? path.basename(filePath),
        messages: parsed.messages
      };
    }
  } catch {
    // fall through
  }

  const lines = content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const meta = lines.find(
    (line) => line.type === "meta" || line.type === "session_meta"
  ) as { sessionId?: string; session_id?: string } | undefined;
  const messages = lines
    .filter((line) => line.type === "message")
    .map((line) => (line as { message: SessionInfo["messages"][number] }).message);
  return {
    path: filePath,
    sessionId: meta?.sessionId ?? meta?.session_id ?? path.basename(filePath),
    messages
  };
}

function saveSession(filePath: string, session: SessionInfo): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    JSON.stringify({ type: "meta", sessionId: session.sessionId }),
    ...session.messages.map((message) => JSON.stringify({ type: "message", message }))
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function printStatus(
  cli: ParsedCli,
  sessionInfo: SessionInfo | undefined
): void {
  process.stdout.write("Status\n");
  process.stdout.write(`  Model            ${cli.model}\n`);
  process.stdout.write(`  Permission mode  ${cli.permissionMode}\n`);
  if (cli.outputFormat) {
    process.stdout.write(`  Output format    ${cli.outputFormat}\n`);
  }
  if (cli.allowedTools) {
    process.stdout.write(`  Allowed tools    ${cli.allowedTools}\n`);
  }
  if (sessionInfo) {
    process.stdout.write(`  Messages         ${sessionInfo.messages.length}\n`);
    process.stdout.write(`  Session          ${sessionInfo.path}\n`);
  }
}

function applyPermissionsSlash(cli: ParsedCli, args: string[]): void {
  if (args.length === 0) {
    process.stdout.write(`Permission mode  ${cli.permissionMode}\n`);
    return;
  }
  const mode = args[0]!;
  if (!(PERMISSION_SLASH_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `Unsupported /permissions mode '${mode ?? ""}'. Use read-only, workspace-write, or danger-full-access.`
    );
  }
  if (args.length > 1) {
    throw new Error(
      "Unexpected arguments for /permissions.\n  Usage            /permissions [read-only|workspace-write|danger-full-access]"
    );
  }
  cli.permissionMode = mode;
}

function printHelp(): void {
  process.stdout.write("Interactive slash commands:\n");
  for (const command of KNOWN_SLASH_COMMANDS) {
    process.stdout.write(`  ${command}\n`);
  }
}

function isSlashCommandLike(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith("/") && !value.slice(1).includes("/");
}

function failUnknownSlashCommand(command: string): never {
  const suggestion = "/status";
  throw new Error(`unknown slash command outside the REPL: ${command}\nDid you mean ${suggestion}?`);
}

function loadConfigFiles(cwd: string): { loadedFiles: string[]; merged: Record<string, unknown> } {
  const loadedFiles: string[] = [];
  const merged: Record<string, unknown> = {};

  const configHome = process.env.CLENCH_CONFIG_HOME;
  const candidates = [
    configHome ? path.join(configHome, "settings.json") : undefined,
    path.join(cwd, ".clench.json"),
    path.join(cwd, ".clench", "settings.local.json")
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    loadedFiles.push(candidate);
    try {
      Object.assign(merged, JSON.parse(fs.readFileSync(candidate, "utf8")));
    } catch {
      // ignore malformed config in this minimal CLI
    }
  }

  return { loadedFiles, merged };
}

function printConfig(cwd: string, section: string | undefined): void {
  const { loadedFiles, merged } = loadConfigFiles(cwd);
  process.stdout.write("Config\n");
  process.stdout.write(`  Loaded files      ${loadedFiles.length}\n`);
  for (const file of loadedFiles) {
    process.stdout.write(`  ${file}\n`);
  }
  if (section) {
    process.stdout.write(`  Merged section: ${section}\n`);
    process.stdout.write(`  ${String(merged[section] ?? "<undefined>")}\n`);
  }
}

function exportSession(sessionInfo: SessionInfo, exportPath: string): void {
  const lines = ["# Conversation Export", ""];
  for (const message of sessionInfo.messages) {
    lines.push(`## ${message.role}`);
    for (const block of message.blocks ?? []) {
      if (block.type === "text" && "text" in block) {
        lines.push((block as { text: string }).text);
      }
    }
    lines.push("");
  }
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });
  fs.writeFileSync(exportPath, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write("Export\n");
  process.stdout.write(`  wrote transcript  ${exportPath}\n`);
}

function clearSession(sessionInfo: SessionInfo, confirmed: boolean): SessionInfo {
  if (!confirmed) {
    process.stdout.write("Refusing to clear without confirmation. Re-run as /clear --confirm\n");
    return sessionInfo;
  }

  const backupPath = `${sessionInfo.path}.bak`;
  fs.copyFileSync(sessionInfo.path, backupPath);
  const cleared: SessionInfo = { ...sessionInfo, messages: [] };
  saveSession(sessionInfo.path, cleared);

  process.stdout.write("Session cleared\n");
  process.stdout.write("  Mode             resumed session reset\n");
  process.stdout.write(`  Previous session ${sessionInfo.path}\n`);
  process.stdout.write(`  Resume previous  clench --resume ${backupPath}\n`);
  process.stdout.write(`  Backup           ${backupPath}\n`);
  process.stdout.write(`  Session file     ${sessionInfo.path}\n`);
  return cleared;
}
