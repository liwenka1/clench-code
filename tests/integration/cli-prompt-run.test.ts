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

describe("cli prompt run integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("run_prompt_mode_streams_assistant_text", async () => {
    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "cli_msg",
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
        delta: { type: "text_delta", text: "Hello" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 2, output_tokens: 2 }
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

    await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
      const summary = await runPromptMode({
        prompt: "Say hello",
        model: "claude-sonnet-4-6",
        permissionMode: "read-only",
        outputFormat: "text"
      });
      expect(summary.assistantMessages[0]?.blocks[0]).toMatchObject({
        type: "text",
        text: "Hello"
      });
    });
  });

  test("run_prompt_mode_chunked_sse_body_matches_single_shot", async () => {
    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "chunk_cli",
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
        delta: { type: "text_delta", text: "ChunkOK" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    const streamWhole = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      }
    });
    const streamChunked = new ReadableStream<Uint8Array>({
      start(controller) {
        const mid = Math.floor(sse.length / 2);
        controller.enqueue(new TextEncoder().encode(sse.slice(0, mid)));
        controller.enqueue(new TextEncoder().encode(sse.slice(mid)));
        controller.close();
      }
    });

    async function runOnce(stream: ReadableStream<Uint8Array>) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
      );
      const summary = await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () =>
        runPromptMode({
          prompt: "x",
          model: "claude-sonnet-4-6",
          permissionMode: "read-only",
          outputFormat: "text"
        })
      );
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      return summary;
    }

    const a = await runOnce(streamWhole);
    const b = await runOnce(streamChunked);
    expect(b.assistantMessages[0]?.blocks[0]).toEqual(a.assistantMessages[0]?.blocks[0]);
    expect(b.usage).toEqual(a.usage);
  });

  test("run_prompt_mode_exposes_default_workspace_tools_when_allowed_tools_is_omitted", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "default_tools",
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
        delta: { type: "text_delta", text: "Default tools available." }
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
      vi.fn().mockImplementation((_input, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return Promise.resolve(
          new Response(streamFromString(sse), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        );
      })
    );

    await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
      await runPromptMode({
        prompt: "hello",
        model: "claude-sonnet-4-6",
        permissionMode: "read-only",
        outputFormat: "text"
      });
    });

    expect(Array.isArray(requestBody?.tools)).toBe(true);
    expect((requestBody?.tools as Array<{ name: string }>).some((tool) => tool.name === "read_file")).toBe(true);
    expect(requestBody?.tool_choice).toEqual({ type: "auto" });
  });
});
