import { describe, expect, test } from "vitest";

import type { StreamEvent } from "../../src/api/types";
import {
  apiRequestToMessageRequest,
  lastUsageFromStreamEvents,
  streamEventsToAssistantEvents
} from "../../src/runtime/provider-runtime-client";

describe("provider runtime client", () => {
  test("stream_events_to_assistant_events_maps_text_usage_and_stop", () => {
    const events: StreamEvent[] = [
      {
        type: "message_start",
        message: {
          id: "m1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi" }
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 3, output_tokens: 1 }
      },
      { type: "message_stop" }
    ];

    const assistant = streamEventsToAssistantEvents(events);
    expect(assistant).toEqual([
      { type: "text_delta", text: "Hi" },
      {
        type: "usage",
        usage: { input_tokens: 3, output_tokens: 1 }
      },
      { type: "message_stop" }
    ]);
  });

  test("stream_events_to_assistant_events_maps_tool_use_json_deltas", () => {
    const events: StreamEvent[] = [
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "tu_1",
          name: "add",
          input: {}
        }
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"a":' }
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "1}" }
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 10, output_tokens: 5 }
      },
      { type: "message_stop" }
    ];

    const assistant = streamEventsToAssistantEvents(events);
    expect(assistant.filter((e) => e.type === "tool_use")).toEqual([
      { type: "tool_use", id: "tu_1", name: "add", input: '{"a":1}' }
    ]);
  });

  test("last_usage_from_stream_events_takes_final_message_delta", () => {
    const u1 = { input_tokens: 1, output_tokens: 1 };
    const u2 = { input_tokens: 5, output_tokens: 3 };
    expect(
      lastUsageFromStreamEvents([
        { type: "message_delta", delta: { stop_reason: null, stop_sequence: null }, usage: u1 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: u2 }
      ])
    ).toBe(u2);
  });

  test("api_request_to_message_request_joins_system_and_maps_tool_blocks", () => {
    const req = apiRequestToMessageRequest(
      {
        systemPrompt: ["a", "b"],
        messages: [
          {
            role: "user",
            blocks: [{ type: "text", text: "hello" }]
          },
          {
            role: "assistant",
            blocks: [
              {
                type: "tool_use",
                id: "x",
                name: "t",
                input: '{"k":1}'
              }
            ]
          }
        ]
      },
      "claude-3-7-sonnet-latest",
      128
    );

    expect(req.model).toBe("claude-3-7-sonnet-latest");
    expect(req.max_tokens).toBe(128);
    expect(req.system).toBe("a\n\nb");
    expect(req.stream).toBe(true);
    expect(req.messages[1]!.content[0]).toMatchObject({
      type: "tool_use",
      id: "x",
      name: "t",
      input: { k: 1 }
    });
  });
});
