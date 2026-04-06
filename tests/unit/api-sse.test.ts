import { describe, expect, test } from "vitest";

import { SseParser, parseFrame } from "../../src/api";

describe("api sse parser", () => {
  test("parses_single_frame", async () => {
    const frame = [
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Hi"}}',
      ""
    ].join("\n");

    expect(parseFrame(frame)).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "text",
        text: "Hi"
      }
    });
  });

  test("parses_chunked_stream", async () => {
    const parser = new SseParser();
    const first =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel';
    const second = 'lo"}}\n\n';

    expect(parser.push(first)).toEqual([]);
    expect(parser.push(second)).toEqual([
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "Hello"
        }
      }
    ]);
  });

  test("ignores_ping_and_done", async () => {
    const parser = new SseParser();
    const payload = [
      ": keepalive",
      "event: ping",
      'data: {"type":"ping"}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":1,"output_tokens":2}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
      "data: [DONE]",
      ""
    ].join("\n");

    expect(parser.push(payload)).toEqual([
      {
        type: "message_delta",
        delta: {
          stop_reason: "tool_use",
          stop_sequence: null
        },
        usage: {
          input_tokens: 1,
          output_tokens: 2
        }
      },
      {
        type: "message_stop"
      }
    ]);
  });

  test("parses_split_json_across_data_lines", async () => {
    const frame = [
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,',
      'data: "delta":{"type":"text_delta","text":"Hello"}}',
      ""
    ].join("\n");

    expect(parseFrame(frame)).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: "Hello"
      }
    });
  });

  test("parses_thinking_related_deltas", async () => {
    const thinking = [
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step 1"}}',
      ""
    ].join("\n");
    const signature = [
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_123"}}',
      ""
    ].join("\n");

    expect(parseFrame(thinking)).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "thinking_delta",
        thinking: "step 1"
      }
    });
    expect(parseFrame(signature)).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "signature_delta",
        signature: "sig_123"
      }
    });
  });
});
