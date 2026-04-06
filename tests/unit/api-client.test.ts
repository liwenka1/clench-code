import { describe, expect, test } from "vitest";

import {
  AnthropicRequestProfile,
  buildAnthropicRequestBody,
  buildAuthHeaders,
  isRetryableStatus,
  readAnthropicBaseUrl,
  requestIdFromHeaders,
  withStreaming
} from "../../src/api";

describe("api client unit behavior", () => {
  test("resolves_existing_and_grok_aliases", async () => {
    const request = withStreaming({
      model: "claude-opus-4-6",
      max_tokens: 64,
      messages: []
    });

    expect(request.stream).toBe(true);
  });

  test("provider_detection_prefers_model_family", async () => {
    const primaryHeaders = new Headers({ "request-id": "req_primary" });
    expect(requestIdFromHeaders(primaryHeaders)).toBe("req_primary");

    const fallbackHeaders = new Headers({ "x-request-id": "req_fallback" });
    expect(requestIdFromHeaders(fallbackHeaders)).toBe("req_fallback");

    expect(
      buildAuthHeaders(
        { type: "api_key_and_bearer", apiKey: "test-key", bearerToken: "proxy-token" },
        {}
      )
    ).toEqual({
      "x-api-key": "test-key",
      authorization: "Bearer proxy-token"
    });

    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(401)).toBe(false);
  });

  test("readAnthropicBaseUrl_respects_env_override", () => {
    const prev = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example/v1";
    try {
      expect(readAnthropicBaseUrl()).toBe("https://proxy.example/v1");
    } finally {
      if (prev === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
      } else {
        process.env.ANTHROPIC_BASE_URL = prev;
      }
    }
  });

  test("buildAnthropicRequestBody_merges_profile_and_request_fields", () => {
    const profile = new AnthropicRequestProfile().withExtraBody("metadata", { run: "parity-check" });
    const body = buildAnthropicRequestBody(
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 100,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        system: "be brief",
        tools: [{ name: "noop", input_schema: { type: "object" } }],
        stream: false
      },
      profile
    );

    expect(body.model).toBe("claude-3-5-sonnet-20241022");
    expect(body.system).toBe("be brief");
    expect(body.tools).toHaveLength(1);
    expect(body.betas).toEqual(profile.betas);
    expect(body.metadata).toEqual({ run: "parity-check" });
    expect(body.stream).toBeUndefined();
  });
});
