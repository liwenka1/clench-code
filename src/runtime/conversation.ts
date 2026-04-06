import type { SessionTracer } from "../api";
import type { Usage } from "../api";
import {
  Session,
  type ContentBlock,
  type ConversationMessage
} from "./session";
import {
  PermissionPolicy,
  type PermissionPrompter
} from "./permissions";
import { UsageTracker, zeroUsage } from "./usage";

export interface ApiRequest {
  systemPrompt: string[];
  messages: ConversationMessage[];
}

export type AssistantEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: string }
  | { type: "usage"; usage: Usage }
  | {
      type: "prompt_cache";
      event: PromptCacheEvent;
    }
  | { type: "message_stop" };

export interface PromptCacheEvent {
  unexpected: boolean;
  reason: string;
  previousCacheReadInputTokens: number;
  currentCacheReadInputTokens: number;
  tokenDrop: number;
}

export interface TurnSummary {
  assistantMessages: ConversationMessage[];
  toolResults: ConversationMessage[];
  promptCacheEvents: PromptCacheEvent[];
  iterations: number;
  usage: Usage;
  autoCompaction?: AutoCompactionEvent;
}

export interface AutoCompactionEvent {
  removedMessageCount: number;
}

export interface RuntimeApiClient {
  stream(request: ApiRequest): Promise<AssistantEvent[]> | AssistantEvent[];
}

export interface ToolExecutor {
  execute(toolName: string, input: string): Promise<string> | string;
}

export interface ToolExecutionHooks {
  preToolUse?: (toolName: string, input: string) => { allow: boolean; reason?: string };
}

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

export class StaticToolExecutor implements ToolExecutor {
  constructor(
    private readonly handlers = new Map<string, (input: string) => Promise<string> | string>()
  ) {}

  register(toolName: string, handler: (input: string) => Promise<string> | string): StaticToolExecutor {
    const next = new StaticToolExecutor(new Map(this.handlers));
    next.handlers.set(toolName, handler);
    return next;
  }

  async execute(toolName: string, input: string): Promise<string> {
    const handler = this.handlers.get(toolName);
    if (!handler) {
      throw new RuntimeError(`unknown tool: ${toolName}`);
    }
    return handler(input);
  }
}

export class ConversationRuntime<C extends RuntimeApiClient, T extends ToolExecutor> {
  private usageTracker: UsageTracker;

  constructor(
    private sessionState: Session,
    private readonly apiClient: C,
    private readonly toolExecutor: T,
    private readonly permissionPolicy: PermissionPolicy,
    private readonly systemPrompt: string[],
    private readonly options: {
      maxIterations?: number;
      autoCompactionInputTokensThreshold?: number;
      hooks?: ToolExecutionHooks;
      sessionTracer?: SessionTracer;
    } = {}
  ) {
    this.usageTracker = UsageTracker.fromSession(sessionState);
  }

  withSessionTracer(sessionTracer: SessionTracer): ConversationRuntime<C, T> {
    return new ConversationRuntime(
      this.sessionState,
      this.apiClient,
      this.toolExecutor,
      this.permissionPolicy,
      this.systemPrompt,
      { ...this.options, sessionTracer }
    );
  }

  withAutoCompactionInputTokensThreshold(threshold: number): ConversationRuntime<C, T> {
    return new ConversationRuntime(
      this.sessionState,
      this.apiClient,
      this.toolExecutor,
      this.permissionPolicy,
      this.systemPrompt,
      { ...this.options, autoCompactionInputTokensThreshold: threshold }
    );
  }

  withMaxIterations(maxIterations: number): ConversationRuntime<C, T> {
    return new ConversationRuntime(
      this.sessionState,
      this.apiClient,
      this.toolExecutor,
      this.permissionPolicy,
      this.systemPrompt,
      { ...this.options, maxIterations }
    );
  }

  async runTurn(userInput: string, prompter?: PermissionPrompter): Promise<TurnSummary> {
    this.options.sessionTracer?.record("turn_started", { user_input: userInput });
    this.sessionState = this.sessionState.pushUserText(userInput);

    const assistantMessages: ConversationMessage[] = [];
    const toolResults: ConversationMessage[] = [];
    const promptCacheEvents: PromptCacheEvent[] = [];
    let iterations = 0;
    const maxIterations = this.options.maxIterations ?? Number.MAX_SAFE_INTEGER;

    while (true) {
      iterations += 1;
      if (iterations > maxIterations) {
        throw new RuntimeError("conversation loop exceeded the maximum number of iterations");
      }

      const events = await this.apiClient.stream({
        systemPrompt: this.systemPrompt,
        messages: this.sessionState.messages
      });
      const built = buildAssistantMessage(events);
      if (built.usage) {
        this.usageTracker = this.usageTracker.record(built.usage);
      }
      promptCacheEvents.push(...built.promptCacheEvents);
      this.options.sessionTracer?.record("assistant_iteration_completed", {
        iteration: iterations,
        assistant_blocks: built.message.blocks.length,
        pending_tool_use_count: built.pendingToolUses.length
      });

      this.sessionState = this.sessionState.pushMessage(built.message);
      assistantMessages.push(built.message);

      if (built.pendingToolUses.length === 0) {
        break;
      }

      for (const tool of built.pendingToolUses) {
        const preHook = this.options.hooks?.preToolUse?.(tool.name, tool.input);
        if (preHook && !preHook.allow) {
          const denied = toolResultMessage(tool.id, tool.name, preHook.reason ?? "denied tool", true);
          this.sessionState = this.sessionState.pushMessage(denied);
          toolResults.push(denied);
          continue;
        }

        const permission = this.permissionPolicy.authorize(tool.name, tool.input, prompter);
        if (permission.type === "deny") {
          const denied = toolResultMessage(tool.id, tool.name, permission.reason, true);
          this.sessionState = this.sessionState.pushMessage(denied);
          toolResults.push(denied);
          continue;
        }

        this.options.sessionTracer?.record("tool_execution_started", {
          iteration: iterations,
          tool_name: tool.name
        });
        let result: ConversationMessage;
        try {
          const output = await this.toolExecutor.execute(tool.name, tool.input);
          result = toolResultMessage(tool.id, tool.name, output, false);
        } catch (error) {
          result = toolResultMessage(tool.id, tool.name, String(error), true);
        }

        this.sessionState = this.sessionState.pushMessage(result);
        toolResults.push(result);
        this.options.sessionTracer?.record("tool_execution_finished", {
          iteration: iterations,
          tool_name: tool.name,
          is_error: result.blocks[0] && result.blocks[0].type === "tool_result"
            ? result.blocks[0].is_error
            : true
        });
      }
    }

    const autoCompaction = this.maybeAutoCompact();
    const summary: TurnSummary = {
      assistantMessages,
      toolResults,
      promptCacheEvents,
      iterations,
      usage: this.usageTracker.cumulativeUsage(),
      autoCompaction
    };
    this.options.sessionTracer?.record("turn_completed", {
      iterations: summary.iterations,
      assistant_messages: summary.assistantMessages.length,
      tool_results: summary.toolResults.length,
      prompt_cache_events: summary.promptCacheEvents.length
    });
    return summary;
  }

  session(): Session {
    return this.sessionState;
  }

  usage(): UsageTracker {
    return this.usageTracker;
  }

  forkSession(branchName?: string): Session {
    return this.sessionState.forkSession(branchName);
  }

  compact(): { compactedSession: Session; removedMessageCount: number; summary: string } {
    const removedMessageCount = Math.max(0, this.sessionState.messages.length - 2);
    const recent = this.sessionState.messages.slice(-2);
    const compactedSession = new Session(
      this.sessionState.sessionId,
      [
        {
          role: "system",
          blocks: [{ type: "text", text: "Conversation summary" }]
        },
        ...recent
      ],
      this.sessionState.persistencePath,
      {
        summary: "Conversation summary",
        removedMessageCount,
        count: (this.sessionState.compaction?.count ?? 0) + 1
      },
      this.sessionState.fork,
      this.sessionState.maxPersistenceBytes,
      this.sessionState.version,
      this.sessionState.createdAtMs,
      Date.now()
    );
    return {
      compactedSession,
      removedMessageCount,
      summary: "Conversation summary"
    };
  }

  private maybeAutoCompact(): AutoCompactionEvent | undefined {
    const threshold = this.options.autoCompactionInputTokensThreshold ?? 100_000;
    if (this.usageTracker.cumulativeUsage().input_tokens < threshold) {
      return undefined;
    }
    if (this.sessionState.messages.length < 4) {
      return undefined;
    }

    const removedMessageCount = 2;
    const remaining = this.sessionState.messages.slice(2);
    this.sessionState = new Session(
      this.sessionState.sessionId,
      [
        {
          role: "system",
          blocks: [{ type: "text", text: "Conversation summary" }]
        },
        ...remaining
      ],
      this.sessionState.persistencePath,
      {
        summary: "Conversation summary",
        removedMessageCount,
        count: (this.sessionState.compaction?.count ?? 0) + 1
      },
      this.sessionState.fork,
      this.sessionState.maxPersistenceBytes,
      this.sessionState.version,
      this.sessionState.createdAtMs,
      Date.now()
    );
    this.sessionState.persistIfNeeded();
    return { removedMessageCount };
  }
}

export function buildAssistantMessage(events: AssistantEvent[]): {
  message: ConversationMessage;
  usage?: Usage;
  promptCacheEvents: PromptCacheEvent[];
  pendingToolUses: Array<{ id: string; name: string; input: string }>;
} {
  let text = "";
  let finished = false;
  let usage: Usage | undefined;
  const promptCacheEvents: PromptCacheEvent[] = [];
  const blocks: ContentBlock[] = [];
  const pendingToolUses: Array<{ id: string; name: string; input: string }> = [];

  for (const event of events) {
    if (event.type === "text_delta") {
      text += event.text;
      continue;
    }
    if (event.type === "tool_use") {
      flushText(text, blocks);
      text = "";
      blocks.push({ type: "tool_use", id: event.id, name: event.name, input: event.input });
      pendingToolUses.push({ id: event.id, name: event.name, input: event.input });
      continue;
    }
    if (event.type === "usage") {
      usage = event.usage;
      continue;
    }
    if (event.type === "prompt_cache") {
      promptCacheEvents.push(event.event);
      continue;
    }
    if (event.type === "message_stop") {
      finished = true;
    }
  }

  flushText(text, blocks);

  if (!finished) {
    throw new RuntimeError("assistant stream ended without a message stop event");
  }
  if (blocks.length === 0) {
    throw new RuntimeError("assistant stream produced no content");
  }

  return {
    message: {
      role: "assistant",
      blocks,
      usage
    },
    usage,
    promptCacheEvents,
    pendingToolUses
  };
}

function flushText(text: string, blocks: ContentBlock[]): void {
  if (text) {
    blocks.push({ type: "text", text });
  }
}

function toolResultMessage(
  toolUseId: string,
  toolName: string,
  output: string,
  isError: boolean
): ConversationMessage {
  return {
    role: "tool",
    blocks: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        tool_name: toolName,
        output,
        is_error: isError
      }
    ]
  };
}

export function zeroRuntimeUsage(): Usage {
  return zeroUsage();
}
