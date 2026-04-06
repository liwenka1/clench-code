import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { Session } from "../../src/runtime";
import { writeJsonFile } from "../helpers/sessionFixtures";

describe("runtime session integration", () => {
  test("persists_and_restores_session_jsonl", async () => {
    const sessionPath = tempSessionPath("session.jsonl");
    let session = Session.new().withPersistencePath(sessionPath);
    session = session.pushUserText("hello");
    session = session.pushMessage({
      role: "assistant",
      blocks: [{ type: "text", text: "world" }]
    });

    const restored = Session.loadFromPath(sessionPath);
    expect(restored.messages).toEqual(session.messages);
    cleanup(sessionPath);
  });

  test("loads_legacy_session_json_object", async () => {
    const sessionPath = tempSessionPath("legacy.json");
    await writeJsonFile(sessionPath, {
      sessionId: "legacy-session",
      messages: [
        {
          role: "user",
          blocks: [{ type: "text", text: "legacy" }]
        }
      ]
    });

    const restored = Session.loadFromPath(sessionPath);
    expect(restored.sessionId).toBe("legacy-session");
    expect(restored.messages).toHaveLength(1);
    cleanup(sessionPath);
  });

  test("writes_second_jsonl_message_as_single_append_line", async () => {
    const sessionPath = tempSessionPath("append-line.jsonl");
    let session = Session.new().withPersistencePath(sessionPath);
    session = session.pushUserText("one");
    session = session.pushUserText("two");

    const lines = fs.readFileSync(sessionPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBe(3);
    expect(lines.filter((line) => line.includes('"type":"message"')).length).toBe(2);

    const restored = Session.loadFromPath(sessionPath);
    expect(restored.messages).toHaveLength(2);
    cleanup(sessionPath);
  });

  test("rewrites_legacy_monolithic_json_on_next_push_instead_of_appending", async () => {
    const sessionPath = tempSessionPath("legacy-to-jsonl.json");
    await writeJsonFile(sessionPath, {
      sessionId: "legacy-session",
      messages: [{ role: "user", blocks: [{ type: "text", text: "first" }] }]
    });

    let session = Session.loadFromPath(sessionPath).withPersistencePath(sessionPath);
    session = session.pushUserText("second");

    const text = fs.readFileSync(sessionPath, "utf8").trim();
    expect(text.split(/\r?\n/).filter(Boolean).length).toBeGreaterThan(1);
    expect(text).toContain('"type":"session_meta"');

    const restored = Session.loadFromPath(sessionPath);
    expect(restored.messages).toHaveLength(2);
    cleanup(sessionPath);
  });

  test("appends_messages_to_persisted_jsonl_session", async () => {
    const sessionPath = tempSessionPath("append.jsonl");
    let session = Session.new().withPersistencePath(sessionPath);
    session = session.pushUserText("one");
    session = session.pushMessage({
      role: "assistant",
      blocks: [{ type: "text", text: "two" }]
    });

    const restored = Session.loadFromPath(sessionPath);
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[1]?.role).toBe("assistant");
    cleanup(sessionPath);
  });

  test("persists_compaction_metadata", async () => {
    const sessionPath = tempSessionPath("compaction.jsonl");
    const session = Session.new()
      .withPersistencePath(sessionPath)
      .withCompaction({
        summary: "Conversation summary",
        removedMessageCount: 2
      });

    session.persistIfNeeded();
    const restored = Session.loadFromPath(sessionPath);
    expect(restored.compaction).toEqual({
      summary: "Conversation summary",
      removedMessageCount: 2,
      count: 1
    });
    cleanup(sessionPath);
  });

  test("forks_sessions_with_branch_metadata_and_persists_it", async () => {
    const sessionPath = tempSessionPath("fork.jsonl");
    const forked = Session.new()
      .withPersistencePath(sessionPath)
      .pushUserText("branch me")
      .forkSession("feature/runtime");

    forked.persistIfNeeded();
    const restored = Session.loadFromPath(sessionPath);
    expect(restored.fork).toEqual({
      parentSessionId: expect.any(String),
      branchName: "feature/runtime"
    });
    cleanup(sessionPath);
  });

  test("loads_rust_style_jsonl_session_meta_compaction_and_fork", async () => {
    const sessionPath = tempSessionPath("rust-style.jsonl");
    const body = [
      JSON.stringify({
        type: "session_meta",
        version: 1,
        session_id: "rust-session",
        created_at_ms: 0,
        updated_at_ms: 0,
        fork: { parent_session_id: "parent-1", branch_name: "feature/x" }
      }),
      JSON.stringify({
        type: "compaction",
        count: 2,
        removed_message_count: 3,
        summary: "upstream summary"
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          blocks: [{ type: "text", text: "hi" }]
        }
      })
    ].join("\n");

    fs.writeFileSync(sessionPath, body, "utf8");
    const restored = Session.loadFromPath(sessionPath);
    expect(restored.sessionId).toBe("rust-session");
    expect(restored.compaction).toEqual({
      summary: "upstream summary",
      removedMessageCount: 3,
      count: 2
    });
    expect(restored.fork).toEqual({
      parentSessionId: "parent-1",
      branchName: "feature/x"
    });
    expect(restored.messages).toHaveLength(1);
    expect(restored.messages[0]?.blocks[0]).toEqual({ type: "text", text: "hi" });
    cleanup(sessionPath);
  });

  test("rotates_and_cleans_up_large_session_logs", async () => {
    const sessionPath = tempSessionPath("rotate.jsonl");
    let session = Session.new()
      .withPersistencePath(sessionPath)
      .withRotationLimit(10);
    session = session.pushUserText("this will rotate");

    expect(fs.existsSync(`${sessionPath}.1`)).toBe(true);
    expect(fs.existsSync(`${sessionPath}.2`)).toBe(false);
    cleanup(sessionPath);
    cleanup(`${sessionPath}.1`);
  });

  test("openAtPath_creates_bound_session_when_file_missing", () => {
    const sessionPath = tempSessionPath("new.jsonl");
    const opened = Session.openAtPath(sessionPath);
    expect(opened.persistencePath).toBe(sessionPath);
    expect(opened.messages).toHaveLength(0);
    expect(fs.existsSync(sessionPath)).toBe(false);
    cleanup(sessionPath);
  });
});

function tempSessionPath(fileName: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-session-")), fileName);
}

function cleanup(filePath: string): void {
  try {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures.
  }
}
