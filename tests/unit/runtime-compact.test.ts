import { describe, expect, test } from "vitest";

import { Session, compactSession, formatCompactSummary, shouldCompact } from "../../src/runtime";

describe("runtime compact", () => {
  test("ports conversation compaction behavior", async () => {
    const session = new Session("compact", [
      { role: "user", blocks: [{ type: "text", text: "first request" }] },
      { role: "assistant", blocks: [{ type: "text", text: "first reply" }] },
      { role: "user", blocks: [{ type: "text", text: "second request" }] },
      { role: "assistant", blocks: [{ type: "text", text: "second reply" }] }
    ]);

    expect(shouldCompact(session, { preserveRecentMessages: 2 })).toBe(true);
    const result = compactSession(session, { preserveRecentMessages: 2 });

    expect(result.removedMessageCount).toBe(2);
    expect(result.formattedSummary).toContain("Summary:");
    expect(result.compactedSession.compaction).toEqual({
      summary: result.summary,
      removedMessageCount: 2,
      count: 1
    });
    expect(result.compactedSession.messages[0]?.role).toBe("system");
    expect(result.compactedSession.messages).toHaveLength(3);
  });

  test("format_compact_summary_strips_analysis_wrappers", async () => {
    const formatted = formatCompactSummary(`
<analysis>
private notes
</analysis>
<summary>
Keep only the important summary.
</summary>
`);

    expect(formatted).toBe("Summary:\nKeep only the important summary.");
  });
});
