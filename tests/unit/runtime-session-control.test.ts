import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  LATEST_SESSION_REFERENCE,
  Session,
  clearSession,
  createManagedSessionHandleFor,
  exportSession,
  forkManagedSessionFor,
  isSessionReferenceAlias,
  listManagedSessionsFor,
  loadManagedSessionFor,
  resolveSessionReferenceFor
} from "../../src/runtime";

describe("runtime session control", () => {
  test("ports session control command behavior", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-session-control-"));
    const session = Session.new().pushUserText("hello");
    const handle = createManagedSessionHandleFor(root, session.sessionId);
    const persisted = session.withPersistencePath(handle.path);
    persisted.persistIfNeeded();

    const listed = listManagedSessionsFor(root);
    expect(listed[0]?.id).toBe(session.sessionId);

    const resolved = resolveSessionReferenceFor(root, LATEST_SESSION_REFERENCE);
    expect(resolved.id).toBe(session.sessionId);

    const loaded = loadManagedSessionFor(root, "recent");
    expect(loaded.session.messages).toHaveLength(1);
    expect(isSessionReferenceAlias("last")).toBe(true);

    const forked = forkManagedSessionFor(root, loaded.session, "incident-review");
    expect(forked.parentSessionId).toBe(session.sessionId);
    expect(forked.branchName).toBe("incident-review");

    const cleared = clearSession(loaded.session);
    expect(cleared.messages).toHaveLength(0);
    expect(exportSession(loaded.session)).toContain(`"sessionId": "${session.sessionId}"`);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
