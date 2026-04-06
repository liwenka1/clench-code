import { describe, expect, test } from "vitest";

import {
  GreenContract,
  PolicyEngine,
  laneContext,
  policyRule,
  reconciledLaneContext
} from "../../src/runtime";

describe("runtime policy integration", () => {
  test("stale_branch_detection_flows_into_policy_engine", async () => {
    const staleContext = laneContext(
      "stale-lane",
      0,
      2 * 60 * 60 * 1000,
      "none",
      "pending",
      "full",
      false
    );
    const engine = new PolicyEngine([
      policyRule(
        "stale-merge-forward",
        { type: "stale_branch" },
        { type: "merge_forward" },
        10
      )
    ]);

    expect(engine.evaluate(staleContext)).toEqual([{ type: "merge_forward" }]);
  });

  test("green_contract_satisfied_allows_merge", async () => {
    const contract = new GreenContract(3);
    expect(contract.isSatisfiedBy(3)).toBe(true);
    expect(contract.isSatisfiedBy(4)).toBe(true);
    expect(contract.isSatisfiedBy(1)).toBe(false);
  });

  test("reconciled_lane_matches_reconcile_condition", async () => {
    const context = reconciledLaneContext("reconciled-lane");
    const engine = new PolicyEngine([
      policyRule(
        "reconcile-first",
        { type: "lane_reconciled" },
        { type: "reconcile", reason: "already-merged" },
        5
      ),
      policyRule(
        "generic-closeout",
        { type: "lane_completed" },
        { type: "closeout_lane" },
        30
      )
    ]);

    expect(engine.evaluate(context)).toEqual([
      { type: "reconcile", reason: "already-merged" },
      { type: "closeout_lane" }
    ]);
  });

  test("end_to_end_stale_lane_gets_merge_forward_action", async () => {
    const context = laneContext(
      "lane-9411",
      3,
      5 * 60 * 60 * 1000,
      "none",
      "approved",
      "scoped",
      false
    );
    const engine = new PolicyEngine([
      policyRule(
        "auto-merge-forward-if-stale-and-approved",
        {
          type: "and",
          conditions: [{ type: "stale_branch" }, { type: "review_passed" }]
        },
        { type: "merge_forward" },
        5
      ),
      policyRule(
        "stale-warning",
        { type: "stale_branch" },
        { type: "notify", channel: "#build-status" },
        10
      )
    ]);

    expect(engine.evaluate(context)).toEqual([
      { type: "merge_forward" },
      { type: "notify", channel: "#build-status" }
    ]);
  });
});
