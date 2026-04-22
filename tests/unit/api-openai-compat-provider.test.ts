import { describe, expect, test } from "vitest";

import {
  ApiError,
  OpenAiCompatClient,
  OpenAiCompatConfig,
  buildChatCompletionRequest,
  chatCompletionsEndpoint,
  hasOpenAiCompatApiKey,
  normalizeFinishReason,
  openAiToolChoice,
  parseToolArguments
} from "../../src/api";
import { withEnv } from "../helpers/envGuards";

describe("api openai compat provider", () => {
  test("ports OpenAI-compatible provider helper behavior", async () => {
    const payload = buildChatCompletionRequest(sampleRequest("grok-3", false), OpenAiCompatConfig.xai());

    expect(payload.messages).toMatchObject([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hello" },
      { role: "tool", tool_call_id: "tool_1", content: '{"ok":true}', is_error: false }
    ]);
    expect(payload.tools).toEqual([
      {
        type: "function",
        function: {
          name: "weather",
          description: "Get weather",
          parameters: { type: "object" }
        }
      }
    ]);
    expect(payload.tool_choice).toBe("auto");

    const openaiStreaming = buildChatCompletionRequest(
      sampleRequest("gpt-5", true),
      OpenAiCompatConfig.openai()
    );
    expect(openaiStreaming.stream_options).toEqual({ include_usage: true });

    const xaiStreaming = buildChatCompletionRequest(
      sampleRequest("grok-3", true),
      OpenAiCompatConfig.xai()
    );
    expect(xaiStreaming.stream_options).toBeUndefined();

    expect(openAiToolChoice({ type: "any" })).toBe("required");
    expect(openAiToolChoice({ type: "tool", name: "weather" })).toEqual({
      type: "function",
      function: { name: "weather" }
    });

    expect(parseToolArguments('{"city":"Paris"}')).toEqual({ city: "Paris" });
    expect(parseToolArguments("not-json")).toEqual({ raw: "not-json" });

    await withEnv({ XAI_API_KEY: undefined }, async () => {
      expect(() => OpenAiCompatClient.fromEnv(OpenAiCompatConfig.xai())).toThrowError(ApiError);
    });

    expect(chatCompletionsEndpoint("https://api.x.ai/v1")).toBe(
      "https://api.x.ai/v1/chat/completions"
    );
    expect(chatCompletionsEndpoint("https://api.x.ai/v1/")).toBe(
      "https://api.x.ai/v1/chat/completions"
    );
    expect(chatCompletionsEndpoint("https://api.x.ai/v1/chat/completions")).toBe(
      "https://api.x.ai/v1/chat/completions"
    );

    expect(normalizeFinishReason("stop")).toBe("end_turn");
    expect(normalizeFinishReason("tool_calls")).toBe("tool_use");
  });

  test("helpers_passthrough_finish_reason_auto_tool_choice_empty_args_and_api_key_probe", async () => {
    expect(normalizeFinishReason("length")).toBe("length");
    expect(normalizeFinishReason("content_filter")).toBe("content_filter");

    expect(openAiToolChoice({ type: "auto" })).toBe("auto");

    expect(parseToolArguments("")).toEqual({ raw: "" });

    await withEnv({ OPENAI_API_KEY: "" }, async () => {
      expect(hasOpenAiCompatApiKey("OPENAI_API_KEY")).toBe(false);
    });
    await withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
      expect(hasOpenAiCompatApiKey("OPENAI_API_KEY")).toBe(true);
    });
  });

  test("preserves assistant history and tool calls in chat-completions payload", () => {
    const payload = buildChatCompletionRequest(
      {
        model: "gpt-5",
        max_tokens: 64,
        system: "act like an agent",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "I'll inspect the workspace." },
              {
                type: "tool_use",
                id: "call_1",
                name: "read_file",
                input: { filePath: "/tmp/demo.ts", startLine: 1, endLine: 20 }
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_1",
                content: [{ type: "text", text: "const value = 1;" }],
                is_error: false
              }
            ]
          }
        ],
        stream: false
      },
      OpenAiCompatConfig.openai()
    );

    expect(payload.messages).toMatchObject([
      { role: "system", content: "act like an agent" },
      {
        role: "assistant",
        content: "I'll inspect the workspace.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ filePath: "/tmp/demo.ts", startLine: 1, endLine: 20 })
            }
          }
        ]
      },
      { role: "tool", tool_call_id: "call_1", content: "const value = 1;", is_error: false }
    ]);
  });
});

function sampleRequest(model: string, stream: boolean) {
  return {
    model,
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          { type: "text" as const, text: "hello" },
          {
            type: "tool_result" as const,
            tool_use_id: "tool_1",
            content: [{ type: "json" as const, value: { ok: true } }],
            is_error: false
          }
        ]
      }
    ],
    system: "be helpful",
    tools: [
      {
        name: "weather",
        description: "Get weather",
        input_schema: { type: "object" }
      }
    ],
    tool_choice: { type: "auto" as const },
    stream
  };
}
