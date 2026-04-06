import { describe, expect, test } from "vitest";

import {
  Session,
  UsageTracker,
  estimateCostUsd,
  formatUsd,
  pricingForModel,
  summaryLinesForModel,
  totalTokens
} from "../../src/runtime";

describe("runtime usage", () => {
  test("tracks_true_cumulative_usage", async () => {
    const tracker = new UsageTracker()
      .record({
        input_tokens: 10,
        output_tokens: 4,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 1
      })
      .record({
        input_tokens: 20,
        output_tokens: 6,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2
      });

    expect(tracker.turns()).toBe(2);
    expect(tracker.currentTurnUsage().input_tokens).toBe(20);
    expect(tracker.currentTurnUsage().output_tokens).toBe(6);
    expect(tracker.cumulativeUsage().output_tokens).toBe(10);
    expect(tracker.cumulativeUsage().input_tokens).toBe(30);
    expect(totalTokens(tracker.cumulativeUsage())).toBe(48);
  });

  test("computes_cost_summary_lines", async () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
      cache_creation_input_tokens: 100_000,
      cache_read_input_tokens: 200_000
    };

    const cost = estimateCostUsd(usage);
    expect(formatUsd(cost.inputCostUsd)).toBe("$15.0000");
    expect(formatUsd(cost.outputCostUsd)).toBe("$37.5000");
    const lines = summaryLinesForModel("usage", usage, "claude-sonnet-4-20250514");
    expect(lines[0]).toContain("estimated_cost=$54.6750");
    expect(lines[0]).toContain("model=claude-sonnet-4-20250514");
    expect(lines[1]).toContain("cache_read=$0.3000");
  });

  test("supports_model_specific_pricing", async () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    };

    const haiku = pricingForModel("claude-haiku-4-5-20251001");
    const opus = pricingForModel("claude-opus-4-6");
    expect(haiku).toBeDefined();
    expect(opus).toBeDefined();

    expect(formatUsd(estimateCostUsd(usage, haiku!).totalCostUsd)).toBe("$3.5000");
    expect(formatUsd(estimateCostUsd(usage, opus!).totalCostUsd)).toBe("$52.5000");
  });

  test("marks_unknown_model_pricing_as_fallback", async () => {
    const lines = summaryLinesForModel(
      "usage",
      {
        input_tokens: 100,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      },
      "custom-model"
    );

    expect(lines[0]).toContain("pricing=estimated-default");
  });

  test("reconstructs_usage_from_session_messages", async () => {
    const session = new Session("restored", [
      {
        role: "assistant",
        blocks: [{ type: "text", text: "done" }],
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 0
        }
      }
    ]);

    const tracker = UsageTracker.fromSession(session);
    expect(tracker.turns()).toBe(1);
    expect(totalTokens(tracker.cumulativeUsage())).toBe(8);
  });
});
