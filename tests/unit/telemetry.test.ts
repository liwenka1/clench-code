import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  AnthropicRequestProfile,
  ClientIdentity,
  JsonlTelemetrySink,
  MemoryTelemetrySink,
  SessionTracer
} from "../../src/api/index.js";

describe("telemetry library", () => {
  test("request_profile_emits_headers_and_merges_body", async () => {
    const profile = new AnthropicRequestProfile({
      clientIdentity: new ClientIdentity("claude-code", "1.2.3").withRuntime("rust-cli")
    })
      .withBeta("tools-2026-04-01")
      .withExtraBody("metadata", { source: "test" });

    expect(profile.clientIdentity.userAgent()).toBe("claude-code/1.2.3");
    expect(profile.betas).toContain("tools-2026-04-01");
    expect(profile.extraBody).toEqual({
      metadata: { source: "test" }
    });
  });

  test("session_tracer_records_structured_events_and_trace_sequence", async () => {
    const sink = new MemoryTelemetrySink();
    const tracer = new SessionTracer("session-123", sink);

    tracer.recordHttpRequestStarted(1, "POST", "/v1/messages");
    tracer.recordHttpRequestFailed(1, "POST", "/v1/messages", "api returned 429", true);
    tracer.recordAnalytics({
      kind: "analytics",
      namespace: "cli",
      action: "prompt_sent",
      properties: { model: "claude-opus" }
    });

    const events = sink.events();
    expect(events[0]).toMatchObject({
      kind: "http_request_started",
      sessionId: "session-123",
      attempt: 1,
      method: "POST",
      path: "/v1/messages"
    });
    expect(events[1]).toMatchObject({
      kind: "session_trace",
      name: "http_request_started",
      sequence: 0
    });
    expect(events[2]).toMatchObject({
      kind: "http_request_failed",
      sessionId: "session-123",
      attempt: 1,
      retryable: true
    });
    expect(events[3]).toMatchObject({
      kind: "session_trace",
      name: "http_request_failed",
      sequence: 1
    });
    expect(events[4]).toMatchObject({
      kind: "analytics",
      action: "prompt_sent"
    });
    expect(events[5]).toMatchObject({
      kind: "session_trace",
      name: "analytics",
      sequence: 2
    });
  });

  test("jsonl_sink_persists_events", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "telemetry-jsonl-"));
    const filePath = path.join(root, "telemetry.log");
    const sink = new JsonlTelemetrySink(filePath);

    sink.record({
      kind: "analytics",
      namespace: "cli",
      action: "turn_completed",
      properties: { ok: true }
    });

    const contents = readFileSync(filePath, "utf8");
    expect(contents).toContain('"kind":"analytics"');
    expect(contents).toContain('"action":"turn_completed"');

    rmSync(root, { recursive: true, force: true });
  });
});
