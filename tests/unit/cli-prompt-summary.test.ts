import { describe, expect, test, vi } from "vitest";

import { printPromptSummary } from "../../src/cli/prompt-run";
import type { TurnSummary } from "../../src/runtime";
import { zeroUsage } from "../../src/runtime";

function minimalSummary(overrides: Partial<TurnSummary> = {}): TurnSummary {
  return {
    assistantMessages: [
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "t1", name: "bash", input: "{}" }
        ]
      }
    ],
    toolResults: [],
    promptCacheEvents: [],
    iterations: 1,
    usage: zeroUsage(),
    ...overrides
  };
}

describe("printPromptSummary", () => {
  test("json_writes_pretty_printed_summary", () => {
    const summary = minimalSummary();
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((msg: string | Uint8Array) => {
      chunks.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
      return true;
    });
    try {
      printPromptSummary(summary, "json");
    } finally {
      spy.mockRestore();
    }
    const out = chunks.join("");
    const parsed = JSON.parse(out) as TurnSummary;
    expect(parsed.usage).toEqual(summary.usage);
    expect(parsed.assistantMessages[0]?.blocks[0]).toMatchObject({ type: "text", text: "Hello" });
  });

  test("ndjson_writes_single_line_json", () => {
    const summary = minimalSummary();
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((msg: string | Uint8Array) => {
      chunks.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
      return true;
    });
    try {
      printPromptSummary(summary, "ndjson");
    } finally {
      spy.mockRestore();
    }
    const lines = chunks.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ iterations: 1 });
  });

  test("text_writes_blocks_including_tool_use_line", () => {
    const summary = minimalSummary({
      mcpTurnRuntime: {
        configuredServerCount: 1,
        sseServerCount: 1,
        activeSseSessions: 1,
        totalReconnects: 1,
        sessionChanges: [
          {
            serverName: "remoteSse",
            connectionBefore: "idle",
            connectionAfter: "open",
            reconnectsBefore: 0,
            reconnectsAfter: 1
          }
        ]
      }
    });
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((msg: string | Uint8Array) => {
      chunks.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
      return true;
    });
    try {
      printPromptSummary(summary, "text");
    } finally {
      spy.mockRestore();
    }
    const out = chunks.join("");
    expect(out).toContain("Hello\n");
    expect(out).toContain("[tool_use bash id=t1]");
    expect(out).toContain("[mcp servers=1 sse_sessions=1/1 reconnects=1]");
    expect(out).toContain("[mcp remoteSse session idle->open reconnects 0->1]");
  });
});
