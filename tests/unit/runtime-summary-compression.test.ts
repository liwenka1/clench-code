import { describe, expect, test } from "vitest";

import {
  compressSummary,
  compressSummaryText,
  defaultSummaryCompressionBudget
} from "../../src/runtime/summary-compression.js";

describe("runtime summary compression", () => {
  test("ports summary compression behavior", async () => {
    const duplicateSummary = [
      "Conversation summary:",
      "",
      "- Scope:   compact   earlier   messages.",
      "- Scope: compact earlier messages.",
      "- Current work: update runtime module."
    ].join("\n");

    const duplicateResult = compressSummary(duplicateSummary, defaultSummaryCompressionBudget);
    expect(duplicateResult.removedDuplicateLines).toBe(1);
    expect(duplicateResult.summary).toContain("- Scope: compact earlier messages.");
    expect(duplicateResult.summary).not.toContain("  compact   earlier");

    const tightBudget = compressSummary(
      [
        "Conversation summary:",
        "- Scope: 18 earlier messages compacted.",
        "- Current work: finish summary compression.",
        "- Key timeline:",
        "  - user: asked for a working implementation.",
        "  - assistant: inspected runtime compaction flow.",
        "  - tool: cargo check succeeded."
      ].join("\n"),
      { maxChars: 120, maxLines: 3, maxLineChars: 80 }
    );
    expect(tightBudget.summary).toContain("Conversation summary:");
    expect(tightBudget.summary).toContain("- Scope: 18 earlier messages compacted.");
    expect(tightBudget.summary).toContain("- Current work: finish summary compression.");
    expect(tightBudget.omittedLines).toBeGreaterThan(0);

    expect(compressSummaryText("Summary:\n\nA short line.")).toBe("Summary:\nA short line.");
  });
});
