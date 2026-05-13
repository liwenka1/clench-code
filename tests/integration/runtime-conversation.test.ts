import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { MemoryTelemetrySink, SessionTracer } from "../../src/api";
import {
  autoCompactionThresholdFromEnv,
  ConversationRuntime,
  PermissionPolicy,
  Session,
  StaticToolExecutor,
  parseAutoCompactionThreshold,
  type AssistantEvent,
  type PermissionPrompter,
  type RuntimeApiClient
} from "../../src/runtime";

describe("runtime conversation integration", () => {
  test("runs_user_to_tool_to_result_loop_end_to_end_and_tracks_usage", async () => {
    class ScriptedApiClient implements RuntimeApiClient {
      callCount = 0;

      stream(): AssistantEvent[] {
        this.callCount += 1;
        if (this.callCount === 1) {
          return [
            { type: "text_delta", text: "Let me calculate that." },
            { type: "tool_use", id: "tool-1", name: "add", input: "2,2" },
            {
              type: "usage",
              usage: {
                input_tokens: 20,
                output_tokens: 6,
                cache_creation_input_tokens: 1,
                cache_read_input_tokens: 2
              }
            },
            { type: "message_stop" }
          ];
        }
        return [
          { type: "text_delta", text: "The answer is 4." },
          {
            type: "usage",
            usage: {
              input_tokens: 24,
              output_tokens: 4,
              cache_creation_input_tokens: 1,
              cache_read_input_tokens: 3
            }
          },
          {
            type: "prompt_cache",
            event: {
              unexpected: true,
              reason: "cache read tokens dropped while prompt fingerprint remained stable",
              previousCacheReadInputTokens: 6000,
              currentCacheReadInputTokens: 1000,
              tokenDrop: 5000
            }
          },
          { type: "message_stop" }
        ];
      }
    }

    const runtime = new ConversationRuntime(
      Session.new(),
      new ScriptedApiClient(),
      new StaticToolExecutor().register("add", (input) =>
        input
          .split(",")
          .map((part) => Number(part))
          .reduce((sum, value) => sum + value, 0)
          .toString()
      ),
      new PermissionPolicy("workspace-write").withToolRequirement("add", "workspace-write"),
      ["system"]
    );

    const summary = await runtime.runTurn("what is 2 + 2?");
    expect(summary.iterations).toBe(2);
    expect(summary.assistantMessages).toHaveLength(2);
    expect(summary.toolResults).toHaveLength(1);
    expect(summary.promptCacheEvents).toHaveLength(1);
    expect(runtime.session().messages).toHaveLength(4);
    expect(summary.usage.output_tokens).toBe(10);
    expect(summary.autoCompaction).toBeUndefined();
  });

  test("records_runtime_session_trace_events", async () => {
    const sink = new MemoryTelemetrySink();
    const tracer = new SessionTracer("session-runtime", sink);

    class SingleToolApi implements RuntimeApiClient {
      calls = 0;
      stream(): AssistantEvent[] {
        this.calls += 1;
        return this.calls === 1
          ? [
              { type: "tool_use", id: "tool-1", name: "add", input: "2,2" },
              { type: "message_stop" }
            ]
          : [{ type: "text_delta", text: "done" }, { type: "message_stop" }];
      }
    }

    const runtime = new ConversationRuntime(
      Session.new(),
      new SingleToolApi(),
      new StaticToolExecutor().register("add", () => "4"),
      new PermissionPolicy("workspace-write").withToolRequirement("add", "workspace-write"),
      ["system"]
    ).withSessionTracer(tracer);

    await runtime.runTurn("what is 2 + 2?");
    const traceNames = sink
      .events()
      .filter((event) => event.kind === "session_trace")
      .map((event) => event.name);
    expect(traceNames).toContain("turn_started");
    expect(traceNames).toContain("assistant_iteration_completed");
    expect(traceNames).toContain("tool_execution_started");
    expect(traceNames).toContain("tool_execution_finished");
    expect(traceNames).toContain("turn_completed");
  });

  test("unknown_tool_result_includes_suggestion_and_available_tools", async () => {
    class UnknownToolApi implements RuntimeApiClient {
      calls = 0;
      stream(): AssistantEvent[] {
        this.calls += 1;
        return this.calls === 1
          ? [
              { type: "tool_use", id: "tool-1", name: "grep_serch", input: "{}" },
              { type: "message_stop" }
            ]
          : [{ type: "text_delta", text: "done" }, { type: "message_stop" }];
      }
    }

    const runtime = new ConversationRuntime(
      Session.new(),
      new UnknownToolApi(),
      new StaticToolExecutor().register("grep_search", () => "matched"),
      new PermissionPolicy("danger-full-access"),
      ["system"]
    );

    const summary = await runtime.runTurn("search");
    const block = summary.toolResults[0]?.blocks[0];
    expect(block?.type).toBe("tool_result");
    expect(block?.is_error).toBe(true);
    expect(block?.output).toContain("Did you mean grep_search?");
    expect(block?.output).toContain("Available tools:");
  });

  test("max_iterations_stops_repeating_tool_loops", async () => {
    class RepeatingToolApi implements RuntimeApiClient {
      stream(): AssistantEvent[] {
        return [
          { type: "tool_use", id: `tool-${Date.now()}`, name: "echo", input: "{}" },
          { type: "message_stop" }
        ];
      }
    }

    const runtime = new ConversationRuntime(
      Session.new(),
      new RepeatingToolApi(),
      new StaticToolExecutor().register("echo", () => "again"),
      new PermissionPolicy("danger-full-access"),
      ["system"],
      { maxIterations: 2 }
    );

    await expect(runtime.runTurn("loop")).rejects.toThrow("conversation loop exceeded the maximum number of iterations");
  });

  test("records_denied_tool_results_when_prompt_rejects", async () => {
    class RejectPrompter implements PermissionPrompter {
      decide() {
        return { type: "deny" as const, reason: "not now" };
      }
    }

    class SingleCallApi implements RuntimeApiClient {
      stream(request): AssistantEvent[] {
        const hasTool = request.messages.some((message) => message.role === "tool");
        return hasTool
          ? [{ type: "text_delta", text: "I could not use the tool." }, { type: "message_stop" }]
          : [
              { type: "tool_use", id: "tool-1", name: "blocked", input: "secret" },
              { type: "message_stop" }
            ];
      }
    }

    const runtime = new ConversationRuntime(
      Session.new(),
      new SingleCallApi(),
      new StaticToolExecutor(),
      new PermissionPolicy("workspace-write").withToolRequirement("blocked", "danger-full-access"),
      ["system"]
    );

    const summary = await runtime.runTurn("use the tool", new RejectPrompter());
    expect(summary.toolResults).toHaveLength(1);
    const block = summary.toolResults[0]?.blocks[0];
    expect(block).toEqual({
      type: "tool_result",
      tool_use_id: "tool-1",
      tool_name: "blocked",
      output: "not now",
      is_error: true
    });
  });

  test("denies_tool_use_when_pre_tool_hook_blocks", async () => {
    class SingleCallApi implements RuntimeApiClient {
      stream(request): AssistantEvent[] {
        const hasTool = request.messages.some((message) => message.role === "tool");
        return hasTool
          ? [{ type: "text_delta", text: "blocked" }, { type: "message_stop" }]
          : [
              {
                type: "tool_use",
                id: "tool-1",
                name: "blocked",
                input: '{"path":"secret.txt"}'
              },
              { type: "message_stop" }
            ];
      }
    }

    const runtime = new ConversationRuntime(
      Session.new(),
      new SingleCallApi(),
      new StaticToolExecutor().register("blocked", () => {
        throw new Error("tool should not execute");
      }),
      new PermissionPolicy("danger-full-access"),
      ["system"],
      {
        hooks: {
          preToolUse: () => ({ allow: false, reason: "blocked by hook" })
        }
      }
    );

    const summary = await runtime.runTurn("use the tool");
    const block = summary.toolResults[0]?.blocks[0];
    expect(block && block.type === "tool_result" && block.is_error).toBe(true);
    expect(block && block.type === "tool_result" ? block.output : "").toContain("blocked by hook");
  });

  test("pre_tool_hook_can_request_approval_and_rewrite_input", async () => {
    class ApprovePrompter implements PermissionPrompter {
      decide() {
        return { type: "allow" as const };
      }
    }

    class SingleCallApi implements RuntimeApiClient {
      stream(request): AssistantEvent[] {
        const hasTool = request.messages.some((message) => message.role === "tool");
        return hasTool
          ? [{ type: "text_delta", text: "done" }, { type: "message_stop" }]
          : [
              { type: "tool_use", id: "tool-1", name: "rewrite", input: '{"path":"draft.txt"}' },
              { type: "message_stop" }
            ];
      }
    }

    const seenInputs: string[] = [];
    const runtime = new ConversationRuntime(
      Session.new(),
      new SingleCallApi(),
      new StaticToolExecutor().register("rewrite", (input) => {
        seenInputs.push(input);
        return "rewritten";
      }),
      new PermissionPolicy("read-only").withToolRequirement("rewrite", "workspace-write"),
      ["system"],
      {
        hooks: {
          preToolUse: () => ({
            decision: "ask",
            reason: "needs explicit approval",
            updatedInput: '{"path":"approved.txt"}',
            message: "input rewritten by hook"
          })
        }
      }
    );

    const summary = await runtime.runTurn("rewrite please", new ApprovePrompter());
    expect(seenInputs).toEqual(['{"path":"approved.txt"}']);
    const block = summary.toolResults[0]?.blocks[0];
    expect(block && block.type === "tool_result" ? block.output : "").toContain("input rewritten by hook");
  });

  test("post_tool_hooks_append_feedback_and_can_fail_a_successful_tool", async () => {
    class SingleCallApi implements RuntimeApiClient {
      stream(request): AssistantEvent[] {
        const hasTool = request.messages.some((message) => message.role === "tool");
        return hasTool
          ? [{ type: "text_delta", text: "tool completed with warnings" }, { type: "message_stop" }]
          : [{ type: "tool_use", id: "tool-1", name: "echo", input: "hi" }, { type: "message_stop" }];
      }
    }

    const runtime = new ConversationRuntime(
      Session.new(),
      new SingleCallApi(),
      new StaticToolExecutor().register("echo", () => "tool output"),
      new PermissionPolicy("danger-full-access"),
      ["system"],
      {
        hooks: {
          postToolUse: () => ({
            decision: "deny",
            reason: "plugin policy rejected the tool result",
            message: "post hook says no"
          })
        }
      }
    );

    const summary = await runtime.runTurn("go");
    const block = summary.toolResults[0]?.blocks[0];
    expect(block && block.type === "tool_result" ? block.is_error : false).toBe(true);
    expect(block && block.type === "tool_result" ? block.output : "").toContain("plugin policy rejected the tool result");
    expect(block && block.type === "tool_result" ? block.output : "").toContain("post hook says no");
  });

  test("post_tool_failure_hook_appends_feedback_for_tool_errors", async () => {
    class SingleCallApi implements RuntimeApiClient {
      stream(request): AssistantEvent[] {
        const hasTool = request.messages.some((message) => message.role === "tool");
        return hasTool
          ? [{ type: "text_delta", text: "tool failed" }, { type: "message_stop" }]
          : [{ type: "tool_use", id: "tool-1", name: "explode", input: "boom" }, { type: "message_stop" }];
      }
    }

    const runtime = new ConversationRuntime(
      Session.new(),
      new SingleCallApi(),
      new StaticToolExecutor().register("explode", () => {
        throw new Error("kaboom");
      }),
      new PermissionPolicy("danger-full-access"),
      ["system"],
      {
        hooks: {
          postToolUseFailure: () => ({
            message: "failure hook observed the error"
          })
        }
      }
    );

    const summary = await runtime.runTurn("go");
    const block = summary.toolResults[0]?.blocks[0];
    expect(block && block.type === "tool_result" ? block.output : "").toContain("kaboom");
    expect(block && block.type === "tool_result" ? block.output : "").toContain("failure hook observed the error");
  });

  test("reconstructs_usage_tracker_from_restored_session", async () => {
    const session = new Session("restored", [
      {
        role: "assistant",
        blocks: [{ type: "text", text: "earlier" }],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 1
        }
      }
    ]);

    const runtime = new ConversationRuntime(
      session,
      { stream: () => [{ type: "text_delta", text: "done" }, { type: "message_stop" }] },
      new StaticToolExecutor(),
      new PermissionPolicy("danger-full-access"),
      ["system"]
    );

    expect(runtime.usage().turns()).toBe(1);
    const usage = runtime.usage().cumulativeUsage();
    expect(
      usage.input_tokens +
        usage.output_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
    ).toBe(21);
  });

  test("persists_conversation_turn_messages_to_jsonl_session", async () => {
    const sessionPath = tempSessionPath("conversation.jsonl");
    const runtime = new ConversationRuntime(
      Session.new().withPersistencePath(sessionPath),
      { stream: () => [{ type: "text_delta", text: "done" }, { type: "message_stop" }] },
      new StaticToolExecutor(),
      new PermissionPolicy("danger-full-access"),
      ["system"]
    );

    await runtime.runTurn("persist this turn");
    const restored = Session.loadFromPath(sessionPath);
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[0]?.role).toBe("user");
    expect(restored.messages[1]?.role).toBe("assistant");
    cleanup(sessionPath);
  });

  test("auto_compacts_when_cumulative_input_threshold_is_crossed", async () => {
    const runtime = new ConversationRuntime(
      new Session("auto", [
        { role: "user", blocks: [{ type: "text", text: "one" }] },
        { role: "assistant", blocks: [{ type: "text", text: "two" }] },
        { role: "user", blocks: [{ type: "text", text: "three" }] },
        { role: "assistant", blocks: [{ type: "text", text: "four" }] }
      ]),
      {
        stream: () => [
          { type: "text_delta", text: "done" },
          {
            type: "usage",
            usage: {
              input_tokens: 120_000,
              output_tokens: 4,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0
            }
          },
          { type: "message_stop" }
        ]
      },
      new StaticToolExecutor(),
      new PermissionPolicy("danger-full-access"),
      ["system"]
    ).withAutoCompactionInputTokensThreshold(100_000);

    const summary = await runtime.runTurn("trigger");
    expect(summary.autoCompaction).toEqual({ removedMessageCount: 4 });
    expect(runtime.session().messages[0]?.role).toBe("system");
    expect(runtime.session().messages).toHaveLength(3);
  });

  test("auto_compaction_threshold_defaults_and_parses_values", async () => {
    expect(parseAutoCompactionThreshold(undefined)).toBe(100_000);
    expect(parseAutoCompactionThreshold("4321")).toBe(4321);
    expect(parseAutoCompactionThreshold("0")).toBe(100_000);
    expect(parseAutoCompactionThreshold("not-a-number")).toBe(100_000);
  });

  test("auto_compaction_threshold_reads_from_environment", async () => {
    const previous = process.env.CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS;
    process.env.CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS = "12345";
    try {
      expect(autoCompactionThresholdFromEnv()).toBe(12345);
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS;
      } else {
        process.env.CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS = previous;
      }
    }
  });
});

function tempSessionPath(fileName: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-conversation-")), fileName);
}

function cleanup(filePath: string): void {
  try {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures.
  }
}
