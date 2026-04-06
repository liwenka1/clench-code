import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AnthropicClient,
  ANTHROPIC_DEFAULT_MAX_RETRIES,
  anthropicBackoffMsForAttempt,
  ApiError,
  MemoryTelemetrySink,
  SessionTracer
} from "../../src/api";

const minimalOkJson = () =>
  JSON.stringify({
    id: "msg_retry_ok",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: "claude-3-7-sonnet-latest",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  });

describe("Anthropic send_with_retry parity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("anthropicBackoffMsForAttempt matches Rust doubling and cap", () => {
    expect(anthropicBackoffMsForAttempt(1)).toBe(200);
    expect(anthropicBackoffMsForAttempt(2)).toBe(400);
    expect(anthropicBackoffMsForAttempt(3)).toBe(800);
    expect(anthropicBackoffMsForAttempt(20)).toBe(2000);
  });

  test("sendMessage_retries_once_on_retryable_429_then_succeeds", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n === 1) {
          return new Response(JSON.stringify({ error: { type: "rate_limit", message: "slow" } }), {
            status: 429,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response(minimalOkJson(), {
          status: 200,
          headers: { "content-type": "application/json", "request-id": "after_retry" }
        });
      })
    );

    const client = new AnthropicClient("test-key").withBaseUrl("http://127.0.0.1:9");
    const t0 = Date.now();
    const response = await client.sendMessage({
      model: "claude-3-7-sonnet-latest",
      max_tokens: 8,
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }]
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(response.id).toBe("msg_retry_ok");
    expect(response.request_id).toBe("after_retry");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("sendMessage_throws_retries_exhausted_after_max_attempts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { type: "rate_limit", message: "still" } }), {
          status: 429,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const client = new AnthropicClient("test-key").withBaseUrl("http://127.0.0.1:9");
    await expect(
      client.sendMessage({
        model: "claude-3-7-sonnet-latest",
        max_tokens: 8,
        messages: [{ role: "user", content: [{ type: "text", text: "x" }] }]
      })
    ).rejects.toMatchObject({ code: "retries_exhausted" });

    expect(fetch).toHaveBeenCalledTimes(ANTHROPIC_DEFAULT_MAX_RETRIES + 1);
  });

  test("sendMessage_does_not_retry_non_retryable_401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { type: "auth", message: "no" } }), {
          status: 401,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const client = new AnthropicClient("test-key").withBaseUrl("http://127.0.0.1:9");
    try {
      await client.sendMessage({
        model: "claude-3-7-sonnet-latest",
        max_tokens: 8,
        messages: [{ role: "user", content: [{ type: "text", text: "x" }] }]
      });
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("api_error");
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("sendMessage_with_session_tracer_records_http_request_failed_on_retryable_error", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n === 1) {
          return new Response(JSON.stringify({ error: { type: "rate_limit", message: "slow" } }), {
            status: 429,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response(minimalOkJson(), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );

    const sink = new MemoryTelemetrySink();
    const client = new AnthropicClient("test-key")
      .withBaseUrl("http://127.0.0.1:9")
      .withSessionTracer(new SessionTracer("session-retry", sink));

    await client.sendMessage({
      model: "claude-3-7-sonnet-latest",
      max_tokens: 8,
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }]
    });

    const failed = sink.events().filter((e) => e.kind === "http_request_failed");
    expect(failed.length).toBe(1);
    expect(failed[0]).toMatchObject({
      kind: "http_request_failed",
      sessionId: "session-retry",
      attempt: 1,
      retryable: true
    });
  });
});
