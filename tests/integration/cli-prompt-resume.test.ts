import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { runPromptMode } from "../../src/cli/prompt-run";
import { withEnv } from "../helpers/envGuards";

function streamFromString(body: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  });
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe("cli prompt resume integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("resume_session_appends_turn_to_jsonl", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-pc-"));
    const sessionPath = path.join(cacheRoot, "sess.jsonl");
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({ type: "meta", sessionId: "resume-int" })}\n${JSON.stringify({
        type: "message",
        message: { role: "user", blocks: [{ type: "text", text: "prior" }] }
      })}\n`,
      "utf8"
    );

    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "m2",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Done" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 3, output_tokens: 2 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamFromString(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );

    try {
      await withEnv(
        { ANTHROPIC_API_KEY: "test-key", CLAUDE_CONFIG_HOME: cacheRoot },
        async () => {
          await runPromptMode({
            prompt: "Continue",
            model: "claude-sonnet-4-6",
            permissionMode: "read-only",
            outputFormat: "text",
            resumeSessionPath: sessionPath
          });
        }
      );

      const after = fs.readFileSync(sessionPath, "utf8");
      expect(after).toContain("Continue");
      expect(after).toContain("Done");
      const lines = after.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(3);
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("run_prompt_mode_twice_on_same_resume_file_accumulates_history", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-pc-two-"));
    const sessionPath = path.join(cacheRoot, "multi.jsonl");

    const buildSse = (text: string) =>
      sseData({
        type: "message_start",
        message: {
          id: `m-${text}`,
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(streamFromString(buildSse("FirstTurn")), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
        .mockResolvedValueOnce(
          new Response(streamFromString(buildSse("SecondTurn")), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
    );

    try {
      await withEnv(
        { ANTHROPIC_API_KEY: "test-key", CLAUDE_CONFIG_HOME: cacheRoot },
        async () => {
          await runPromptMode({
            prompt: "one",
            model: "claude-sonnet-4-6",
            permissionMode: "read-only",
            outputFormat: "text",
            resumeSessionPath: sessionPath
          });
          await runPromptMode({
            prompt: "two",
            model: "claude-sonnet-4-6",
            permissionMode: "read-only",
            outputFormat: "text",
            resumeSessionPath: sessionPath
          });
        }
      );

      const body = fs.readFileSync(sessionPath, "utf8");
      expect(body).toContain("one");
      expect(body).toContain("FirstTurn");
      expect(body).toContain("two");
      expect(body).toContain("SecondTurn");
      const messageLines = body
        .split(/\r?\n/)
        .filter((line) => line.includes('"type":"message"'));
      expect(messageLines.length).toBeGreaterThanOrEqual(4);
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
