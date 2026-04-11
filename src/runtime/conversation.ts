import type { SessionTracer } from "../api";
import type { Usage } from "../api";
import { compactSession } from "./compact";
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
  mcpTurnRuntime?: McpTurnRuntimeSummary;
}

export interface AutoCompactionEvent {
  removedMessageCount: number;
}

export interface McpTurnRuntimeSummary {
  before: McpTurnRuntimeSnapshot;
  after: McpTurnRuntimeSnapshot;
  configuredServerCount: number;
  sseServerCount: number;
  activeSseSessions: number;
  totalReconnects: number;
  changedServerCount: number;
  hadActivity: boolean;
  activities: McpServerActivity[];
  events: McpServerEvent[];
  sessionChanges: McpSseSessionChange[];
}

export interface McpTurnRuntimeSnapshot {
  configuredServerCount: number;
  sseServerCount: number;
  activeSseSessions: number;
  totalReconnects: number;
}

export interface McpSseSessionChange {
  serverName: string;
  connectionBefore: "idle" | "opening" | "open";
  connectionAfter: "idle" | "opening" | "open";
  reconnectsBefore: number;
  reconnectsAfter: number;
  lastError?: string;
}

export interface McpServerActivity {
  serverName: string;
  toolCallCount: number;
  resourceListCount: number;
  resourceReadCount: number;
  errorCount: number;
  toolNames: string[];
  resourceUris: string[];
}

export interface McpServerEvent {
  order: number;
  serverName: string;
  kind: "tool" | "resource_list" | "resource_read";
  name: string;
  isError: boolean;
}

export interface RuntimeApiClient {
  stream(request: ApiRequest): Promise<AssistantEvent[]> | AssistantEvent[];
}

export interface ToolExecutor {
  execute(toolName: string, input: string): Promise<string> | string;
}

export interface ToolExecutionHooks {
  preToolUse?: (
    toolName: string,
    input: string
  ) => PreToolHookResponse | LegacyPreToolHookResponse | Promise<PreToolHookResponse | LegacyPreToolHookResponse | undefined> | undefined;
  postToolUse?: (
    toolName: string,
    input: string,
    output: string,
    isError: boolean
  ) => PostToolHookResponse | Promise<PostToolHookResponse | undefined> | undefined;
  postToolUseFailure?: (
    toolName: string,
    input: string,
    error: string
  ) => PostToolHookResponse | Promise<PostToolHookResponse | undefined> | undefined;
}

export interface TurnObserver {
  onTurnStarted?(input: string): void;
  onAssistantEvents?(events: AssistantEvent[], iteration: number): void;
  onToolResult?(result: { toolName: string; output: string; isError: boolean; iteration: number }): void;
}

export interface PreToolHookResponse {
  decision?: "allow" | "deny" | "ask";
  reason?: string;
  updatedInput?: string;
  message?: string;
  messages?: string[];
}

interface LegacyPreToolHookResponse {
  allow: boolean;
  reason?: string;
}

export interface PostToolHookResponse {
  decision?: "allow" | "deny";
  reason?: string;
  message?: string;
  messages?: string[];
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
    private options: {
      maxIterations?: number;
      autoCompactionInputTokensThreshold?: number;
      hooks?: ToolExecutionHooks;
      sessionTracer?: SessionTracer;
      observer?: TurnObserver;
    } = {}
  ) {
    this.usageTracker = UsageTracker.fromSession(sessionState);
    this.options = {
      ...options,
      autoCompactionInputTokensThreshold:
        options.autoCompactionInputTokensThreshold ?? autoCompactionThresholdFromEnv()
    };
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
    this.options.observer?.onTurnStarted?.(userInput);
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
      this.options.observer?.onAssistantEvents?.(events, iterations);
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
        const preHook = await this.runPreToolUseHook(tool.name, tool.input);
        const effectiveInput = preHook.updatedInput ?? tool.input;

        if (preHook.failed) {
          const denied = toolResultMessage(
            tool.id,
            tool.name,
            formatHookMessage(preHook, `pre-tool hook failed for '${tool.name}'`),
            true
          );
          this.sessionState = this.sessionState.pushMessage(denied);
          toolResults.push(denied);
          continue;
        }

        const permission = this.permissionPolicy.authorizeWithContext(
          tool.name,
          effectiveInput,
          {
            overrideDecision: preHook.decision,
            overrideReason: preHook.reason
          },
          prompter
        );
        if (permission.type === "deny") {
          const denied = toolResultMessage(
            tool.id,
            tool.name,
            mergeHookFeedback(preHook.messages, permission.reason, true),
            true
          );
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
          let output = await this.toolExecutor.execute(tool.name, effectiveInput);
          output = mergeHookFeedback(preHook.messages, output, false);

          const postHook = await this.runPostToolUseHook(tool.name, effectiveInput, output, false);
          const isHookError = postHook.failed || postHook.decision === "deny";
          result = toolResultMessage(
            tool.id,
            tool.name,
            mergeHookFeedback(
              postHook.messages,
              isHookError
                ? (postHook.reason ?? output)
                : output,
              isHookError
            ),
            isHookError
          );
        } catch (error) {
          let output = mergeHookFeedback(preHook.messages, String(error), true);
          const postHook = await this.runPostToolUseFailureHook(tool.name, effectiveInput, output);
          const failureReason = postHook.reason ?? output;
          result = toolResultMessage(
            tool.id,
            tool.name,
            mergeHookFeedback(postHook.messages, failureReason, true),
            true
          );
        }

        this.sessionState = this.sessionState.pushMessage(result);
        toolResults.push(result);
        const resultBlock = result.blocks[0];
        if (resultBlock?.type === "tool_result") {
          this.options.observer?.onToolResult?.({
            toolName: resultBlock.tool_name,
            output: resultBlock.output,
            isError: resultBlock.is_error,
            iteration: iterations
          });
        }
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
    const result = compactSession(this.sessionState, { preserveRecentMessages: 2 });
    return {
      compactedSession: result.compactedSession,
      removedMessageCount: result.removedMessageCount,
      summary: result.summary
    };
  }

  private maybeAutoCompact(): AutoCompactionEvent | undefined {
    const threshold = this.options.autoCompactionInputTokensThreshold ?? autoCompactionThresholdFromEnv();
    if (this.usageTracker.cumulativeUsage().input_tokens < threshold) {
      return undefined;
    }
    const result = compactSession(this.sessionState, { preserveRecentMessages: 2 });
    if (result.removedMessageCount === 0) {
      return undefined;
    }
    this.sessionState = result.compactedSession;
    this.sessionState.persistIfNeeded();
    return { removedMessageCount: result.removedMessageCount };
  }

  private async runPreToolUseHook(toolName: string, input: string): Promise<NormalizedPreToolHook> {
    const hook = this.options.hooks?.preToolUse;
    if (!hook) {
      return { messages: [] };
    }
    try {
      return normalizePreToolHook(await hook(toolName, input));
    } catch (error) {
      return {
        failed: true,
        messages: [String(error)]
      };
    }
  }

  private async runPostToolUseHook(
    toolName: string,
    input: string,
    output: string,
    isError: boolean
  ): Promise<NormalizedPostToolHook> {
    const hook = this.options.hooks?.postToolUse;
    if (!hook) {
      return { messages: [] };
    }
    try {
      return normalizePostToolHook(await hook(toolName, input, output, isError));
    } catch (error) {
      return {
        failed: true,
        reason: String(error),
        messages: [String(error)]
      };
    }
  }

  private async runPostToolUseFailureHook(
    toolName: string,
    input: string,
    error: string
  ): Promise<NormalizedPostToolHook> {
    const hook = this.options.hooks?.postToolUseFailure;
    if (!hook) {
      return { messages: [] };
    }
    try {
      return normalizePostToolHook(await hook(toolName, input, error));
    } catch (hookError) {
      return {
        failed: true,
        reason: String(hookError),
        messages: [String(hookError)]
      };
    }
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

interface NormalizedPreToolHook {
  decision?: "allow" | "deny" | "ask";
  reason?: string;
  updatedInput?: string;
  messages: string[];
  failed?: boolean;
}

interface NormalizedPostToolHook {
  decision?: "allow" | "deny";
  reason?: string;
  messages: string[];
  failed?: boolean;
}

const DEFAULT_AUTO_COMPACTION_INPUT_TOKENS_THRESHOLD = 100_000;
const AUTO_COMPACTION_THRESHOLD_ENV_VAR = "CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS";

function normalizePreToolHook(
  result: PreToolHookResponse | LegacyPreToolHookResponse | undefined
): NormalizedPreToolHook {
  if (!result) {
    return { messages: [] };
  }
  if ("allow" in result) {
    return result.allow
      ? { messages: [] }
      : {
          decision: "deny",
          reason: result.reason ?? "denied tool",
          messages: result.reason ? [result.reason] : []
        };
  }
  return {
    decision: result.decision,
    reason: result.reason,
    updatedInput: result.updatedInput,
    messages: compactHookMessages(result.message, result.messages)
  };
}

function normalizePostToolHook(result: PostToolHookResponse | undefined): NormalizedPostToolHook {
  if (!result) {
    return { messages: [] };
  }
  return {
    decision: result.decision,
    reason: result.reason,
    messages: compactHookMessages(result.message, result.messages)
  };
}

function compactHookMessages(message?: string, messages?: string[]): string[] {
  const out: string[] = [];
  if (message?.trim()) {
    out.push(message.trim());
  }
  for (const value of messages ?? []) {
    if (value.trim()) {
      out.push(value.trim());
    }
  }
  return out;
}

function formatHookMessage(
  result: { messages: string[]; reason?: string },
  fallback: string
): string {
  if (result.messages.length > 0) {
    return result.messages.join("\n");
  }
  return result.reason ?? fallback;
}

function mergeHookFeedback(messages: string[], output: string, isError: boolean): string {
  if (messages.length === 0) {
    return output;
  }
  const sections: string[] = [];
  if (output.trim()) {
    sections.push(output);
  }
  sections.push(`${isError ? "Hook feedback (error)" : "Hook feedback"}:\n${messages.join("\n")}`);
  return sections.join("\n\n");
}

export function autoCompactionThresholdFromEnv(): number {
  return parseAutoCompactionThreshold(process.env[AUTO_COMPACTION_THRESHOLD_ENV_VAR]);
}

export function parseAutoCompactionThreshold(value: string | undefined): number {
  const parsed = value?.trim() ? Number.parseInt(value.trim(), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_AUTO_COMPACTION_INPUT_TOKENS_THRESHOLD;
}
