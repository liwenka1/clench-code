import { describe, expect, test } from "vitest";

import {
  PolicyEngine,
  STALE_BRANCH_THRESHOLD_MS,
  completedLaneContext,
  laneContext,
  policyRule,
  reconciledLaneContext
} from "../../src/runtime";

describe("runtime policy engine", () => {
  test("merge_to_dev_rule_fires_for_green_scoped_reviewed_lane", async () => {
    const context = laneContext("lane", 3, 0, "none", "approved", "scoped", false);
    const engine = new PolicyEngine([
      policyRule(
        "merge",
        {
          type: "and",
          conditions: [
            { type: "green_at", level: 3 },
            { type: "diff_scoped" },
            { type: "review_passed" }
          ]
        },
        { type: "merge_to_dev" },
        10
      )
    ]);

    expect(engine.evaluate(context)).toEqual([{ type: "merge_to_dev" }]);
  });

  test("stale_branch_rule_fires_at_threshold", async () => {
    const context = laneContext(
      "stale",
      0,
      STALE_BRANCH_THRESHOLD_MS,
      "none",
      "pending",
      "full",
      false
    );
    const engine = new PolicyEngine([
      policyRule("stale", { type: "stale_branch" }, { type: "merge_forward" }, 10)
    ]);

    expect(engine.evaluate(context)).toEqual([{ type: "merge_forward" }]);
  });

  test("startup_blocked_rule_recovers_then_escalates", async () => {
    const context = laneContext("blocked", 0, 0, "startup", "pending", "full", false);
    const engine = new PolicyEngine([
      policyRule("recover", { type: "startup_blocked" }, { type: "restart_worker" }, 5),
      policyRule("escalate", { type: "startup_blocked" }, { type: "escalate" }, 10)
    ]);

    expect(engine.evaluate(context)).toEqual([{ type: "restart_worker" }, { type: "escalate" }]);
  });

  test("completed_lane_rule_closes_out_and_cleans_up", async () => {
    const context = completedLaneContext("done");
    const engine = new PolicyEngine([
      policyRule("closeout", { type: "lane_completed" }, { type: "closeout_lane" }, 5),
      policyRule("cleanup", { type: "lane_completed" }, { type: "cleanup_lane" }, 10)
    ]);

    expect(engine.evaluate(context)).toEqual([{ type: "closeout_lane" }, { type: "cleanup_lane" }]);
  });

  test("matching_rules_are_returned_in_priority_order_with_stable_ties", async () => {
    const context = laneContext("lane", 3, 0, "none", "approved", "scoped", false);
    const engine = new PolicyEngine([
      policyRule("later", { type: "review_passed" }, { type: "notify", channel: "later" }, 20),
      policyRule("first-tie", { type: "review_passed" }, { type: "notify", channel: "first" }, 10),
      policyRule("second-tie", { type: "review_passed" }, { type: "notify", channel: "second" }, 10)
    ]);

    expect(engine.evaluate(context)).toEqual([
      { type: "notify", channel: "first" },
      { type: "notify", channel: "second" },
      { type: "notify", channel: "later" }
    ]);
  });

  test("reconciled_lane_emits_reconcile_and_cleanup", async () => {
    const context = reconciledLaneContext("reconciled");
    const engine = new PolicyEngine([
      policyRule(
        "reconcile",
        { type: "lane_reconciled" },
        { type: "reconcile", reason: "already-merged" },
        5
      ),
      policyRule("cleanup", { type: "lane_completed" }, { type: "cleanup_lane" }, 10)
    ]);

    expect(engine.evaluate(context)).toEqual([
      { type: "reconcile", reason: "already-merged" },
      { type: "cleanup_lane" }
    ]);
  });

  test("and_condition_requires_every_subcondition", () => {
    const context = laneContext("lane", 3, 0, "none", "approved", "full", false);
    const engine = new PolicyEngine([
      policyRule(
        "merge",
        {
          type: "and",
          conditions: [
            { type: "green_at", level: 3 },
            { type: "diff_scoped" },
            { type: "review_passed" }
          ]
        },
        { type: "merge_to_dev" },
        10
      )
    ]);

    expect(engine.evaluate(context)).toEqual([]);
  });

  test("evaluate_returns_empty_when_no_rule_matches", () => {
    const context = laneContext("lane", 1, 0, "none", "pending", "full", false);
    const engine = new PolicyEngine([
      policyRule("high", { type: "green_at", level: 4 }, { type: "notify", channel: "x" }, 10)
    ]);

    expect(engine.evaluate(context)).toEqual([]);
  });
});
