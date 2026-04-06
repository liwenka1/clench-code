import { afterEach, describe, expect, test, vi } from "vitest";

import { ANTHROPIC_DEFAULT_MAX_RETRIES, AnthropicClient, ApiError } from "../../src/api";

describe("Anthropic streaming chunked SSE", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("streamMessage parses SSE split across multiple body chunks", async () => {
    const jsonLine =
      '{"type":"message_start","message":{"id":"chunked","type":"message","role":"assistant","content":[],"model":"claude-3-7-sonnet-latest","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}';
    const frame = `data: ${jsonLine}\n\n`;
    const mid = 24;
    const partA = frame.slice(0, mid);
    const partB = frame.slice(mid);
    const stopFrame = 'data: {"type":"message_stop"}\n\n';

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(partA));
        controller.enqueue(new TextEncoder().encode(partB));
        controller.enqueue(new TextEncoder().encode(stopFrame));
        controller.close();
      }
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_chunked" }
        })
      )
    );

    const client = new AnthropicClient("test-key").withBaseUrl("http://127.0.0.1:9");
    const msg = await client.streamMessage({
      model: "claude-3-7-sonnet-latest",
      max_tokens: 8,
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }]
    });

    expect(msg.requestId()).toBe("req_chunked");

    const e0 = await msg.nextEvent();
    expect(e0?.type).toBe("message_start");

    const e1 = await msg.nextEvent();
    expect(e1?.type).toBe("message_stop");

    expect(await msg.nextEvent()).toBeUndefined();
  });

  test("multi_frame_sse_matches_whole_body_vs_chunked_read", async () => {
    const messageStart = {
      type: "message_start" as const,
      message: {
        id: "eq-m",
        type: "message" as const,
        role: "assistant" as const,
        content: [] as unknown[],
        model: "claude-3-7-sonnet-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };
    const frames = [
      `data: ${JSON.stringify(messageStart)}\n\n`,
      `data: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi" }
      })}\n\n`,
      `data: ${JSON.stringify({ type: "message_stop" })}\n\n`
    ];
    const body = frames.join("");
    const splitAt = 55;

    const streamWhole = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      }
    });
    const streamChunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body.slice(0, splitAt)));
        controller.enqueue(new TextEncoder().encode(body.slice(splitAt)));
        controller.close();
      }
    });

    const req = {
      model: "claude-3-7-sonnet-latest",
      max_tokens: 8,
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "x" }] }]
    };

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(streamWhole, {
            status: 200,
            headers: { "content-type": "text/event-stream", "request-id": "req-whole" }
          })
        )
        .mockResolvedValueOnce(
          new Response(streamChunked, {
            status: 200,
            headers: { "content-type": "text/event-stream", "request-id": "req-chunked" }
          })
        )
    );

    const client = new AnthropicClient("test-key").withBaseUrl("http://127.0.0.1:9");

    async function collect() {
      const msg = await client.streamMessage(req);
      const events: unknown[] = [];
      while (true) {
        const e = await msg.nextEvent();
        if (!e) {
          break;
        }
        events.push(e);
      }
      return events;
    }

    const whole = await collect();
    const chunked = await collect();
    expect(chunked).toEqual(whole);
  });

  test("streamMessage_throws_api_error_on_401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { type: "authentication_error", message: "invalid x-api-key" }
          }),
          { status: 401, headers: { "content-type": "application/json" } }
        )
      )
    );

    const client = new AnthropicClient("bad").withBaseUrl("http://127.0.0.1:9");
    await expect(
      client.streamMessage({
        model: "claude-3-7-sonnet-latest",
        max_tokens: 8,
        messages: [{ role: "user", content: [{ type: "text", text: "x" }] }]
      })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApiError && err.code === "api_error" && err.status === 401 && err.retryable === false
    );
  });

  test("streamMessage_throws_retries_exhausted_on_persistent_429", async () => {
    const errJson = () =>
      JSON.stringify({
        error: { type: "rate_limit_error", message: "slow down" }
      });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Response(errJson(), {
            status: 429,
            headers: { "content-type": "application/json" }
          })
      )
    );

    const client = new AnthropicClient("test-key").withBaseUrl("http://127.0.0.1:9");
    await expect(
      client.streamMessage({
        model: "claude-3-7-sonnet-latest",
        max_tokens: 8,
        messages: [{ role: "user", content: [{ type: "text", text: "x" }] }]
      })
    ).rejects.toMatchObject({ code: "retries_exhausted" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(ANTHROPIC_DEFAULT_MAX_RETRIES + 1);
  });
});
