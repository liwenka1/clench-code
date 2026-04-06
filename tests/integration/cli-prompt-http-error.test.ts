import { afterEach, describe, expect, test, vi } from "vitest";

import { ANTHROPIC_DEFAULT_MAX_RETRIES, ApiError } from "../../src/api";
import { runPromptMode } from "../../src/cli/prompt-run";
import { withEnv } from "../helpers/envGuards";

describe("cli prompt mode HTTP errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("run_prompt_mode_surfaces_anthropic_401_as_api_error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { type: "authentication_error", message: "invalid x-api-key" }
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" }
          }
        )
      )
    );

    await withEnv({ ANTHROPIC_API_KEY: "bad-key" }, async () => {
      await expect(
        runPromptMode({
          prompt: "Hi",
          model: "claude-sonnet-4-6",
          permissionMode: "read-only",
          outputFormat: "text"
        })
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof ApiError && err.code === "api_error" && err.status === 401 && !err.retryable
      );
    });
  });

  test("run_prompt_mode_surfaces_rate_limit_retries_exhausted", async () => {
    const rateLimitBody = () =>
      JSON.stringify({
        error: { type: "rate_limit_error", message: "too many" }
      });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Response(rateLimitBody(), {
            status: 429,
            headers: { "content-type": "application/json" }
          })
      )
    );

    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      await expect(
        runPromptMode({
          prompt: "Hi",
          model: "claude-sonnet-4-6",
          permissionMode: "read-only",
          outputFormat: "text"
        })
      ).rejects.toMatchObject({ code: "retries_exhausted" });
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(ANTHROPIC_DEFAULT_MAX_RETRIES + 1);
  });
});
