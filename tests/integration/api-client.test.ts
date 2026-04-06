import { describe, expect, test } from "vitest";

import {
  AnthropicClient,
  ClientIdentity,
  MemoryTelemetrySink,
  ProviderClient,
  SessionTracer
} from "../../src/api";

import { startMockAnthropicServer } from "../helpers/mockAnthropicServer";
import { withEnv } from "../helpers/envGuards";

describe("api client integration", () => {
  test("send_message_posts_json_and_parses_response", async () => {
    const server = await startMockAnthropicServer([
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello from Claude" }],
          model: "claude-3-7-sonnet-latest",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 4 },
          request_id: "req_body_123"
        })
      }
    ]);

    try {
      const client = new AnthropicClient("test-key")
        .withAuthToken("proxy-token")
        .withBaseUrl(server.baseUrl);
      const response = await client.sendMessage(sampleRequest());

      expect(response.id).toBe("msg_test");
      expect(response.request_id).toBe("req_body_123");
      expect(response.content).toEqual([{ type: "text", text: "Hello from Claude" }]);
      expect(response.usage.cache_creation_input_tokens).toBe(0);
      expect(response.usage.cache_read_input_tokens).toBe(0);

      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.method).toBe("POST");
      expect(server.requests[0]?.path).toBe("/v1/messages");
      expect(server.requests[0]?.headers["x-api-key"]).toBe("test-key");
      expect(server.requests[0]?.headers.authorization).toBe("Bearer proxy-token");
      expect(server.requests[0]?.headers["anthropic-version"]).toBe("2023-06-01");
      expect(server.requests[0]?.headers["user-agent"]).toBe("claude-code/0.1.0");
      expect(server.requests[0]?.headers["anthropic-beta"]).toBe(
        "claude-code-20250219,prompt-caching-scope-2026-01-05"
      );

      const body = JSON.parse(server.requests[0]?.body ?? "{}") as Record<string, unknown>;
      expect(body.model).toBe("claude-3-7-sonnet-latest");
      expect(body.stream).toBeUndefined();
      expect(body.tools).toEqual([
        {
          name: "get_weather",
          description: "Fetches the weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"]
          }
        }
      ]);
      expect(body.tool_choice).toEqual({ type: "auto" });
      expect(body.betas).toEqual([
        "claude-code-20250219",
        "prompt-caching-scope-2026-01-05"
      ]);
    } finally {
      await server.close();
    }
  });

  test("send_message_applies_request_profile_and_records_telemetry", async () => {
    const server = await startMockAnthropicServer([
      {
        headers: {
          "content-type": "application/json",
          "request-id": "req_profile_123"
        },
        body: JSON.stringify({
          id: "msg_profile",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-3-7-sonnet-latest",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 1
          }
        })
      }
    ]);

    const sink = new MemoryTelemetrySink();

    try {
      const client = new AnthropicClient("test-key")
        .withBaseUrl(server.baseUrl)
        .withClientIdentity(new ClientIdentity("claude-code", "9.9.9").withRuntime("rust-cli"))
        .withBeta("tools-2026-04-01")
        .withExtraBodyParam("metadata", { source: "clench-code" })
        .withSessionTracer(new SessionTracer("session-telemetry", sink));

      const response = await client.sendMessage(sampleRequest());

      expect(response.request_id).toBe("req_profile_123");
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.headers["anthropic-beta"]).toBe(
        "claude-code-20250219,prompt-caching-scope-2026-01-05,tools-2026-04-01"
      );
      expect(server.requests[0]?.headers["user-agent"]).toBe("claude-code/9.9.9");

      const body = JSON.parse(server.requests[0]?.body ?? "{}") as Record<string, unknown>;
      expect(body.metadata).toEqual({ source: "clench-code" });
      expect(body.betas).toEqual([
        "claude-code-20250219",
        "prompt-caching-scope-2026-01-05",
        "tools-2026-04-01"
      ]);

      expect(sink.events()).toEqual([
        {
          kind: "http_request_started",
          sessionId: "session-telemetry",
          attempt: 1,
          method: "POST",
          path: "/v1/messages"
        },
        {
          kind: "session_trace",
          sessionId: "session-telemetry",
          name: "http_request_started",
          sequence: 0,
          payload: {
            attempt: 1,
            method: "POST",
            path: "/v1/messages"
          }
        },
        {
          kind: "http_request_succeeded",
          sessionId: "session-telemetry",
          attempt: 1,
          method: "POST",
          path: "/v1/messages",
          status: 200,
          requestId: "req_profile_123"
        },
        {
          kind: "session_trace",
          sessionId: "session-telemetry",
          name: "http_request_succeeded",
          sequence: 1,
          payload: {
            attempt: 1,
            method: "POST",
            path: "/v1/messages",
            status: 200,
            requestId: "req_profile_123"
          }
        },
        {
          kind: "analytics",
          namespace: "api",
          action: "message_usage",
          properties: {
            request_id: "req_profile_123",
            total_tokens: 7,
            estimated_cost_usd: "$0.0001"
          }
        },
        {
          kind: "session_trace",
          sessionId: "session-telemetry",
          name: "analytics",
          sequence: 2,
          payload: {
            request_id: "req_profile_123",
            total_tokens: 7,
            estimated_cost_usd: "$0.0001"
          }
        }
      ]);
    } finally {
      await server.close();
    }
  });

  test("stream_message_posts_stream_true_and_parses_sse_events", async () => {
    const sseBody = [
      'data: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant","content":[],"model":"claude-3-7-sonnet-latest","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
      "",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":1,"output_tokens":2}}',
      "",
      'data: {"type":"message_stop"}',
      ""
    ].join("\n");

    const server = await startMockAnthropicServer([
      {
        headers: {
          "content-type": "text/event-stream",
          "request-id": "req_stream_1"
        },
        body: sseBody
      }
    ]);

    try {
      const client = new AnthropicClient("test-key").withBaseUrl(server.baseUrl);
      const stream = await client.streamMessage(sampleRequest());

      expect(stream.requestId()).toBe("req_stream_1");

      const e0 = await stream.nextEvent();
      expect(e0?.type).toBe("message_start");
      if (e0?.type === "message_start") {
        expect(e0.message.id).toBe("msg_stream");
      }

      const e1 = await stream.nextEvent();
      expect(e1?.type).toBe("message_delta");
      if (e1?.type === "message_delta") {
        expect(e1.delta.stop_reason).toBe("end_turn");
        expect(e1.usage.output_tokens).toBe(2);
      }

      const e2 = await stream.nextEvent();
      expect(e2?.type).toBe("message_stop");

      expect(await stream.nextEvent()).toBeUndefined();

      expect(server.requests).toHaveLength(1);
      const body = JSON.parse(server.requests[0]?.body ?? "{}") as Record<string, unknown>;
      expect(body.stream).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("provider_client_stream_message_delegates_to_anthropic", async () => {
    const sseBody = [
      'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"claude-3-7-sonnet-latest","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}',
      "",
      'data: {"type":"message_stop"}',
      ""
    ].join("\n");

    const server = await startMockAnthropicServer([
      {
        headers: { "content-type": "text/event-stream" },
        body: sseBody
      }
    ]);

    try {
      await withEnv({ ANTHROPIC_BASE_URL: server.baseUrl }, async () => {
        const client = await ProviderClient.fromModelWithAnthropicAuth("claude-sonnet-4-6", {
          type: "api_key",
          apiKey: "k"
        });
        const stream = await client.streamMessage(sampleRequest());
        expect(await stream.nextEvent()).toMatchObject({ type: "message_start" });
        expect(await stream.nextEvent()).toMatchObject({ type: "message_stop" });
      });
    } finally {
      await server.close();
    }
  });

  test("send_message_parses_prompt_cache_token_usage_from_response", async () => {
    const server = await startMockAnthropicServer([
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "msg_cache_tokens",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Cache tokens" }],
          model: "claude-3-7-sonnet-latest",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 5
          }
        })
      }
    ]);

    try {
      const client = new AnthropicClient("test-key").withBaseUrl(server.baseUrl);
      const response = await client.sendMessage(sampleRequest());

      expect(response.usage.input_tokens).toBe(10);
      expect(response.usage.cache_creation_input_tokens).toBe(20);
      expect(response.usage.cache_read_input_tokens).toBe(30);
      expect(response.usage.output_tokens).toBe(5);
    } finally {
      await server.close();
    }
  });
});

function sampleRequest() {
  return {
    model: "claude-3-7-sonnet-latest",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Say hello" },
          {
            type: "tool_result",
            tool_use_id: "toolu_prev",
            content: [{ type: "json", value: { forecast: "sunny" } }],
            is_error: false
          }
        ]
      }
    ],
    system: "Use tools when needed",
    tools: [
      {
        name: "get_weather",
        description: "Fetches the weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"]
        }
      }
    ],
    tool_choice: { type: "auto" as const }
  };
}
