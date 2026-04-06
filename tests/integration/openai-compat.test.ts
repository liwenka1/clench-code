import { describe, expect, test } from "vitest";

import {
  OpenAiCompatClient,
  OpenAiCompatConfig
} from "../../src/api";

import { startMockAnthropicServer } from "../helpers/mockAnthropicServer";

describe("openai compatible api integration", () => {
  test("send_message_uses_openai_compatible_endpoint_and_auth", async () => {
    const server = await startMockAnthropicServer([
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "chatcmpl_test",
          model: "grok-3",
          choices: [
            {
              message: { role: "assistant", content: "Hello from Grok", tool_calls: [] },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 11, completion_tokens: 5 }
        })
      }
    ]);

    try {
      const client = new OpenAiCompatClient("xai-test-key", OpenAiCompatConfig.xai()).withBaseUrl(
        server.baseUrl
      );
      const response = await client.sendMessage(sampleRequest(false));

      expect(response.model).toBe("grok-3");
      expect(response.content).toEqual([{ type: "text", text: "Hello from Grok" }]);
      expect(response.usage.input_tokens).toBe(11);
      expect(response.usage.output_tokens).toBe(5);

      expect(server.requests[0]?.path).toBe("/chat/completions");
      expect(server.requests[0]?.headers.authorization).toBe("Bearer xai-test-key");

      const body = JSON.parse(server.requests[0]?.body ?? "{}") as Record<string, unknown>;
      expect(body.model).toBe("grok-3");
      expect(body.messages).toMatchObject([
        { role: "system", content: "Use tools when needed" },
        { role: "user", content: "Say hello" }
      ]);
      expect(body.tools).toEqual([
        {
          type: "function",
          function: {
            name: "weather",
            description: "Fetches weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"]
            }
          }
        }
      ]);
    } finally {
      await server.close();
    }
  });

  test("send_message_accepts_full_chat_completions_endpoint_override", async () => {
    const server = await startMockAnthropicServer([
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "chatcmpl_full_endpoint",
          model: "grok-3",
          choices: [
            {
              message: { role: "assistant", content: "Endpoint override works", tool_calls: [] },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3 }
        })
      }
    ]);

    try {
      const endpointUrl = `${server.baseUrl}/chat/completions`;
      const client = new OpenAiCompatClient("xai-test-key", OpenAiCompatConfig.xai()).withBaseUrl(
        endpointUrl
      );
      const response = await client.sendMessage(sampleRequest(false));

      expect(response.usage.input_tokens + response.usage.output_tokens).toBe(10);
      expect(server.requests[0]?.path).toBe("/chat/completions");
    } finally {
      await server.close();
    }
  });

  test("stream_message_normalizes_text_and_multiple_tool_calls", async () => {
    const server = await startMockAnthropicServer([
      {
        headers: { "content-type": "text/event-stream", "x-request-id": "req_grok_stream" },
        body: [
          "data: {\"id\":\"chatcmpl_stream\",\"model\":\"grok-3\",\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}",
          "",
          "data: {\"id\":\"chatcmpl_stream\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"city\\\":\\\"Paris\\\"}\"}},{\"index\":1,\"id\":\"call_2\",\"function\":{\"name\":\"clock\",\"arguments\":\"{\\\"zone\\\":\\\"UTC\\\"}\"}}]}}]}",
          "",
          "data: {\"id\":\"chatcmpl_stream\",\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}",
          "",
          "data: [DONE]",
          ""
        ].join("\n")
      }
    ]);

    try {
      const client = new OpenAiCompatClient("xai-test-key", OpenAiCompatConfig.xai()).withBaseUrl(
        server.baseUrl
      );
      const stream = await client.streamMessage(sampleRequest(false));

      expect(stream.requestId()).toBe("req_grok_stream");

      const events = await collectEvents(stream);
      expect(events).toEqual([
        {
          type: "message_start",
          message: {
            id: "chatcmpl_stream",
            type: "message",
            role: "assistant",
            content: [],
            model: "grok-3",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            request_id: undefined
          }
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" }
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" }
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "call_1", name: "weather", input: {} }
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: "{\"city\":\"Paris\"}" }
        },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "call_2", name: "clock", input: {} }
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: "{\"zone\":\"UTC\"}" }
        },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_stop", index: 2 },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { input_tokens: 0, output_tokens: 0 }
        },
        { type: "message_stop" }
      ]);

      expect(server.requests[0]?.path).toBe("/chat/completions");
      expect(server.requests[0]?.body).toContain("\"stream\":true");
    } finally {
      await server.close();
    }
  });

  test("openai_streaming_requests_opt_into_usage_chunks", async () => {
    const server = await startMockAnthropicServer([
      {
        headers: { "content-type": "text/event-stream", "x-request-id": "req_openai_stream" },
        body: [
          "data: {\"id\":\"chatcmpl_openai_stream\",\"model\":\"gpt-5\",\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}",
          "",
          "data: {\"id\":\"chatcmpl_openai_stream\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}",
          "",
          "data: {\"id\":\"chatcmpl_openai_stream\",\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4}}",
          "",
          "data: [DONE]",
          ""
        ].join("\n")
      }
    ]);

    try {
      const client = new OpenAiCompatClient(
        "openai-test-key",
        OpenAiCompatConfig.openai()
      ).withBaseUrl(server.baseUrl);
      const stream = await client.streamMessage({
        ...sampleRequest(false),
        model: "gpt-5"
      });

      expect(stream.requestId()).toBe("req_openai_stream");
      const events = await collectEvents(stream);
      expect(events).toEqual([
        {
          type: "message_start",
          message: {
            id: "chatcmpl_openai_stream",
            type: "message",
            role: "assistant",
            content: [],
            model: "gpt-5",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            request_id: undefined
          }
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" }
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" }
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: 9, output_tokens: 4 }
        },
        { type: "message_stop" }
      ]);

      const body = JSON.parse(server.requests[0]?.body ?? "{}") as Record<string, unknown>;
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
    } finally {
      await server.close();
    }
  });
});

function sampleRequest(stream: boolean) {
  return {
    model: "grok-3",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [{ type: "text" as const, text: "Say hello" }]
      }
    ],
    system: "Use tools when needed",
    tools: [
      {
        name: "weather",
        description: "Fetches weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"]
        }
      }
    ],
    tool_choice: { type: "auto" as const },
    stream
  };
}

async function collectEvents(stream: {
  nextEvent(): Promise<unknown>;
}): Promise<unknown[]> {
  const events: unknown[] = [];

  while (true) {
    const event = await stream.nextEvent();
    if (!event) {
      return events;
    }
    events.push(event);
  }
}
