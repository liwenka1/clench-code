import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ANTHROPIC_DEFAULT_MAX_RETRIES,
  ApiError,
  OpenAiCompatClient,
  OpenAiCompatConfig
} from "../../src/api";

const minimalChatJson = () =>
  JSON.stringify({
    id: "chat_retry_ok",
    model: "grok-3",
    choices: [
      {
        message: { role: "assistant", content: "ok", tool_calls: [] },
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 }
  });

describe("OpenAI-compat send_with_retry parity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("sendMessage_retries_429_then_succeeds", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n === 1) {
          return new Response(JSON.stringify({ error: { message: "rate" } }), {
            status: 429,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response(minimalChatJson(), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );

    const client = new OpenAiCompatClient("k", OpenAiCompatConfig.xai()).withBaseUrl("http://127.0.0.1:9");
    const r = await client.sendMessage({
      model: "grok-3",
      max_tokens: 8,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    });
    expect(r.id).toBe("chat_retry_ok");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("sendMessage_exhausts_retries_on_persistent_429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "rate" } }), {
          status: 429,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const client = new OpenAiCompatClient("k", OpenAiCompatConfig.xai()).withBaseUrl("http://127.0.0.1:9");
    await expect(
      client.sendMessage({
        model: "grok-3",
        max_tokens: 8,
        messages: [{ role: "user", content: [{ type: "text", text: "x" }] }]
      })
    ).rejects.toMatchObject({ code: "retries_exhausted" });

    expect(fetch).toHaveBeenCalledTimes(ANTHROPIC_DEFAULT_MAX_RETRIES + 1);
  });

  test("sendMessage_does_not_retry_401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "no" } }), {
          status: 401,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const client = new OpenAiCompatClient("k", OpenAiCompatConfig.xai()).withBaseUrl("http://127.0.0.1:9");
    try {
      await client.sendMessage({
        model: "grok-3",
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
});
