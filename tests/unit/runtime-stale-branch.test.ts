import { describe, expect, test } from "vitest";

import { applyStaleBranchPolicy, detectBranchFreshness } from "../../src/runtime";

describe("runtime stale branch", () => {
  test("fresh_branch_passes", async () => {
    expect(detectBranchFreshness(0)).toEqual({ type: "fresh" });
  });

  test("stale_branch_detected_with_correct_behind_count_and_missing_fixes", async () => {
    expect(detectBranchFreshness(5, ["fix-123"])).toEqual({
      type: "stale",
      commitsBehind: 5,
      missingFixes: ["fix-123"]
    });
  });

  test("policy_warn_for_stale_branch", async () => {
    const action = applyStaleBranchPolicy(
      { type: "stale", commitsBehind: 2, missingFixes: ["fix-456"] },
      "warn-only"
    );

    expect(action).toMatchObject({ type: "warn" });
    expect(action.type === "warn" ? action.message : "").toContain("2 commit(s) behind main");
  });

  test("policy_auto_rebase_for_stale_branch", async () => {
    expect(
      applyStaleBranchPolicy({ type: "stale", commitsBehind: 5, missingFixes: [] }, "auto-rebase")
    ).toEqual({ type: "rebase" });
  });

  test("policy_auto_merge_forward_for_diverged_branch", async () => {
    expect(
      applyStaleBranchPolicy(
        { type: "diverged", commitsBehind: 3, missingFixes: [] },
        "auto-merge-forward"
      )
    ).toEqual({ type: "merge_forward" });
  });
});
