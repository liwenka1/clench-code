import { afterEach, describe, expect, test, vi } from "vitest";

import { ProviderClient } from "../../src/api";
import {
  ConversationRuntime,
  PermissionPolicy,
  ProviderRuntimeClient,
  Session,
  StaticToolExecutor
} from "../../src/runtime";

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe("runtime provider client integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("conversation_runtime_runs_turn_with_provider_streaming_client", async () => {
    const messageStart = {
      type: "message_start",
      message: {
        id: "sse_msg",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-7-sonnet-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };

    const sse =
      sseData(messageStart) +
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

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      }
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_sse" }
        })
      )
    );

    const provider = await ProviderClient.fromModelWithAnthropicAuth("claude-sonnet-4-6", {
      type: "api_key",
      apiKey: "k"
    });

    const runtime = new ConversationRuntime(
      Session.new(),
      new ProviderRuntimeClient(provider, "claude-3-7-sonnet-latest", 256),
      new StaticToolExecutor(),
      new PermissionPolicy("workspace-write"),
      ["You are helpful."]
    );

    const summary = await runtime.runTurn("Say hello.");
    expect(summary.iterations).toBe(1);
    expect(summary.assistantMessages).toHaveLength(1);
    expect(summary.assistantMessages[0]!.blocks[0]).toMatchObject({
      type: "text",
      text: "Hello"
    });
    expect(summary.usage.output_tokens).toBe(2);
  });

  test("conversation_runtime_executes_tool_then_streams_second_assistant_reply", async () => {
    const messageStart = {
      type: "message_start",
      message: {
        id: "sse_tool",
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
          id: "call_echo",
          name: "echo",
          input: {}
        }
      }) +
      sseData({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"q":"ping"}' }
      }) +
      sseData({ type: "content_block_stop", index: 1 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 4, output_tokens: 4 }
      }) +
      sseData({ type: "message_stop" });

    const sseText =
      sseData({
        ...messageStart,
        message: { ...messageStart.message, id: "sse_text" }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Tool done." }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 8, output_tokens: 3 }
      }) +
      sseData({ type: "message_stop" });

    const streamTool = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseTool));
        controller.close();
      }
    });
    const streamText = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseText));
        controller.close();
      }
    });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(streamTool, {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
        .mockResolvedValueOnce(
          new Response(streamText, {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
    );

    const provider = await ProviderClient.fromModelWithAnthropicAuth("claude-sonnet-4-6", {
      type: "api_key",
      apiKey: "k"
    });

    let toolsExec = new StaticToolExecutor();
    toolsExec = toolsExec.register("echo", (input) => `ECHO:${input}`);

    const runtime = new ConversationRuntime(
      Session.new(),
      new ProviderRuntimeClient(provider, "claude-3-7-sonnet-latest", 256, {
        tools: [
          {
            name: "echo",
            description: "Echo params",
            input_schema: { type: "object" }
          }
        ],
        toolChoice: { type: "auto" }
      }),
      toolsExec,
      new PermissionPolicy("danger-full-access"),
      ["You are helpful."]
    );

    const summary = await runtime.runTurn("Use echo.");
    expect(summary.iterations).toBe(2);
    expect(summary.toolResults).toHaveLength(1);
    expect(summary.toolResults[0]!.blocks[0]).toMatchObject({
      type: "tool_result",
      tool_name: "echo",
      is_error: false,
      output: expect.stringContaining("ECHO:")
    });
    expect(summary.assistantMessages).toHaveLength(2);
    expect(summary.assistantMessages[1]!.blocks[0]).toMatchObject({
      type: "text",
      text: "Tool done."
    });
  });
});
