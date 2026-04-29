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

  test("fromHttpError_and_fromJsonError_wrap_causes", () => {
    const http = ApiError.fromHttpError(new Error("econnreset"));
    expect(http.code).toBe("http_error");
    expect(http.retryable).toBe(true);
    expect(http.cause).toBeInstanceOf(Error);

    const abortCause = new Error("aborted");
    abortCause.name = "AbortError";
    const aborted = ApiError.fromHttpError(abortCause);
    expect(aborted.code).toBe("aborted");
    expect(aborted.retryable).toBe(false);

    const json = ApiError.fromJsonError("unexpected token");
    expect(json.code).toBe("json_error");
    expect(json.message).toContain("json error");
    expect(json.cause).toBe("unexpected token");
  });

  test("apiResponse_prefers_typed_message_or_falls_back_to_body", () => {
    const typed = ApiError.apiResponse({
      status: 400,
      errorType: "invalid_request",
      message: "bad",
      body: "{}",
      retryable: false
    });
    expect(typed.message).toContain("invalid_request");
    expect(typed.message).toContain("bad");
    expect(typed.status).toBe(400);

    const raw = ApiError.apiResponse({ status: 502, body: "upstream", retryable: true });
    expect(raw.message).toContain("502");
    expect(raw.message).toContain("upstream");
  });

  test("retriesExhausted_inherits_retryability_from_non_retryable_cause", () => {
    const last = new ApiError("nope", { code: "http_error", status: 400, retryable: false });
    const exhausted = ApiError.retriesExhausted(2, last);
    expect(exhausted.code).toBe("retries_exhausted");
    expect(exhausted.isRetryable()).toBe(false);
  });
});
