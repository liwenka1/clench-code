export interface MessageRequest {
  model: string;
  max_tokens: number;
  messages: InputMessage[];
  system?: string;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  stream?: boolean;
}

export interface InputMessage {
  role: string;
  content: InputContentBlock[];
}

export type InputContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: ToolResultContentBlock[];
      is_error?: boolean;
    };

export type ToolResultContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "json";
      value: unknown;
    };

export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: unknown;
}

export type ToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

export interface MessageResponse {
  id: string;
  type: "message";
  role: string;
  content: OutputContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: Usage;
  request_id?: string;
}

export type OutputContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: "thinking";
      thinking: string;
      signature: string | null;
    }
  | {
      type: "redacted_thinking";
      data: unknown;
    };

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens: number;
}

export interface MessageStartEvent {
  type: "message_start";
  message: MessageResponse;
}

export interface MessageDelta {
  stop_reason: string | null;
  stop_sequence: string | null;
}

export interface MessageDeltaEvent {
  type: "message_delta";
  delta: MessageDelta;
  usage: Usage;
}

export interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: OutputContentBlock;
}

export type ContentBlockDelta =
  | {
      type: "text_delta";
      text: string;
    }
  | {
      type: "input_json_delta";
      partial_json: string;
    }
  | {
      type: "thinking_delta";
      thinking: string;
    }
  | {
      type: "signature_delta";
      signature: string;
    };

export interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: ContentBlockDelta;
}

export interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface MessageStopEvent {
  type: "message_stop";
}

export type StreamEvent =
  | MessageStartEvent
  | MessageDeltaEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageStopEvent;

export function withStreaming(request: MessageRequest): MessageRequest {
  return { ...request, stream: true };
}

export function totalTokens(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  );
}

export function messageTotalTokens(response: MessageResponse): number {
  return totalTokens(response.usage);
}
