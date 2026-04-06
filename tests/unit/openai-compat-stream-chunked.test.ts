import { afterEach, describe, expect, test, vi } from "vitest";

import { ANTHROPIC_DEFAULT_MAX_RETRIES, ApiError, OpenAiCompatClient, OpenAiCompatConfig } from "../../src/api";

describe("OpenAI-compat streaming chunked SSE body", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("streamMessage parses chat completions SSE split across chunks", async () => {
    const line =
      'data: {"id":"cc_chunk","model":"grok-3","choices":[{"delta":{"content":"Hi"}}]}\n\n';
    const mid = 18;
    const partA = line.slice(0, mid);
    const partB = line.slice(mid);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(partA));
        controller.enqueue(new TextEncoder().encode(partB));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );

    const client = new OpenAiCompatClient("k", OpenAiCompatConfig.xai()).withBaseUrl("http://127.0.0.1:9");
    const msgStream = await client.streamMessage({
      model: "grok-3",
      max_tokens: 8,
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      stream: true
    });

    const events: unknown[] = [];
    while (true) {
      const e = await msgStream.nextEvent();
      if (!e) {
        break;
      }
      events.push(e);
    }

    expect(events.some((e) => typeof e === "object" && e !== null && (e as { type: string }).type === "message_start")).toBe(
      true
    );
    expect(events.some((e) => typeof e === "object" && e !== null && (e as { type: string }).type === "message_stop")).toBe(
      true
    );
  });

  test("chunked_sse_matches_single_shot_event_sequence", async () => {
    const line =
      'data: {"id":"eq","model":"grok-3","choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const done = "data: [DONE]\n\n";

    const streamWhole = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(line + done));
        controller.close();
      }
    });

    const splitAt = 22;
    const streamChunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(line.slice(0, splitAt)));
        controller.enqueue(new TextEncoder().encode(line.slice(splitAt)));
        controller.enqueue(new TextEncoder().encode(done));
        controller.close();
      }
    });

    const req = {
      model: "grok-3",
      max_tokens: 8,
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "x" }] }],
      stream: true as const
    };

    async function collect(stream: ReadableStream<Uint8Array>) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
      );
      const client = new OpenAiCompatClient("k", OpenAiCompatConfig.xai()).withBaseUrl("http://127.0.0.1:9");
      const msgStream = await client.streamMessage(req);
      const events: unknown[] = [];
      while (true) {
        const e = await msgStream.nextEvent();
        if (!e) {
          break;
        }
        events.push(e);
      }
      return events;
    }

    const whole = await collect(streamWhole);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const chunked = await collect(streamChunked);

    expect(chunked).toEqual(whole);
  });

  test("streamMessage_throws_api_error_on_non_ok_response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: "Incorrect API key", type: "invalid_request_error" }
          }),
          { status: 401, headers: { "content-type": "application/json" } }
        )
      )
    );

    const client = new OpenAiCompatClient("k", OpenAiCompatConfig.xai()).withBaseUrl("http://127.0.0.1:9");
    await expect(
      client.streamMessage({
        model: "grok-3",
        max_tokens: 8,
        messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
        stream: true
      })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApiError && err.code === "api_error" && err.status === 401 && err.retryable === false
    );
  });

  test("streamMessage_throws_retries_exhausted_on_persistent_429", async () => {
    const errJson = () => JSON.stringify({ error: { message: "rate limit" } });
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

    const client = new OpenAiCompatClient("k", OpenAiCompatConfig.xai()).withBaseUrl("http://127.0.0.1:9");
    await expect(
      client.streamMessage({
        model: "grok-3",
        max_tokens: 8,
        messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
        stream: true
      })
    ).rejects.toMatchObject({ code: "retries_exhausted" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(ANTHROPIC_DEFAULT_MAX_RETRIES + 1);
  });
});
