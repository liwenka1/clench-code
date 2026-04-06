import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { AnthropicClient, PromptCache } from "../../src/api";
import { withEnv } from "../helpers/envGuards";

const minimalOkJson = () =>
  JSON.stringify({
    id: "msg_cache_ok",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "from network" }],
    model: "claude-3-7-sonnet-latest",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 2 }
  });

function sampleRequest(text: string) {
  return {
    model: "claude-3-7-sonnet-latest",
    max_tokens: 64,
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text }]
      }
    ],
    system: "system"
  };
}

describe("AnthropicClient prompt cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("sendMessage_skips_http_when_completion_cache_hits", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withEnv({ CLAUDE_CONFIG_HOME: cacheRoot }, async () => {
        const cache = new PromptCache("pc-session");
        const client = new AnthropicClient("test-key")
          .withBaseUrl("http://127.0.0.1:9")
          .withPromptCache(cache);

        const req = sampleRequest("same prompt");
        let fetchCalls = 0;
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            fetchCalls += 1;
            return new Response(minimalOkJson(), {
              status: 200,
              headers: { "content-type": "application/json", "request-id": "req-1" }
            });
          })
        );

        const first = await client.sendMessage(req);
        expect(fetchCalls).toBe(1);
        expect(first.content[0]).toMatchObject({ type: "text", text: "from network" });

        const second = await client.sendMessage(req);
        expect(fetchCalls).toBe(1);
        expect(second.content[0]).toMatchObject({ type: "text", text: "from network" });
        expect(cache.stats().completionCacheHits).toBe(1);
      });
    });
  });

  test("sendMessage_without_prompt_cache_always_calls_fetch", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withEnv({ CLAUDE_CONFIG_HOME: cacheRoot }, async () => {
        const client = new AnthropicClient("test-key").withBaseUrl("http://127.0.0.1:9");
        const req = sampleRequest("no cache");
        let fetchCalls = 0;
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            fetchCalls += 1;
            return new Response(minimalOkJson(), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          })
        );

        await client.sendMessage(req);
        await client.sendMessage(req);
        expect(fetchCalls).toBe(2);
      });
    });
  });
});

async function withTempCacheRoot<T>(run: (cacheRoot: string) => Promise<T>): Promise<T> {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-pc-test-"));
  try {
    return await run(cacheRoot);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
}
