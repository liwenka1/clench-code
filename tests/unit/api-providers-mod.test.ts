import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  apiModelIdForSelection,
  detectProviderKind,
  maxTokensForModel,
  normalizeModelSelection,
  ProviderClient,
  resolveModelSelection,
  resolveModelAlias
} from "../../src/api";
import { loadOauthCredentials } from "../../src/runtime/oauth.js";

import { withEnv } from "../helpers/envGuards";

describe("api providers mod", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  test("ports provider registry behavior", async () => {
    expect(resolveModelAlias("opus")).toBe("claude-opus-4-6");
    expect(resolveModelAlias("sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveModelAlias("haiku")).toBe("claude-haiku-4-5-20251213");
    expect(resolveModelAlias("grok")).toBe("grok-3");
    expect(resolveModelAlias("grok-mini")).toBe("grok-3-mini");
    expect(resolveModelAlias("grok-2")).toBe("grok-2");

    expect(detectProviderKind("grok")).toBe("xai");
    expect(detectProviderKind("claude-sonnet-4-6")).toBe("anthropic");

    expect(maxTokensForModel("opus")).toBe(32000);
    expect(maxTokensForModel("grok-3")).toBe(64000);
  });

  test("supports explicit provider-qualified model selections", async () => {
    expect(normalizeModelSelection("anthropic/sonnet")).toBe("anthropic/claude-sonnet-4-6");
    expect(normalizeModelSelection("openai/gpt-4.1-mini")).toBe("openai/gpt-4.1-mini");
    expect(apiModelIdForSelection("openai/gpt-4.1-mini")).toBe("gpt-4.1-mini");
    expect(detectProviderKind("openai/gpt-4.1-mini")).toBe("openai");
    expect(detectProviderKind("anthropic/sonnet")).toBe("anthropic");
    expect(maxTokensForModel("anthropic/opus")).toBe(32000);
  });

  test("configured provider ids resolve to their saved default model", async () => {
    const runtimeConfig = {
      providers: {
        cccc: {
          kind: "openai" as const,
          baseUrl: "http://127.0.0.1:11434/v1",
          apiKey: "dummy",
          defaultModel: "qwen3.5:4b"
        }
      }
    };

    expect(normalizeModelSelection("cccc", runtimeConfig)).toBe("cccc/qwen3.5:4b");
    expect(apiModelIdForSelection("cccc", runtimeConfig)).toBe("qwen3.5:4b");
    expect(resolveModelSelection("cccc", runtimeConfig)).toEqual({
      providerId: "cccc",
      provider: "openai",
      configuredModel: "cccc/qwen3.5:4b",
      apiModel: "qwen3.5:4b"
    });
    expect(detectProviderKind("cccc", runtimeConfig)).toBe("openai");
  });

  test("detectProviderKind falls back to env like Rust when model is not claude/grok", async () => {
    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        OPENAI_API_KEY: "sk-test",
        XAI_API_KEY: undefined
      },
      async () => {
        expect(detectProviderKind("gpt-4o-mini")).toBe("openai");
      }
    );

    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        OPENAI_API_KEY: undefined,
        XAI_API_KEY: "xai-test"
      },
      async () => {
        expect(detectProviderKind("custom-model")).toBe("xai");
      }
    );

    await withEnv(
      {
        ANTHROPIC_API_KEY: "anthropic-key",
        ANTHROPIC_AUTH_TOKEN: undefined,
        OPENAI_API_KEY: "sk-test",
        XAI_API_KEY: undefined
      },
      async () => {
        expect(detectProviderKind("unknown")).toBe("anthropic");
      }
    );
  });

  test("detectProviderKind and ProviderClient use saved OAuth when env Anthropic vars are unset", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-oauth-"));
    const credPath = path.join(dir, "credentials.json");
    fs.writeFileSync(
      credPath,
      JSON.stringify({
        oauth: {
          accessToken: "saved-oauth-token",
          scopes: ["workspace"],
          expiresAt: Math.floor(Date.now() / 1000) + 3600
        }
      })
    );

    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        OPENAI_API_KEY: undefined,
        XAI_API_KEY: undefined,
        CLENCH_CONFIG_HOME: dir
      },
      async () => {
        expect(detectProviderKind("custom-model")).toBe("anthropic");
        const client = await ProviderClient.fromModel("claude-sonnet-4-6");
        expect(client.providerKind()).toBe("anthropic");
        expect(client.anthropicClient()?.authSource()).toEqual({
          type: "bearer",
          bearerToken: "saved-oauth-token"
        });
      }
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("ProviderClient rejects expired saved OAuth when refresh_token missing and no settings", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-oauth-no-settings-"));
    fs.writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({
        oauth: {
          accessToken: "old",
          refreshToken: "rt",
          scopes: ["s"],
          expiresAt: Math.floor(Date.now() / 1000) - 10
        }
      })
    );

    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLENCH_CONFIG_HOME: dir
      },
      async () => {
        await expect(ProviderClient.fromModel("claude-sonnet-4-6")).rejects.toThrow(
          /runtime OAuth config is missing/
        );
      }
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("ProviderClient refreshes expired saved OAuth via token_url and persists credentials", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-oauth-refresh-"));
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({
        oauth: {
          clientId: "runtime-client",
          authorizeUrl: "https://console.test/oauth/authorize",
          tokenUrl: "https://console.test/oauth/token",
          scopes: ["scopes-a"]
        }
      })
    );
    fs.writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({
        oauth: {
          accessToken: "old",
          refreshToken: "refresh-token",
          scopes: ["scopes-a"],
          expiresAt: Math.floor(Date.now() / 1000) - 10
        }
      })
    );

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: "scopes-a"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLENCH_CONFIG_HOME: dir
      },
      async () => {
        const client = await ProviderClient.fromModel("claude-sonnet-4-6");
        expect(client.providerKind()).toBe("anthropic");
        expect(fetchMock).toHaveBeenCalled();
        const called = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(called[0]).toBe("https://console.test/oauth/token");
        expect(called[1]?.method).toBe("POST");
        expect((called[1]?.headers as Record<string, string>)["content-type"]).toBe(
          "application/x-www-form-urlencoded"
        );
        expect(String(called[1]?.body)).toContain("grant_type=refresh_token");

        const creds = loadOauthCredentials();
        expect(creds?.accessToken).toBe("new-access");
        expect(creds?.refreshToken).toBe("new-refresh");
        expect(creds?.scopes).toEqual(["scopes-a"]);
      }
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("ProviderClient rejects expired saved OAuth without refresh token", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-oauth-exp-"));
    fs.writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({
        oauth: {
          accessToken: "old",
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) - 10
        }
      })
    );

    await withEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLENCH_CONFIG_HOME: dir
      },
      async () => {
        await expect(ProviderClient.fromModel("claude-sonnet-4-6")).rejects.toThrow(
          /saved OAuth token is expired/
        );
      }
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
