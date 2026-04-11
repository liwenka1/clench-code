import type { ProviderClient } from "../api/providers";
import type { MessageRequest, StreamEvent, ToolChoice, ToolDefinition, Usage } from "../api/types";
import type { ApiRequest, AssistantEvent, RuntimeApiClient } from "./conversation";
import type { ConversationMessage } from "./session";

type BlockState =
  | { kind: "text" }
  | { kind: "tool"; id: string; name: string; inputJson: string }
  | { kind: "skip" };

/** Maps session messages to an Anthropic `MessageRequest` (tools / streaming filled by caller). */
export function apiRequestToMessageRequest(
  api: ApiRequest,
  model: string,
  maxTokens: number
): MessageRequest {
  const messages = api.messages.map(conversationMessageToInput);
  const system =
    api.systemPrompt.length > 0 ? api.systemPrompt.join("\n\n") : undefined;
  return {
    model,
    max_tokens: maxTokens,
    messages,
    system,
    stream: true
  };
}

function conversationMessageToInput(message: ConversationMessage): MessageRequest["messages"][number] {
  const content: MessageRequest["messages"][number]["content"] = [];
  for (const block of message.blocks) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: parseToolInputForApi(block.input)
      });
    } else {
      content.push({
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: [{ type: "text", text: block.output }],
        is_error: block.is_error
      });
    }
  }
  return { role: message.role, content };
}

function parseToolInputForApi(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return input;
  }
}

/**
 * Converts Anthropic-shaped `StreamEvent`s (from `ProviderClient.streamMessage`) into
 * `AssistantEvent`s for `ConversationRuntime` / `buildAssistantMessage`.
 */
export function streamEventsToAssistantEvents(events: StreamEvent[]): AssistantEvent[] {
  const collector = new AssistantEventCollector();
  const out: AssistantEvent[] = [];

  for (const ev of events) {
    out.push(...collector.consume(ev));
  }

  return out;
}

/** Last `message_delta` usage in a stream (Anthropic finalizes usage there). */
export function lastUsageFromStreamEvents(events: StreamEvent[]): Usage | undefined {
  let last: Usage | undefined;
  for (const ev of events) {
    if (ev.type === "message_delta") {
      last = ev.usage;
    }
  }
  return last;
}

export interface ProviderRuntimeClientOptions {
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  onAssistantEvent?: (event: AssistantEvent) => void;
}

/**
 * `RuntimeApiClient` backed by `ProviderClient.streamMessage`, for use with `ConversationRuntime`.
 */
export class ProviderRuntimeClient implements RuntimeApiClient {
  constructor(
    private readonly provider: ProviderClient,
    private readonly model: string,
    private readonly maxTokens: number,
    private readonly extra?: ProviderRuntimeClientOptions
  ) {}

  async stream(request: ApiRequest): Promise<AssistantEvent[]> {
    const msg: MessageRequest = apiRequestToMessageRequest(request, this.model, this.maxTokens);
    if (this.extra?.tools?.length) {
      msg.tools = this.extra.tools;
      msg.tool_choice = this.extra.toolChoice ?? { type: "auto" };
    }

    const stream = await this.provider.streamMessage(msg);
    const streamEvents: StreamEvent[] = [];
    const assistantEvents: AssistantEvent[] = [];
    const collector = new AssistantEventCollector();
    while (true) {
      const ev = await stream.nextEvent();
      if (ev === undefined) {
        break;
      }
      streamEvents.push(ev);
      for (const event of collector.consume(ev)) {
        assistantEvents.push(event);
        this.extra?.onAssistantEvent?.(event);
      }
    }

    const lastUsage = lastUsageFromStreamEvents(streamEvents);
    if (lastUsage) {
      try {
        this.provider.recordPromptCacheStreamUsage(msg, lastUsage);
      } catch {
        // Prompt-cache persistence is optional in constrained environments.
      }
    }

    let assistant = assistantEvents;
    const record = this.provider.takeLastPromptCacheRecord();
    if (record?.cacheBreak) {
      const stopIndex = assistant.findIndex((e) => e.type === "message_stop");
      const inject: AssistantEvent = {
        type: "prompt_cache",
        event: record.cacheBreak
      };
      if (stopIndex >= 0) {
        assistant.splice(stopIndex, 0, inject);
      } else {
        assistant.push(inject);
      }
    }
    return assistant;
  }
}

class AssistantEventCollector {
  private readonly blocks = new Map<number, BlockState>();

  consume(ev: StreamEvent): AssistantEvent[] {
    switch (ev.type) {
      case "message_start":
        return [];
      case "content_block_start": {
        const cb = ev.content_block;
        if (cb.type === "text") {
          this.blocks.set(ev.index, { kind: "text" });
        } else if (cb.type === "tool_use") {
          this.blocks.set(ev.index, {
            kind: "tool",
            id: cb.id,
            name: cb.name,
            inputJson: ""
          });
        } else {
          this.blocks.set(ev.index, { kind: "skip" });
        }
        return [];
      }
      case "content_block_delta": {
        if (ev.delta.type === "text_delta") {
          return [{ type: "text_delta", text: ev.delta.text }];
        }
        if (ev.delta.type === "input_json_delta") {
          const b = this.blocks.get(ev.index);
          if (b?.kind === "tool") {
            b.inputJson += ev.delta.partial_json;
          }
        }
        return [];
      }
      case "content_block_stop": {
        const b = this.blocks.get(ev.index);
        if (b?.kind === "tool") {
          return [{
            type: "tool_use",
            id: b.id,
            name: b.name,
            input: b.inputJson
          }];
        }
        return [];
      }
      case "message_delta":
        return [{ type: "usage", usage: ev.usage }];
      case "message_stop":
        return [{ type: "message_stop" }];
      default:
        return [];
    }
  }
}
