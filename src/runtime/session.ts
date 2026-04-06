import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Usage } from "../api";

/** Matches `upstream` `runtime::session::SESSION_VERSION`. */
export const SESSION_VERSION = 1;

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: string }
  | { type: "tool_result"; tool_use_id: string; tool_name: string; output: string; is_error: boolean };

export interface ForkMetadata {
  parentSessionId: string;
  branchName?: string;
}

export interface CompactionMetadata {
  summary: string;
  removedMessageCount: number;
  /** Present when loaded from upstream-style `compaction` JSONL line or after compaction. */
  count?: number;
}

export interface ConversationMessage {
  role: MessageRole;
  blocks: ContentBlock[];
  usage?: Usage;
}

interface SessionMetaLine {
  type: "meta" | "session_meta";
  sessionId?: string;
  session_id?: string;
  version?: number;
  created_at_ms?: number;
  updated_at_ms?: number;
  compaction?: CompactionMetadata;
  fork?: unknown;
}

interface SessionMessageLine {
  type: "message";
  message: ConversationMessage;
}

interface LegacySessionFile {
  sessionId: string;
  messages: ConversationMessage[];
  compaction?: CompactionMetadata;
  fork?: ForkMetadata;
}

export class Session {
  constructor(
    readonly sessionId: string = randomUUID(),
    readonly messages: ConversationMessage[] = [],
    readonly persistencePath?: string,
    readonly compaction?: CompactionMetadata,
    readonly fork?: ForkMetadata,
    readonly maxPersistenceBytes = 4 * 1024 * 1024,
    readonly version: number = SESSION_VERSION,
    readonly createdAtMs: number = Date.now(),
    readonly updatedAtMs: number = Date.now()
  ) {}

  static new(): Session {
    return new Session();
  }

  /**
   * Opens a JSONL session file, or returns an empty session bound to `filePath` if the file does not exist yet.
   * Existing empty files behave like `loadFromPath`.
   */
  static openAtPath(filePath: string): Session {
    if (!fs.existsSync(filePath)) {
      return new Session(undefined, [], filePath);
    }
    return Session.loadFromPath(filePath);
  }

  static loadFromPath(filePath: string): Session {
    const text = fs.readFileSync(filePath, "utf8");
    const trimmed = text.trim();

    if (!trimmed) {
      return new Session(undefined, [], filePath);
    }

    try {
      const parsed = JSON.parse(trimmed) as LegacySessionFile;
      if (Array.isArray(parsed.messages)) {
        return new Session(
          parsed.sessionId,
          parsed.messages,
          filePath,
          parsed.compaction,
          parsed.fork
        );
      }
    } catch {
      // Fall back to JSONL parsing below.
    }

    const rawLines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const now = Date.now();
    let version = SESSION_VERSION;
    let createdAtMs = now;
    let updatedAtMs = now;
    let sessionId: string | undefined;
    let compaction: CompactionMetadata | undefined;
    let fork: ForkMetadata | undefined;
    const messages: ConversationMessage[] = [];

    for (const rawLine of rawLines) {
      let record: unknown;
      try {
        record = JSON.parse(rawLine) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!record || typeof record !== "object" || !("type" in record)) {
        continue;
      }
      const t = (record as { type: string }).type;

      if (t === "session_meta") {
        const m = record as SessionMetaLine;
        sessionId = m.session_id ?? m.sessionId ?? sessionId;
        if (typeof m.version === "number") {
          version = m.version;
        }
        if (typeof m.created_at_ms === "number") {
          createdAtMs = m.created_at_ms;
        }
        if (typeof m.updated_at_ms === "number") {
          updatedAtMs = m.updated_at_ms;
        }
        const parsedFork = normalizeForkMetadata(m.fork);
        if (parsedFork) {
          fork = parsedFork;
        }
      } else if (t === "compaction") {
        const c = record as Record<string, unknown>;
        compaction = {
          summary: typeof c.summary === "string" ? c.summary : "",
          removedMessageCount:
            typeof c.removed_message_count === "number" ? c.removed_message_count : 0,
          ...(typeof c.count === "number" ? { count: c.count } : {})
        };
      } else if (t === "message" && "message" in record) {
        messages.push((record as SessionMessageLine).message);
      } else if (t === "meta") {
        const m = record as SessionMetaLine;
        sessionId = m.sessionId ?? m.session_id ?? sessionId;
        if (m.compaction) {
          compaction = m.compaction;
        }
        const parsedFork = normalizeForkMetadata(m.fork);
        if (parsedFork) {
          fork = parsedFork;
        }
      }
    }

    return new Session(
      sessionId,
      messages,
      filePath,
      compaction,
      fork,
      4 * 1024 * 1024,
      version,
      createdAtMs,
      updatedAtMs
    );
  }

  withPersistencePath(filePath: string): Session {
    return new Session(
      this.sessionId,
      this.messages,
      filePath,
      this.compaction,
      this.fork,
      this.maxPersistenceBytes,
      this.version,
      this.createdAtMs,
      this.updatedAtMs
    );
  }

  withCompaction(compaction: CompactionMetadata): Session {
    return new Session(
      this.sessionId,
      this.messages,
      this.persistencePath,
      compaction,
      this.fork,
      this.maxPersistenceBytes,
      this.version,
      this.createdAtMs,
      Date.now()
    );
  }

  withRotationLimit(maxPersistenceBytes: number): Session {
    return new Session(
      this.sessionId,
      this.messages,
      this.persistencePath,
      this.compaction,
      this.fork,
      maxPersistenceBytes,
      this.version,
      this.createdAtMs,
      this.updatedAtMs
    );
  }

  pushUserText(text: string): Session {
    return this.pushMessage(userTextMessage(text));
  }

  pushMessage(message: ConversationMessage): Session {
    const next = new Session(
      this.sessionId,
      [...this.messages, message],
      this.persistencePath,
      this.compaction,
      this.fork,
      this.maxPersistenceBytes,
      this.version,
      this.createdAtMs,
      Date.now()
    );
    next.persistIfNeeded();
    return next;
  }

  forkSession(branchName?: string): Session {
    const now = Date.now();
    return new Session(
      randomUUID(),
      [...this.messages],
      this.persistencePath,
      this.compaction,
      {
        parentSessionId: this.sessionId,
        branchName
      },
      this.maxPersistenceBytes,
      this.version,
      now,
      now
    );
  }

  persistIfNeeded(): void {
    if (!this.persistencePath) {
      return;
    }

    const filePath = this.persistencePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (tryAppendPersistedMessage(this, filePath)) {
      rotateIfNeeded(filePath, this.maxPersistenceBytes, readSize(filePath));
      return;
    }

    const content = sessionToJsonl(this);
    fs.writeFileSync(filePath, content, "utf8");
    rotateIfNeeded(filePath, this.maxPersistenceBytes, Buffer.byteLength(content));
  }
}

export function userTextMessage(text: string): ConversationMessage {
  return {
    role: "user",
    blocks: [{ type: "text", text }]
  };
}

export function assistantMessage(blocks: ContentBlock[], usage?: Usage): ConversationMessage {
  return {
    role: "assistant",
    blocks,
    usage
  };
}

export function toolResultMessage(
  toolUseId: string,
  toolName: string,
  output: string,
  isError: boolean
): ConversationMessage {
  return {
    role: "tool",
    blocks: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        tool_name: toolName,
        output,
        is_error: isError
      }
    ]
  };
}

/**
 * When the on-disk JSONL matches this session except for one new trailing message,
 * append only that message line (Rust `append_persisted_message`).
 */
function tryAppendPersistedMessage(session: Session, filePath: string): boolean {
  if (session.messages.length === 0) {
    return false;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    return false;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  if (isLegacyMonolithicJsonSessionRaw(raw)) {
    return false;
  }

  let loaded: Session;
  try {
    loaded = Session.loadFromPath(filePath);
  } catch {
    return false;
  }

  if (loaded.messages.length + 1 !== session.messages.length) {
    return false;
  }
  if (loaded.sessionId !== session.sessionId) {
    return false;
  }
  if (loaded.version !== session.version) {
    return false;
  }
  if (loaded.createdAtMs !== session.createdAtMs) {
    return false;
  }
  if (!compactionEqual(loaded.compaction, session.compaction)) {
    return false;
  }
  if (!forkEqual(loaded.fork, session.fork)) {
    return false;
  }
  if (!messagesEqual(loaded.messages, session.messages.slice(0, -1))) {
    return false;
  }

  const last = session.messages[session.messages.length - 1]!;
  const line = `${JSON.stringify({ type: "message", message: last })}\n`;
  fs.appendFileSync(filePath, line, "utf8");
  return true;
}

/**
 * Legacy `{ sessionId, messages }` object (pretty-printed or one line). Whole-file
 * `JSON.parse` succeeds; JSONL multi-object files fail parse and are not legacy.
 */
function isLegacyMonolithicJsonSessionRaw(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const t = parsed.type;
    if (t === "session_meta" || t === "meta" || t === "message" || t === "compaction") {
      return false;
    }
    return Array.isArray(parsed.messages);
  } catch {
    return false;
  }
}

function compactionEqual(a?: CompactionMetadata, b?: CompactionMetadata): boolean {
  if (a === undefined && b === undefined) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  const ca = a.count ?? 1;
  const cb = b.count ?? 1;
  return (
    a.summary === b.summary && a.removedMessageCount === b.removedMessageCount && ca === cb
  );
}

function forkEqual(a?: ForkMetadata, b?: ForkMetadata): boolean {
  if (a === undefined && b === undefined) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.parentSessionId === b.parentSessionId && a.branchName === b.branchName;
}

function messagesEqual(a: ConversationMessage[], b: ConversationMessage[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function sessionToJsonl(session: Session): string {
  const meta: Record<string, unknown> = {
    type: "session_meta",
    version: session.version,
    session_id: session.sessionId,
    created_at_ms: session.createdAtMs,
    updated_at_ms: session.updatedAtMs
  };
  if (session.fork) {
    meta.fork = forkToRustJson(session.fork);
  }

  const lines: string[] = [JSON.stringify(meta)];

  if (session.compaction) {
    const c = session.compaction;
    lines.push(
      JSON.stringify({
        type: "compaction",
        count: c.count ?? 1,
        removed_message_count: c.removedMessageCount,
        summary: c.summary
      })
    );
  }

  for (const message of session.messages) {
    lines.push(JSON.stringify({ type: "message", message }));
  }

  return `${lines.join("\n")}\n`;
}

function forkToRustJson(fork: ForkMetadata): Record<string, unknown> {
  const o: Record<string, unknown> = {
    parent_session_id: fork.parentSessionId
  };
  if (fork.branchName !== undefined) {
    o.branch_name = fork.branchName;
  }
  return o;
}

export function rotateIfNeeded(filePath: string, maxBytes: number, currentSize?: number): void {
  const sizeToCheck = currentSize ?? readSize(filePath);
  if (sizeToCheck < maxBytes) {
    cleanupRotatedFiles(filePath);
    return;
  }

  const rotated = `${filePath}.1`;
  try {
    fs.copyFileSync(filePath, rotated);
  } catch {
    // Ignore rotation failures in tests.
  }
  cleanupRotatedFiles(filePath);
}

export function cleanupRotatedFiles(filePath: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(`${base}.`) && name !== `${base}.1`) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}

function readSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function normalizeForkMetadata(value: unknown): ForkMetadata | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const o = value as Record<string, unknown>;
  const parent =
    (typeof o.parent_session_id === "string" && o.parent_session_id) ||
    (typeof o.parentSessionId === "string" && o.parentSessionId);
  if (!parent) {
    return undefined;
  }
  const branch =
    (typeof o.branch_name === "string" && o.branch_name) ||
    (typeof o.branchName === "string" && o.branchName);
  return {
    parentSessionId: parent,
    branchName: branch || undefined
  };
}
