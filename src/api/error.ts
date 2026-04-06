export type ApiErrorCode =
  | "missing_credentials"
  | "http_error"
  | "api_error"
  | "json_error"
  | "invalid_sse_frame"
  | "retries_exhausted";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly provider?: string;
  readonly envVars?: string[];
  readonly status?: number;
  readonly errorType?: string;
  readonly body?: string;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code: ApiErrorCode;
      provider?: string;
      envVars?: string[];
      status?: number;
      errorType?: string;
      body?: string;
      retryable?: boolean;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = "ApiError";
    this.code = options.code;
    this.provider = options.provider;
    this.envVars = options.envVars;
    this.status = options.status;
    this.errorType = options.errorType;
    this.body = options.body;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }

  /** Aligns with Rust `ApiError::is_retryable` for retry loops. */
  isRetryable(): boolean {
    if (this.code === "retries_exhausted") {
      return this.cause instanceof ApiError ? this.cause.isRetryable() : false;
    }
    return this.retryable;
  }

  static retriesExhausted(attempts: number, lastError: ApiError): ApiError {
    return new ApiError(`api failed after ${attempts} attempts: ${lastError.message}`, {
      code: "retries_exhausted",
      retryable: lastError.isRetryable(),
      cause: lastError
    });
  }

  static missingCredentials(provider: string, envVars: string[]): ApiError {
    return new ApiError(
      `missing ${provider} credentials; export ${envVars.join(" or ")} before calling the ${provider} API`,
      { code: "missing_credentials", provider, envVars }
    );
  }

  static invalidSseFrame(message: string, cause?: unknown): ApiError {
    return new ApiError(`invalid sse frame: ${message}`, {
      code: "invalid_sse_frame",
      cause
    });
  }

  static fromHttpError(error: unknown): ApiError {
    return new ApiError(`http error: ${String(error)}`, {
      code: "http_error",
      retryable: true,
      cause: error
    });
  }

  static fromJsonError(error: unknown): ApiError {
    return new ApiError(`json error: ${String(error)}`, {
      code: "json_error",
      cause: error
    });
  }

  static apiResponse(options: {
    status: number;
    errorType?: string;
    message?: string;
    body: string;
    retryable: boolean;
  }): ApiError {
    const message =
      options.errorType && options.message
        ? `api returned ${options.status} (${options.errorType}): ${options.message}`
        : `api returned ${options.status}: ${options.body}`;
    return new ApiError(message, {
      code: "api_error",
      status: options.status,
      errorType: options.errorType,
      body: options.body,
      retryable: options.retryable
    });
  }
}
