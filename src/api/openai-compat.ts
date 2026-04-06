import { ANTHROPIC_DEFAULT_MAX_RETRIES, anthropicBackoffMsForAttempt } from "./client";
import { ApiError } from "./error";
import type {
  ContentBlockDeltaEvent,
  ContentBlockStartEvent,
  ContentBlockStopEvent,
  MessageDeltaEvent,
  MessageRequest,
  MessageResponse,
  MessageStartEvent,
  MessageStopEvent,
  OutputContentBlock,
  StreamEvent,
  ToolChoice,
  ToolDefinition,
  ToolResultContentBlock,
  Usage
} from "./types";
import { withStreaming } from "./types";

export const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OpenAiCompatConfig {
  providerName: "xAI" | "OpenAI";
  apiKeyEnv: "XAI_API_KEY" | "OPENAI_API_KEY";
  baseUrlEnv: "XAI_BASE_URL" | "OPENAI_BASE_URL";
  defaultBaseUrl: string;
}

/** Non-empty env value, matching Rust `openai_compat::has_api_key`. */
export function hasOpenAiCompatApiKey(envName: "OPENAI_API_KEY" | "XAI_API_KEY"): boolean {
  const value = process.env[envName];
  return typeof value === "string" && value.trim().length > 0;
}

export const OpenAiCompatConfig = {
  xai(): OpenAiCompatConfig {
    return {
      providerName: "xAI",
      apiKeyEnv: "XAI_API_KEY",
      baseUrlEnv: "XAI_BASE_URL",
      defaultBaseUrl: DEFAULT_XAI_BASE_URL
    };
  },
  openai(): OpenAiCompatConfig {
    return {
      providerName: "OpenAI",
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrlEnv: "OPENAI_BASE_URL",
      defaultBaseUrl: DEFAULT_OPENAI_BASE_URL
    };
  }
};

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface ChatCompletionResponse {
  id: string;
  model?: string;
  choices: Array<{
    message: {
      role: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAiUsage;
}

interface ChatCompletionChunk {
  id: string;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAiUsage;
}

export class OpenAiCompatClient {
  constructor(
    private readonly apiKey: string,
    private readonly config: OpenAiCompatConfig,
    private readonly baseUrl = readBaseUrl(config)
  ) {}

  static fromEnv(config: OpenAiCompatConfig): OpenAiCompatClient {
    const apiKey = process.env[config.apiKeyEnv];
    if (!apiKey) {
      throw ApiError.missingCredentials(config.providerName, [config.apiKeyEnv]);
    }
    return new OpenAiCompatClient(apiKey, config);
  }

  withBaseUrl(baseUrl: string): OpenAiCompatClient {
    return new OpenAiCompatClient(this.apiKey, this.config, baseUrl);
  }

  private async sendRawRequest(request: MessageRequest): Promise<Response> {
    return fetch(chatCompletionsEndpoint(this.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(buildChatCompletionRequest(request, this.config))
    });
  }

  /** Rust `OpenAiCompatClient::send_with_retry` (same backoff as Anthropic). */
  private async sendWithRetry(request: MessageRequest): Promise<Response> {
    const maxRetries = ANTHROPIC_DEFAULT_MAX_RETRIES;

    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.sendRawRequest(request);
      } catch (error) {
        const err = error instanceof ApiError ? error : ApiError.fromHttpError(error);
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
        return response;
      }

      const err = await parseApiError(response);
      if (!err.isRetryable() || attempt > maxRetries + 1) {
        throw err;
      }
      if (attempt > maxRetries) {
        throw ApiError.retriesExhausted(attempt, err);
      }
      await sleep(anthropicBackoffMsForAttempt(attempt));
    }
  }

  async sendMessage(request: MessageRequest): Promise<MessageResponse> {
    const response = await this.sendWithRetry({ ...request, stream: false });

    const requestId = requestIdFromHeaders(response.headers);
    let payload: ChatCompletionResponse;
    try {
      payload = (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      throw ApiError.fromJsonError(error);
    }

    const normalized = normalizeResponse(request.model, payload);
    if (requestId) {
      normalized.request_id = requestId;
    }
    return normalized;
  }

  async streamMessage(request: MessageRequest): Promise<OpenAiMessageStream> {
    const response = await this.sendWithRetry(withStreaming(request));

    const requestId = requestIdFromHeaders(response.headers);
    const model = request.model;

    if (!response.body) {
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw ApiError.fromHttpError(error);
      }
      const parser = new OpenAiSseParser();
      const chunks = [...parser.push(text), ...parser.finish()];
      return new OpenAiMessageStream(requestId, model, normalizeStreamEvents(model, chunks));
    }

    return new OpenAiMessageStream(requestId, model, response.body);
  }
}

/**
 * Reads the chat-completions SSE body incrementally (Rust streams `response.chunk()`),
 * then normalizes to Anthropic-shaped `StreamEvent`s on first `nextEvent` consumption.
 */
export class OpenAiMessageStream {
  private index = 0;
  private events: StreamEvent[] | null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null;
  private readonly parser = new OpenAiSseParser();

  constructor(
    private readonly requestIdValue: string | undefined,
    private readonly model: string,
    source: ReadableStream<Uint8Array> | StreamEvent[]
  ) {
    if (Array.isArray(source)) {
      this.events = source;
      this.reader = null;
    } else {
      this.events = null;
      this.reader = source.getReader();
    }
  }

  requestId(): string | undefined {
    return this.requestIdValue;
  }

  async nextEvent(): Promise<StreamEvent | undefined> {
    if (this.events === null) {
      await this.drainSseBody();
    }
    const event = this.events![this.index];
    this.index += 1;
    return event;
  }

  private async drainSseBody(): Promise<void> {
    const all: ChatCompletionChunk[] = [];
    while (this.reader) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await this.reader.read();
      } catch (error) {
        throw ApiError.fromHttpError(error);
      }
      if (result.done) {
        all.push(...this.parser.finish());
        this.reader.releaseLock();
        this.reader = null;
        break;
      }
      if (result.value) {
        const text = new TextDecoder().decode(result.value);
        all.push(...this.parser.push(text));
      }
    }
    this.events = normalizeStreamEvents(this.model, all);
  }
}

class OpenAiSseParser {
  private buffer = "";

  push(chunk: string): ChatCompletionChunk[] {
    this.buffer += chunk;
    const events: ChatCompletionChunk[] = [];

    while (true) {
      const next = nextFrame(this.buffer);
      if (!next) {
        break;
      }

      this.buffer = next.rest;
      const parsed = parseSseFrame(next.frame);
      if (parsed) {
        events.push(parsed);
      }
    }

    return events;
  }

  finish(): ChatCompletionChunk[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const trailing = this.buffer;
    this.buffer = "";
    const parsed = parseSseFrame(trailing);
    return parsed ? [parsed] : [];
  }
}

function parseSseFrame(frame: string): ChatCompletionChunk | null {
  const trimmed = frame.trim();
  if (!trimmed) {
    return null;
  }

  const dataLines: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const payload = dataLines.join("\n");
  if (payload === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(payload) as ChatCompletionChunk;
  } catch (error) {
    throw ApiError.invalidSseFrame("json parse failed", error);
  }
}

function normalizeStreamEvents(model: string, chunks: ChatCompletionChunk[]): StreamEvent[] {
  if (chunks.length === 0) {
    return [];
  }

  const firstChunk = chunks[0]!;
  const events: StreamEvent[] = [];
  const toolStates = new Map<number, { id?: string; name?: string; args: string }>();
  let textStarted = false;
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = "end_turn";

  const messageStart: MessageStartEvent = {
    type: "message_start",
    message: {
      id: firstChunk.id,
      type: "message",
      role: "assistant",
      content: [],
      model: firstChunk.model || model,
      stop_reason: null,
      stop_sequence: null,
      usage,
      request_id: undefined
    }
  };
  events.push(messageStart);

  for (const chunk of chunks) {
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens ?? 0,
        output_tokens: chunk.usage.completion_tokens ?? 0
      };
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};

      if (delta.content) {
        if (!textStarted) {
          textStarted = true;
          const start: ContentBlockStartEvent = {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" }
          };
          events.push(start);
        }

        const textDelta: ContentBlockDeltaEvent = {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: delta.content
          }
        };
        events.push(textDelta);
      }

      for (const toolCall of delta.tool_calls ?? []) {
        const index = toolCall.index ?? 0;
        const existing = toolStates.get(index) ?? { args: "" };
        existing.id = toolCall.id ?? existing.id;
        existing.name = toolCall.function?.name ?? existing.name;
        existing.args += toolCall.function?.arguments ?? "";
        const firstTime = !toolStates.has(index);
        toolStates.set(index, existing);

        if (firstTime && existing.name) {
          const start: ContentBlockStartEvent = {
            type: "content_block_start",
            index: index + 1,
            content_block: {
              type: "tool_use",
              id: existing.id ?? `tool_call_${index}`,
              name: existing.name,
              input: {}
            }
          };
          events.push(start);
        }

        if (toolCall.function?.arguments) {
          const deltaEvent: ContentBlockDeltaEvent = {
            type: "content_block_delta",
            index: index + 1,
            delta: {
              type: "input_json_delta",
              partial_json: toolCall.function.arguments
            }
          };
          events.push(deltaEvent);
        }
      }

      if (choice.finish_reason) {
        stopReason = normalizeFinishReason(choice.finish_reason);
      }
    }
  }

  if (stopReason === "tool_use") {
    for (const index of [...toolStates.keys()].sort((a, b) => a - b)) {
      const stop: ContentBlockStopEvent = {
        type: "content_block_stop",
        index: index + 1
      };
      events.push(stop);
    }
  }

  if (textStarted) {
    events.push({
      type: "content_block_stop",
      index: 0
    } satisfies ContentBlockStopEvent);
  }

  events.push({
    type: "message_delta",
    delta: {
      stop_reason: stopReason,
      stop_sequence: null
    },
    usage
  } satisfies MessageDeltaEvent);
  events.push({ type: "message_stop" } satisfies MessageStopEvent);

  return events;
}

function normalizeResponse(model: string, response: ChatCompletionResponse): MessageResponse {
  const choice = response.choices[0];
  if (!choice) {
    throw ApiError.invalidSseFrame("chat completion response missing choices");
  }

  const content: OutputContentBlock[] = [];
  if (choice.message.content) {
    content.push({
      type: "text",
      text: choice.message.content
    });
  }

  for (const toolCall of choice.message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input: parseToolArguments(toolCall.function.arguments)
    });
  }

  return {
    id: response.id,
    type: "message",
    role: choice.message.role,
    content,
    model: response.model || model,
    stop_reason: choice.finish_reason ? normalizeFinishReason(choice.finish_reason) : null,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0
    }
  };
}

export function buildChatCompletionRequest(
  request: MessageRequest,
  config: OpenAiCompatConfig
): Record<string, unknown> {
  const messages: unknown[] = [];

  if (request.system) {
    messages.push({
      role: "system",
      content: request.system
    });
  }

  for (const message of request.messages) {
    messages.push(...translateMessage(message));
  }

  const payload: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.max_tokens,
    messages
  };

  if (request.stream) {
    payload.stream = true;
    if (config.providerName === "OpenAI") {
      payload.stream_options = { include_usage: true };
    }
  }

  if (request.tools) {
    payload.tools = request.tools.map(openAiToolDefinition);
  }
  if (request.tool_choice) {
    payload.tool_choice = openAiToolChoice(request.tool_choice);
  }

  return payload;
}

function translateMessage(message: MessageRequest["messages"][number]): unknown[] {
  if (message.role === "assistant") {
    return [];
  }

  return message.content.flatMap((block) => {
    if (block.type === "text") {
      return [{ role: "user", content: block.text }];
    }

    if (block.type === "tool_result") {
      return [
        {
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: flattenToolResultContent(block.content),
          is_error: block.is_error ?? false
        }
      ];
    }

    return [];
  });
}

function flattenToolResultContent(content: ToolResultContentBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : JSON.stringify(block.value)))
    .join("\n");
}

export function openAiToolDefinition(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema
    }
  };
}

export function openAiToolChoice(toolChoice: ToolChoice): unknown {
  if (toolChoice.type === "auto") {
    return "auto";
  }
  if (toolChoice.type === "any") {
    return "required";
  }
  return {
    type: "function",
    function: {
      name: toolChoice.name
    }
  };
}

export function parseToolArguments(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText);
  } catch {
    return { raw: argumentsText };
  }
}

export function normalizeFinishReason(value: string): string {
  if (value === "stop") {
    return "end_turn";
  }
  if (value === "tool_calls") {
    return "tool_use";
  }
  return value;
}

export function readBaseUrl(config: OpenAiCompatConfig): string {
  return process.env[config.baseUrlEnv] || config.defaultBaseUrl;
}

export function chatCompletionsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
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
    // Ignore parse failure.
  }

  return ApiError.apiResponse({
    status: response.status,
    errorType,
    message,
    body,
    retryable: [408, 409, 429, 500, 502, 503, 504].includes(response.status)
  });
}

function requestIdFromHeaders(headers: Headers): string | undefined {
  return headers.get("request-id") ?? headers.get("x-request-id") ?? undefined;
}

function nextFrame(buffer: string): { frame: string; rest: string } | null {
  const newlineIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");

  if (newlineIndex === -1 && crlfIndex === -1) {
    return null;
  }

  if (newlineIndex !== -1 && (crlfIndex === -1 || newlineIndex < crlfIndex)) {
    return {
      frame: buffer.slice(0, newlineIndex),
      rest: buffer.slice(newlineIndex + 2)
    };
  }

  return {
    frame: buffer.slice(0, crlfIndex),
    rest: buffer.slice(crlfIndex + 4)
  };
}
