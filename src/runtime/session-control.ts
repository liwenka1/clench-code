import fs from "node:fs";
import path from "node:path";

import { Session, type ForkMetadata } from "./session";

export const PRIMARY_SESSION_EXTENSION = "jsonl";
export const LEGACY_SESSION_EXTENSION = "json";
export const LATEST_SESSION_REFERENCE = "latest";

const SESSION_REFERENCE_ALIASES = new Set(["latest", "last", "recent"]);

export interface SessionHandle {
  id: string;
  path: string;
}

export interface ManagedSessionSummary {
  id: string;
  path: string;
  modifiedEpochMillis: number;
  messageCount: number;
  parentSessionId?: string;
  branchName?: string;
}

export interface LoadedManagedSession {
  handle: SessionHandle;
  session: Session;
}

export interface ForkedManagedSession {
  parentSessionId: string;
  handle: SessionHandle;
  session: Session;
  branchName?: string;
}

export function managedSessionsDirFor(baseDir: string): string {
  const dir = path.join(baseDir, ".clench", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function createManagedSessionHandleFor(baseDir: string, sessionId: string): SessionHandle {
  return {
    id: sessionId,
    path: path.join(managedSessionsDirFor(baseDir), `${sessionId}.${PRIMARY_SESSION_EXTENSION}`)
  };
}

export function listManagedSessionsFor(baseDir: string): ManagedSessionSummary[] {
  const dir = managedSessionsDirFor(baseDir);
  return fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((filePath) => isManagedSessionFile(filePath))
    .map((filePath) => {
      const stats = fs.statSync(filePath);
      const loaded = tryLoadSession(filePath);
      const fork = loaded?.fork;
      return {
        id: loaded?.sessionId ?? path.basename(filePath).replace(/\.(jsonl|json)$/, ""),
        path: filePath,
        modifiedEpochMillis: stats.mtimeMs,
        messageCount: loaded?.messages.length ?? 0,
        parentSessionId: fork?.parentSessionId,
        branchName: fork?.branchName
      };
    })
    .sort((left, right) => right.modifiedEpochMillis - left.modifiedEpochMillis || right.id.localeCompare(left.id));
}

export function loadManagedSessionFor(baseDir: string, reference: string): LoadedManagedSession {
  const handle = resolveSessionReferenceFor(baseDir, reference);
  const session = Session.loadFromPath(handle.path);
  return {
    handle: {
      id: session.sessionId,
      path: handle.path
    },
    session
  };
}

export function resolveSessionReferenceFor(baseDir: string, reference: string): SessionHandle {
  if (isSessionReferenceAlias(reference)) {
    const latest = listManagedSessionsFor(baseDir)[0];
    if (!latest) {
      throw new Error("no managed sessions found");
    }
    return { id: latest.id, path: latest.path };
  }

  const asPath = path.isAbsolute(reference) ? reference : path.join(baseDir, reference);
  if (fs.existsSync(asPath)) {
    return {
      id: path.basename(asPath).replace(/\.(jsonl|json)$/, ""),
      path: asPath
    };
  }

  const dir = managedSessionsDirFor(baseDir);
  for (const extension of [PRIMARY_SESSION_EXTENSION, LEGACY_SESSION_EXTENSION]) {
    const candidate = path.join(dir, `${reference}.${extension}`);
    if (fs.existsSync(candidate)) {
      return { id: reference, path: candidate };
    }
  }

  throw new Error(`session not found: ${reference}`);
}

export function forkManagedSessionFor(
  baseDir: string,
  session: Session,
  branchName?: string
): ForkedManagedSession {
  const forked = session.forkSession(branchName);
  const handle = createManagedSessionHandleFor(baseDir, forked.sessionId);
  const persisted = forked.withPersistencePath(handle.path);
  persisted.persistIfNeeded();
  return {
    parentSessionId: session.sessionId,
    handle,
    session: persisted,
    branchName
  };
}

export function clearSession(session: Session): Session {
  return new Session(
    session.sessionId,
    [],
    session.persistencePath,
    session.compaction,
    session.fork,
    session.maxPersistenceBytes,
    session.version,
    session.createdAtMs,
    Date.now()
  );
}

export function exportSession(session: Session): string {
  return JSON.stringify(
    {
      sessionId: session.sessionId,
      messages: session.messages,
      compaction: session.compaction,
      fork: session.fork
    },
    null,
    2
  );
}

export function isSessionReferenceAlias(reference: string): boolean {
  return SESSION_REFERENCE_ALIASES.has(reference.toLowerCase());
}

function isManagedSessionFile(filePath: string): boolean {
  return filePath.endsWith(`.${PRIMARY_SESSION_EXTENSION}`) || filePath.endsWith(`.${LEGACY_SESSION_EXTENSION}`);
}

function tryLoadSession(filePath: string): Session | undefined {
  try {
    return Session.loadFromPath(filePath);
  } catch {
    return undefined;
  }
}
