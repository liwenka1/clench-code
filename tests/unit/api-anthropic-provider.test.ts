import { describe, expect, test } from "vitest";

import {
  AnthropicClient,
  ClientIdentity,
  buildAnthropicRequestBody,
  buildAuthHeaders,
  readAnthropicBaseUrl
} from "../../src/api";
import { withEnv } from "../helpers/envGuards";

describe("api anthropic provider", () => {
  test("ports anthropic provider helper behavior", async () => {
    const client = new AnthropicClient("test-key")
      .withAuthToken("proxy-token")
      .withClientIdentity(new ClientIdentity("claude-code", "9.9.9").withRuntime("rust-cli"))
      .withBeta("tools-2026-04-01")
      .withExtraBodyParam("metadata", { source: "clench-code" });

    expect(client.authSource()).toEqual({
      type: "api_key_and_bearer",
      apiKey: "test-key",
      bearerToken: "proxy-token"
    });

    expect(
      buildAuthHeaders(client.authSource(), {
        "anthropic-version": "2023-06-01"
      })
    ).toEqual({
      "anthropic-version": "2023-06-01",
      "x-api-key": "test-key",
      authorization: "Bearer proxy-token"
    });

    const profile = client.requestProfileSnapshot();
    expect(profile.clientIdentity.userAgent()).toBe("claude-code/9.9.9");
    expect(profile.betas).toEqual([
      "claude-code-20250219",
      "prompt-caching-scope-2026-01-05",
      "tools-2026-04-01"
    ]);

    const body = buildAnthropicRequestBody(
      {
        model: "claude-3-7-sonnet-latest",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Say hello" }]
          }
        ],
        system: "Use tools when needed",
        tools: [
          {
            name: "get_weather",
            description: "Fetches the weather",
            input_schema: { type: "object" }
          }
        ],
        tool_choice: { type: "auto" }
      },
      profile
    );

    expect(body).toMatchObject({
      model: "claude-3-7-sonnet-latest",
      max_tokens: 64,
      system: "Use tools when needed",
      tool_choice: { type: "auto" },
      metadata: { source: "clench-code" },
      betas: [
        "claude-code-20250219",
        "prompt-caching-scope-2026-01-05",
        "tools-2026-04-01"
      ]
    });

    await withEnv({ ANTHROPIC_BASE_URL: "https://example.anthropic.test" }, async () => {
      expect(readAnthropicBaseUrl()).toBe("https://example.anthropic.test");
    });
  });
});
