import { describe, expect, test } from "vitest";

import { ApiError } from "../../src/api/error";

describe("ApiError", () => {
  test("isRetryable_follows_flag_and_retries_exhausted_unwraps_cause", () => {
    const retryable = new ApiError("rate limit", {
      code: "http_error",
      status: 429,
      retryable: true
    });
    expect(retryable.isRetryable()).toBe(true);

    const fatal = new ApiError("bad request", { code: "http_error", status: 400, retryable: false });
    expect(fatal.isRetryable()).toBe(false);

    const wrapped = ApiError.retriesExhausted(3, retryable);
    expect(wrapped.code).toBe("retries_exhausted");
    expect(wrapped.isRetryable()).toBe(true);
    expect(wrapped.cause).toBe(retryable);
  });

  test("missingCredentials_sets_provider_and_env_vars", () => {
    const err = ApiError.missingCredentials("anthropic", ["ANTHROPIC_API_KEY", "AWS_KEY"]);
    expect(err.code).toBe("missing_credentials");
    expect(err.provider).toBe("anthropic");
    expect(err.envVars).toEqual(["ANTHROPIC_API_KEY", "AWS_KEY"]);
    expect(err.message).toContain("ANTHROPIC_API_KEY");
  });

  test("invalidSseFrame_preserves_cause", () => {
    const cause = new SyntaxError("bad json");
    const err = ApiError.invalidSseFrame("parse", cause);
    expect(err.code).toBe("invalid_sse_frame");
    expect(err.cause).toBe(cause);
  });
});
