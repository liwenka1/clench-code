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

describe("cli prompt mode with tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("run_prompt_mode_bash_tool_then_text_second_stream", async () => {
    const messageStart = {
      type: "message_start",
      message: {
        id: "t1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-7-sonnet-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };

    const sseTool =
      sseData(messageStart) +
      sseData({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "tb1",
          name: "bash",
          input: {}
        }
      }) +
      sseData({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"command":"echo hi"}' }
      }) +
      sseData({ type: "content_block_stop", index: 1 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 3, output_tokens: 3 }
      }) +
      sseData({ type: "message_stop" });

    const sseText =
      sseData({
        ...messageStart,
        message: { ...messageStart.message, id: "t2" }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "After bash." }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 6, output_tokens: 2 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(streamFromString(sseTool), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
        .mockResolvedValueOnce(
          new Response(streamFromString(sseText), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
    );

    await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
      const summary = await runPromptMode({
        prompt: "Run bash",
        model: "claude-sonnet-4-6",
        permissionMode: "danger-full-access",
        outputFormat: "text",
        allowedTools: ["bash"]
      });

      expect(summary.iterations).toBe(2);
      expect(summary.toolResults).toHaveLength(1);
      expect(summary.assistantMessages).toHaveLength(2);
      expect(summary.assistantMessages[1]!.blocks[0]).toMatchObject({
        type: "text",
        text: "After bash."
      });
    });
  });

  test("run_prompt_mode_read_only_denies_bash_then_assistant_recovers", async () => {
    const messageStart = {
      type: "message_start",
      message: {
        id: "ro1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-7-sonnet-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };

    const sseTool =
      sseData(messageStart) +
      sseData({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "tb_ro",
          name: "bash",
          input: {}
        }
      }) +
      sseData({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"command":"whoami"}' }
      }) +
      sseData({ type: "content_block_stop", index: 1 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 2, output_tokens: 2 }
      }) +
      sseData({ type: "message_stop" });

    const sseText =
      sseData({
        ...messageStart,
        message: { ...messageStart.message, id: "ro2" }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Cannot run bash here." }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 5, output_tokens: 4 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(streamFromString(sseTool), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
        .mockResolvedValueOnce(
          new Response(streamFromString(sseText), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
    );

    await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
      const summary = await runPromptMode({
        prompt: "Run bash",
        model: "claude-sonnet-4-6",
        permissionMode: "read-only",
        outputFormat: "text",
        allowedTools: ["bash"]
      });

      expect(summary.iterations).toBe(2);
      expect(summary.toolResults).toHaveLength(1);
      expect(summary.toolResults[0]!.blocks[0]).toMatchObject({
        type: "tool_result",
        tool_name: "bash",
        is_error: true
      });
      const out = String((summary.toolResults[0]!.blocks[0] as { output: string }).output);
      expect(out).toMatch(/read-only|danger-full-access/i);
      expect(summary.assistantMessages[1]!.blocks[0]).toMatchObject({
        type: "text",
        text: "Cannot run bash here."
      });
    });
  });
});
