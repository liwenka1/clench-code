import fs from "node:fs";
import path from "node:path";

import type { ProviderClientConnectOptions } from "../api/providers";
import type { SlashCommand } from "../commands/index.js";
import { compactSession, Session, sessionToJsonl } from "../runtime/index.js";
import {
  renderClearSessionView,
  renderCompactView,
  renderExportView,
  renderResumeUsageView,
  renderSessionChangeView,
  renderSessionsView
} from "./views";

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

export function resolveSession(cwd: string, reference: string): SessionInfo {
  return loadSession(resolveSessionFilePath(cwd, reference));
}

export function compactExistingSession(sessionInfo: SessionInfo): SessionInfo {
  const loaded = Session.loadFromPath(sessionInfo.path);
  const result = compactSession(loaded, { preserveRecentMessages: 2 });
  if (result.removedMessageCount === 0) {
    process.stdout.write(renderCompactView(0));
    return sessionInfo;
  }
  fs.writeFileSync(sessionInfo.path, sessionToJsonl(result.compactedSession), "utf8");
  process.stdout.write(renderCompactView(result.removedMessageCount, result.formattedSummary.split("\n")[0] ?? ""));
  return loadSession(sessionInfo.path);
}

export function handleSessionSlash(
  cwd: string,
  sessionInfo: SessionInfo | undefined,
  command: Extract<SlashCommand, { type: "session" }>
): SessionInfo | undefined {
  if (!command.action || command.action === "list") {
    const sessionsDir = path.join(cwd, ".clench", "sessions");
    const sessionPaths = fs.existsSync(sessionsDir)
      ? fs
          .readdirSync(sessionsDir)
          .filter((name) => name.endsWith(".jsonl") || name.endsWith(".json"))
          .map((name) => path.join(sessionsDir, name))
          .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
      : [];
    process.stdout.write(renderSessionsView(sessionPaths));
    return sessionInfo;
  }

  if (command.action === "switch") {
    if (!command.target) {
      throw new Error("/session switch requires a target");
    }
    const next = resolveSession(cwd, command.target);
    process.stdout.write(renderSessionChangeView({ action: "switched", path: next.path, messages: next.messages.length }));
    return next;
  }

  if (command.action === "delete") {
    if (!command.target) {
      throw new Error("/session delete requires a target");
    }
    const deletePath = resolveSessionFilePath(cwd, command.target);
    const deletingActiveSession = sessionInfo
      ? path.resolve(sessionInfo.path) === path.resolve(deletePath)
      : false;
    if (deletingActiveSession && !command.force) {
      throw new Error("Refusing to delete the active session without --force.");
    }
    if (!fs.existsSync(deletePath)) {
      throw new Error("/session delete requires an existing session");
    }
    fs.rmSync(deletePath, { force: true });
    process.stdout.write(renderSessionChangeView({ action: "deleted", path: deletePath }));
    return deletingActiveSession ? undefined : sessionInfo;
  }

  if (!sessionInfo) {
    throw new Error("/session fork requires a resumed session");
  }
  const source = Session.loadFromPath(sessionInfo.path);
  const forked = source.forkSession(command.target);
  const forkPath = path.join(cwd, ".clench", "sessions", `${forked.sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(forkPath), { recursive: true });
  fs.writeFileSync(forkPath, sessionToJsonl(forked.withPersistencePath(forkPath)), "utf8");
  process.stdout.write(
    renderSessionChangeView({ action: "forked", path: forkPath, branch: command.target ?? "<default>" })
  );
  return loadSession(forkPath);
}

export function handleResumeSlash(cwd: string, target: string | undefined): SessionInfo | undefined {
  if (!target) {
    process.stdout.write(renderResumeUsageView());
    return undefined;
  }
  const next = resolveSession(cwd, target);
  process.stdout.write(renderSessionChangeView({ action: "resumed", path: next.path, messages: next.messages.length }));
  return next;
}

export function exportSession(sessionInfo: SessionInfo, exportPath: string): void {
  const lines = ["# Conversation Export", ""];
  for (const message of sessionInfo.messages) {
    lines.push(`## ${message.role}`);
    for (const block of message.blocks ?? []) {
      lines.push(...renderExportBlock(block));
    }
    lines.push("");
  }
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });
  fs.writeFileSync(exportPath, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(renderExportView(exportPath));
}

export function clearSession(sessionInfo: SessionInfo, confirmed: boolean): SessionInfo {
  if (!confirmed) {
    process.stdout.write("Refusing to clear without confirmation. Re-run as /clear --confirm\n");
    return sessionInfo;
  }

  const backupPath = `${sessionInfo.path}.bak`;
  fs.copyFileSync(sessionInfo.path, backupPath);
  const cleared: SessionInfo = { ...sessionInfo, messages: [] };
  saveSession(sessionInfo.path, cleared);

  process.stdout.write(
    renderClearSessionView({
      mode: "resumed session reset",
      previousSession: sessionInfo.path,
      resumePrevious: `clench --resume ${backupPath}`,
      backupPath,
      sessionFile: sessionInfo.path
    })
  );
  return cleared;
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

function renderExportBlock(block: Record<string, unknown> & { type: string }): string[] {
  if (block.type === "text") {
    return [String(block.text ?? "")];
  }
  if (block.type === "tool_use") {
    return [
      `### tool_use ${String(block.name ?? "")} (${String(block.id ?? "")})`,
      "```json",
      safePrettyJson(String(block.input ?? "")),
      "```"
    ];
  }
  return [
    `### tool_result ${String(block.tool_name ?? "")} (${String(block.tool_use_id ?? "")}) error=${block.is_error ? "true" : "false"}`,
    "```text",
    String(block.output ?? ""),
    "```"
  ];
}

function safePrettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
