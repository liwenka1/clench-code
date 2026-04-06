import fs from "node:fs";

import { totalTokens, type MessageResponse } from "./types";

export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_BETAS = [
  "claude-code-20250219",
  "prompt-caching-scope-2026-01-05"
] as const;

export interface AnalyticsEvent {
  kind: "analytics";
  namespace: string;
  action: string;
  properties: Record<string, unknown>;
}

export interface HttpRequestStartedEvent {
  kind: "http_request_started";
  sessionId: string;
  attempt: number;
  method: string;
  path: string;
}

export interface HttpRequestSucceededEvent {
  kind: "http_request_succeeded";
  sessionId: string;
  attempt: number;
  method: string;
  path: string;
  status: number;
  requestId?: string;
}

export interface HttpRequestFailedEvent {
  kind: "http_request_failed";
  sessionId: string;
  attempt: number;
  method: string;
  path: string;
  message: string;
  retryable: boolean;
}

export interface SessionTraceEvent {
  kind: "session_trace";
  sessionId: string;
  name: string;
  payload: Record<string, unknown>;
  sequence: number;
}

export type TelemetryEvent =
  | HttpRequestStartedEvent
  | HttpRequestSucceededEvent
  | HttpRequestFailedEvent
  | AnalyticsEvent
  | SessionTraceEvent;

export interface TelemetrySink {
  record(event: TelemetryEvent): void;
}

export class MemoryTelemetrySink implements TelemetrySink {
  private readonly recorded: TelemetryEvent[] = [];

  record(event: TelemetryEvent): void {
    this.recorded.push(event);
  }

  events(): TelemetryEvent[] {
    return [...this.recorded];
  }
}

export class JsonlTelemetrySink implements TelemetrySink {
  constructor(readonly path: string) {
    fs.mkdirSync(requireParent(path), { recursive: true });
  }

  record(event: TelemetryEvent): void {
    fs.appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}

export class ClientIdentity {
  constructor(
    readonly name: string,
    readonly version: string,
    readonly runtime?: string
  ) {}

  withRuntime(runtime: string): ClientIdentity {
    return new ClientIdentity(this.name, this.version, runtime);
  }

  userAgent(): string {
    return `${this.name}/${this.version}`;
  }
}

export class AnthropicRequestProfile {
  readonly clientIdentity: ClientIdentity;
  readonly betas: string[];
  readonly extraBody: Record<string, unknown>;

  constructor(options?: {
    clientIdentity?: ClientIdentity;
    betas?: string[];
    extraBody?: Record<string, unknown>;
  }) {
    this.clientIdentity =
      options?.clientIdentity ?? new ClientIdentity("claude-code", "0.1.0");
    this.betas = options?.betas ?? [...DEFAULT_BETAS];
    this.extraBody = options?.extraBody ?? {};
  }

  withClientIdentity(clientIdentity: ClientIdentity): AnthropicRequestProfile {
    return new AnthropicRequestProfile({
      clientIdentity,
      betas: this.betas,
      extraBody: this.extraBody
    });
  }

  withBeta(beta: string): AnthropicRequestProfile {
    return new AnthropicRequestProfile({
      clientIdentity: this.clientIdentity,
      betas: [...this.betas, beta],
      extraBody: this.extraBody
    });
  }

  withExtraBody(key: string, value: unknown): AnthropicRequestProfile {
    return new AnthropicRequestProfile({
      clientIdentity: this.clientIdentity,
      betas: this.betas,
      extraBody: {
        ...this.extraBody,
        [key]: value
      }
    });
  }
}

export class SessionTracer {
  private sequence = 0;

  constructor(
    readonly sessionId: string,
    private readonly sink: TelemetrySink
  ) {}

  recordHttpRequestStarted(attempt: number, method: string, path: string): void {
    this.sink.record({
      kind: "http_request_started",
      sessionId: this.sessionId,
      attempt,
      method,
      path
    });
    this.record("http_request_started", { attempt, method, path });
  }

  record(name: string, payload: Record<string, unknown>): void {
    this.sink.record({
      kind: "session_trace",
      sessionId: this.sessionId,
      name,
      payload,
      sequence: this.sequence++
    });
  }

  recordHttpRequestSucceeded(
    attempt: number,
    method: string,
    path: string,
    status: number,
    requestId?: string
  ): void {
    this.sink.record({
      kind: "http_request_succeeded",
      sessionId: this.sessionId,
      attempt,
      method,
      path,
      status,
      requestId
    });
    this.record("http_request_succeeded", { attempt, method, path, status, requestId });
  }

  recordHttpRequestFailed(
    attempt: number,
    method: string,
    path: string,
    message: string,
    retryable: boolean
  ): void {
    this.sink.record({
      kind: "http_request_failed",
      sessionId: this.sessionId,
      attempt,
      method,
      path,
      message,
      retryable
    });
    this.record("http_request_failed", { attempt, method, path, message, retryable });
  }

  recordAnalytics(event: AnalyticsEvent): void {
    this.sink.record(event);
    this.record("analytics", event.properties);
  }
}

export function estimateCostUsd(response: MessageResponse): number {
  return totalTokens(response.usage) * 0.00001;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function requireParent(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "." : normalized.slice(0, index) || ".";
}
