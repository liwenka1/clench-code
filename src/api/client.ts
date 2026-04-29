import { ApiError } from "./error";
import { SseParser } from "./sse";
import {
  AnthropicRequestProfile,
  ClientIdentity,
  DEFAULT_ANTHROPIC_VERSION,
  SessionTracer,
  estimateCostUsd,
  formatUsd
} from "./telemetry";
import type { PromptCache, PromptCacheRecord, PromptCacheStats } from "./prompt-cache";
import {
  totalTokens,
  type MessageRequest,
  type MessageResponse,
  type StreamEvent,
  type Usage
} from "./types";

export const DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Matches Rust `DEFAULT_MAX_RETRIES` on `AnthropicClient`. */
export const ANTHROPIC_DEFAULT_MAX_RETRIES = 2;

const INITIAL_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Rust `backoff_for_attempt` (base × 2^(attempt−1), capped). Exported for unit tests. */
export function anthropicBackoffMsForAttempt(attempt: number): number {
  const shift = Math.min(Math.max(attempt - 1, 0), 31);
  const mult = 1 << shift;
  const delay = INITIAL_BACKOFF_MS * mult;
  return Math.min(delay, MAX_BACKOFF_MS);
}

export type AuthSource =
  | { type: "none" }
  | { type: "api_key"; apiKey: string }
  | { type: "bearer"; bearerToken: string }
  | { type: "api_key_and_bearer"; apiKey: string; bearerToken: string };

export class AnthropicClient {
  private readonly auth: AuthSource;
  private readonly baseUrl: string;
  private readonly requestProfile: AnthropicRequestProfile;
  private readonly sessionTracer?: SessionTracer;
  private readonly promptCache?: PromptCache;
  private lastPromptCacheRecord?: PromptCacheRecord;

  constructor(apiKey: string) {
    this.auth = { type: "api_key", apiKey };
    this.baseUrl = DEFAULT_BASE_URL;
    this.requestProfile = new AnthropicRequestProfile();
  }

  static fromAuth(auth: AuthSource): AnthropicClient {
    return new AnthropicClient("").withAuthSource(auth);
  }

  withAuthSource(auth: AuthSource): AnthropicClient {
    const next = this.clone();
    next.authValue = auth;
    return next;
  }

  withAuthToken(authToken?: string): AnthropicClient {
    const token = authToken?.trim();
    const next = this.clone();

    if (this.auth.type === "api_key") {
      next.authValue = token
        ? { type: "api_key_and_bearer", apiKey: this.auth.apiKey, bearerToken: token }
        : this.auth;
      return next;
    }

    if (this.auth.type === "api_key_and_bearer") {
      next.authValue = token
        ? { ...this.auth, bearerToken: token }
        : { type: "api_key", apiKey: this.auth.apiKey };
      return next;
    }

    if (this.auth.type === "bearer") {
      next.authValue = token ? { type: "bearer", bearerToken: token } : { type: "none" };
      return next;
    }

    next.authValue = token ? { type: "bearer", bearerToken: token } : { type: "none" };
    return next;
  }

  withBaseUrl(baseUrl: string): AnthropicClient {
    const next = this.clone();
    next.baseUrlValue = baseUrl;
    return next;
  }

  withClientIdentity(clientIdentity: ClientIdentity): AnthropicClient {
    const next = this.clone();
    next.requestProfileValue = this.requestProfile.withClientIdentity(clientIdentity);
    return next;
  }

  withBeta(beta: string): AnthropicClient {
    const next = this.clone();
    next.requestProfileValue = this.requestProfile.withBeta(beta);
    return next;
  }

  withExtraBodyParam(key: string, value: unknown): AnthropicClient {
    const next = this.clone();
    next.requestProfileValue = this.requestProfile.withExtraBody(key, value);
    return next;
  }

  withSessionTracer(sessionTracer: SessionTracer): AnthropicClient {
    const next = this.clone();
    next.sessionTracerValue = sessionTracer;
    return next;
  }

  withPromptCache(promptCache: PromptCache): AnthropicClient {
    const next = this.clone();
    next.promptCacheValue = promptCache;
    return next;
  }

  /** Rust `AnthropicClient::prompt_cache_stats`. */
  promptCacheStats(): PromptCacheStats | undefined {
    return this.promptCache?.stats();
  }

  /** Rust `AnthropicClient::take_last_prompt_cache_record`. */
  takeLastPromptCacheRecord(): PromptCacheRecord | undefined {
    const record = this.lastPromptCacheRecord;
    this.lastPromptCacheRecord = undefined;
    return record;
  }

  /**
   * After a streaming turn, record prompt-cache token stats (Rust stream path uses `record_usage`).
   * Uses `stream: false` fingerprint of the request for cache tracking.
   */
  recordPromptCacheStreamUsage(request: MessageRequest, usage: Usage): void {
    if (!this.promptCache) {
      this.lastPromptCacheRecord = undefined;
      return;
    }
    const req = { ...request, stream: false };
    this.lastPromptCacheRecord = this.promptCache.recordUsage(req, usage);
  }

  async sendMessage(request: MessageRequest): Promise<MessageResponse> {
    const req = { ...request, stream: false };

    if (this.promptCache) {
      const cached = this.promptCache.lookupCompletion(req);
      if (cached) {
        cached.usage.cache_creation_input_tokens ??= 0;
        cached.usage.cache_read_input_tokens ??= 0;
        this.sessionTracer?.recordAnalytics({
          kind: "analytics",
          namespace: "api",
          action: "message_usage",
          properties: {
            request_id: cached.request_id ?? null,
            total_tokens: totalTokens(cached.usage),
            estimated_cost_usd: formatUsd(estimateCostUsd(cached))
          }
        });
        return cached;
      }
    }

    const response = await this.sendWithRetry(req);

    const requestId = requestIdFromHeaders(response.headers);

    let parsed: MessageResponse;
    try {
      parsed = (await response.json()) as MessageResponse;
    } catch (error) {
      throw ApiError.fromJsonError(error);
    }

    if (!parsed.request_id && requestId) {
      parsed.request_id = requestId;
    }
    parsed.usage.cache_creation_input_tokens ??= 0;
    parsed.usage.cache_read_input_tokens ??= 0;

    if (this.promptCache) {
      this.lastPromptCacheRecord = this.promptCache.recordResponse(req, parsed);
    } else {
      this.lastPromptCacheRecord = undefined;
    }

    this.sessionTracer?.recordAnalytics({
      kind: "analytics",
      namespace: "api",
      action: "message_usage",
      properties: {
        request_id: parsed.request_id ?? null,
        total_tokens: totalTokens(parsed.usage),
        estimated_cost_usd: formatUsd(estimateCostUsd(parsed))
      }
    });

    return parsed;
  }

  async streamMessage(request: MessageRequest, options: { signal?: AbortSignal } = {}): Promise<AnthropicMessageStream> {
    const response = await this.sendWithRetry({ ...request, stream: true }, options.signal);

    const requestId = requestIdFromHeaders(response.headers);

    if (!response.body) {
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw ApiError.fromHttpError(error);
      }
      const parser = new SseParser();
      const events = [...parser.push(text), ...parser.finish()];
      return new AnthropicMessageStream(requestId, events);
    }

    return new AnthropicMessageStream(requestId, response.body);
  }

  requestProfileSnapshot(): AnthropicRequestProfile {
    return this.requestProfile;
  }

  authSource(): AuthSource {
    return this.auth;
  }

  private async sendRawRequest(request: MessageRequest, signal?: AbortSignal): Promise<Response> {
    const body = this.renderRequestBody(request);
    return fetch(this.requestUrl(), {
      method: "POST",
      headers: this.requestHeaders(),
      body: JSON.stringify(body),
      signal
    });
  }

  /**
   * Rust `send_with_retry`: exponential backoff, up to `max_retries + 1` attempts.
   */
  private recordAnthropicFailure(attempt: number, err: ApiError): void {
    this.sessionTracer?.recordHttpRequestFailed(
      attempt,
      "POST",
      "/v1/messages",
      err.message,
      err.isRetryable()
    );
  }

  private async sendWithRetry(request: MessageRequest, signal?: AbortSignal): Promise<Response> {
    const maxRetries = ANTHROPIC_DEFAULT_MAX_RETRIES;

    for (let attempt = 1; ; attempt++) {
      this.sessionTracer?.recordHttpRequestStarted(attempt, "POST", "/v1/messages");

      let response: Response;
      try {
        response = await this.sendRawRequest(request, signal);
      } catch (error) {
        const err = error instanceof ApiError ? error : ApiError.fromHttpError(error);
        this.recordAnthropicFailure(attempt, err);
        if (!err.isRetryable() || attempt > maxRetries + 1) {
          throw err;
        }
        if (attempt > maxRetries) {
          throw ApiError.retriesExhausted(attempt, err);
        }
        await sleep(anthropicBackoffMsForAttempt(attempt));
        continue;
      }

      if (response.ok) {
        this.sessionTracer?.recordHttpRequestSucceeded(
          attempt,
          "POST",
          "/v1/messages",
          response.status,
          requestIdFromHeaders(response.headers)
        );
        return response;
      }

      const err = await parseApiError(response);
      this.recordAnthropicFailure(attempt, err);
      if (!err.isRetryable() || attempt > maxRetries + 1) {
        throw err;
      }
      if (attempt > maxRetries) {
        throw ApiError.retriesExhausted(attempt, err);
      }
      await sleep(anthropicBackoffMsForAttempt(attempt));
    }
  }

  private requestUrl(): string {
    return `${this.baseUrl.replace(/\/$/, "")}/v1/messages`;
  }

  private requestHeaders(): HeadersInit {
    return buildAuthHeaders(this.auth, {
      "content-type": "application/json",
      "anthropic-version": DEFAULT_ANTHROPIC_VERSION,
      "user-agent": this.requestProfile.clientIdentity.userAgent(),
      "anthropic-beta": this.requestProfile.betas.join(",")
    });
  }

  private renderRequestBody(request: MessageRequest): Record<string, unknown> {
    return buildAnthropicRequestBody(request, this.requestProfile);
  }

  private clone(): MutableAnthropicClient {
    return new MutableAnthropicClient(
      this.auth,
      this.baseUrl,
      this.requestProfile,
      this.sessionTracer,
      this.promptCache,
      undefined
    );
  }
}

/**
 * Incrementally reads SSE from the HTTP body (Rust `MessageStream::next_event` + chunked `response.chunk()`).
 * When `source` is an array, replays pre-buffered events (no-stream fallback).
 */
export class AnthropicMessageStream {
  private readonly parser = new SseParser();
  private readonly pending: StreamEvent[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array> | null;
  private readonly buffered: StreamEvent[] | null;
  private index = 0;

  constructor(
    private readonly requestIdValue: string | undefined,
    source: ReadableStream<Uint8Array> | StreamEvent[]
  ) {
    if (Array.isArray(source)) {
      this.buffered = source;
      this.reader = null;
    } else {
      this.buffered = null;
      this.reader = source.getReader();
    }
  }

  requestId(): string | undefined {
    return this.requestIdValue;
  }

  async nextEvent(): Promise<StreamEvent | undefined> {
    if (this.buffered) {
      const event = this.buffered[this.index];
      this.index += 1;
      return event;
    }

    while (true) {
      if (this.pending.length > 0) {
        return this.pending.shift()!;
      }
      if (!this.reader) {
        return undefined;
      }

      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await this.reader.read();
      } catch (error) {
        throw ApiError.fromHttpError(error);
      }

      if (result.done) {
        this.pending.push(...this.parser.finish());
        this.reader.releaseLock();
        this.reader = null;
        continue;
      }

      if (result.value) {
        this.pending.push(...this.parser.push(result.value));
      }
    }
  }
}

export function buildAuthHeaders(
  auth: AuthSource,
  initialHeaders: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    ...initialHeaders
  };

  if (auth.type === "api_key") {
    headers["x-api-key"] = auth.apiKey;
  } else if (auth.type === "bearer") {
    headers.authorization = `Bearer ${auth.bearerToken}`;
  } else if (auth.type === "api_key_and_bearer") {
    headers["x-api-key"] = auth.apiKey;
    headers.authorization = `Bearer ${auth.bearerToken}`;
  }

  return headers;
}

export function buildAnthropicRequestBody(
  request: MessageRequest,
  requestProfile: AnthropicRequestProfile
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.max_tokens,
    messages: request.messages,
    betas: requestProfile.betas,
    ...requestProfile.extraBody
  };

  if (request.system) {
    body.system = request.system;
  }
  if (request.tools) {
    body.tools = request.tools;
  }
  if (request.tool_choice) {
    body.tool_choice = request.tool_choice;
  }
  if (request.stream) {
    body.stream = true;
  }

  return body;
}

export function readAnthropicBaseUrl(): string {
  return process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL;
}

export function requestIdFromHeaders(headers: Headers): string | undefined {
  return headers.get("request-id") ?? headers.get("x-request-id") ?? undefined;
}

export function isRetryableStatus(status: number): boolean {
  return [408, 409, 429, 500, 502, 503, 504].includes(status);
}

class MutableAnthropicClient extends AnthropicClient {
  constructor(
    auth: AuthSource,
    baseUrl: string,
    requestProfile: AnthropicRequestProfile,
    sessionTracer?: SessionTracer,
    promptCache?: PromptCache,
    lastPromptCacheRecord?: PromptCacheRecord
  ) {
    super(auth.type === "api_key" ? auth.apiKey : "");
    this.authValue = auth;
    this.baseUrlValue = baseUrl;
    this.requestProfileValue = requestProfile;
    this.sessionTracerValue = sessionTracer;
    this.promptCacheValue = promptCache;
    this.lastPromptCacheRecordValue = lastPromptCacheRecord;
  }

  set authValue(auth: AuthSource) {
    Reflect.set(this, "auth", auth);
  }

  set baseUrlValue(baseUrl: string) {
    Reflect.set(this, "baseUrl", baseUrl);
  }

  set requestProfileValue(profile: AnthropicRequestProfile) {
    Reflect.set(this, "requestProfile", profile);
  }

  set sessionTracerValue(sessionTracer: SessionTracer | undefined) {
    Reflect.set(this, "sessionTracer", sessionTracer);
  }

  set promptCacheValue(promptCache: PromptCache | undefined) {
    Reflect.set(this, "promptCache", promptCache);
  }

  set lastPromptCacheRecordValue(record: PromptCacheRecord | undefined) {
    Reflect.set(this, "lastPromptCacheRecord", record);
  }
}

async function parseApiError(response: Response): Promise<ApiError> {
  const body = await response.text();
  let errorType: string | undefined;
  let message: string | undefined;

  try {
    const parsed = JSON.parse(body) as {
      error?: { type?: string; message?: string };
    };
    errorType = parsed.error?.type;
    message = parsed.error?.message;
  } catch {
    // Ignore parse failures and fall back to raw body.
  }

  return ApiError.apiResponse({
    status: response.status,
    errorType,
    message,
    body,
    retryable: isRetryableStatus(response.status)
  });
}
