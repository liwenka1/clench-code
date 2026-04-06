import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ApiError,
  PromptCache,
  ProviderClient,
  readOpenAiBaseUrl,
  readXaiBaseUrl
} from "../../src/api";

import { withEnv } from "../helpers/envGuards";

async function withTempCacheRoot<T>(run: (cacheRoot: string) => Promise<T>): Promise<T> {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "provider-pc-test-"));
  try {
    return await run(cacheRoot);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
}

describe("provider client integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("with_prompt_cache_is_noop_for_openai_and_returns_same_instance", async () => {
    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        OPENAI_API_KEY: "sk-test",
        XAI_API_KEY: undefined
      },
      async () => {
        const base = await ProviderClient.fromModel("gpt-4o-mini");
        const cache = new PromptCache("noop-session");
        const next = base.withPromptCache(cache);
        expect(next).toBe(base);
        expect(next.promptCacheStats()).toBeUndefined();
        expect(next.takeLastPromptCacheRecord()).toBeUndefined();
      }
    );
  });

  test("from_model_with_anthropic_auth_accepts_prompt_cache_session_id_option", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withEnv({ CLAUDE_CONFIG_HOME: cacheRoot }, async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  id: "msg_opt",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "text", text: "ok" }],
                  model: "claude-3-7-sonnet-latest",
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 }
                }),
                { status: 200, headers: { "content-type": "application/json" } }
              )
            )
          )
        );

        const client = await ProviderClient.fromModelWithAnthropicAuth(
          "claude-sonnet-4-6",
          { type: "api_key", apiKey: "k" },
          { promptCacheSessionId: "session-from-option" }
        );

        await client.sendMessage({
          model: "claude-3-7-sonnet-latest",
          max_tokens: 4,
          messages: [{ role: "user", content: [{ type: "text", text: "x" }] }]
        });

        expect(client.promptCacheStats()?.completionCacheWrites).toBe(1);
      });
    });
  });

  test("with_prompt_cache_wires_anthropic_send_message_and_record", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withEnv({ CLAUDE_CONFIG_HOME: cacheRoot }, async () => {
        const cache = new PromptCache("prov-session");
        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  id: "msg_pc",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "text", text: "hi" }],
                  model: "claude-3-7-sonnet-latest",
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  usage: { input_tokens: 2, output_tokens: 1 }
                }),
                { status: 200, headers: { "content-type": "application/json" } }
              )
            )
          )
        );

        const withCache = (
          await ProviderClient.fromModelWithAnthropicAuth("claude-sonnet-4-6", {
            type: "api_key",
            apiKey: "k"
          })
        ).withPromptCache(cache);

        const res = await withCache.sendMessage({
          model: "claude-3-7-sonnet-latest",
          max_tokens: 8,
          messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }]
        });

        expect(res.content[0]).toMatchObject({ type: "text", text: "hi" });
        expect(withCache.promptCacheStats()?.completionCacheWrites).toBe(1);

        const record = withCache.takeLastPromptCacheRecord();
        expect(record?.stats.completionCacheWrites).toBe(1);
        expect(withCache.takeLastPromptCacheRecord()).toBeUndefined();
      });
    });
  });

  test("provider_client_routes_unknown_models_through_openai_when_only_openai_env", async () => {
    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        OPENAI_API_KEY: "sk-test",
        XAI_API_KEY: undefined
      },
      async () => {
        const client = await ProviderClient.fromModel("gpt-4o-mini");

        expect(client.providerKind()).toBe("openai");
        expect(client.openaiClient()).toBeDefined();
      }
    );
  });

  test("provider_client_routes_grok_aliases_through_xai", async () => {
    await withEnv({ XAI_API_KEY: "xai-test-key" }, async () => {
      const client = await ProviderClient.fromModel("grok-mini");

      expect(client.providerKind()).toBe("xai");
    });
  });

  test("provider_client_reports_missing_xai_credentials_for_grok_models", async () => {
    await withEnv({ XAI_API_KEY: undefined }, async () => {
      await expect(ProviderClient.fromModel("grok-3")).rejects.toThrowError(ApiError);

      try {
        await ProviderClient.fromModel("grok-3");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe("missing_credentials");
        expect((error as ApiError).provider).toBe("xAI");
        expect((error as ApiError).envVars).toEqual(["XAI_API_KEY"]);
      }
    });
  });

  test("provider_client_uses_explicit_anthropic_auth_without_env_lookup", async () => {
    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined
      },
      async () => {
        const client = await ProviderClient.fromModelWithAnthropicAuth("claude-sonnet-4-6", {
          type: "api_key",
          apiKey: "anthropic-test-key"
        });

        expect(client.providerKind()).toBe("anthropic");
        expect(client.anthropicClient()?.authSource()).toEqual({
          type: "api_key",
          apiKey: "anthropic-test-key"
        });
      }
    );
  });

  test("read_xai_base_url_prefers_env_override", async () => {
    await withEnv({ XAI_BASE_URL: "https://example.xai.test/v1" }, async () => {
      expect(readXaiBaseUrl()).toBe("https://example.xai.test/v1");
    });
  });

  test("read_openai_base_url_prefers_env_override", async () => {
    await withEnv({ OPENAI_BASE_URL: "https://example.openai.test/v1" }, async () => {
      expect(readOpenAiBaseUrl()).toBe("https://example.openai.test/v1");
    });
  });
});
