import { describe, expect, test } from "vitest";

import { laneContext } from "../../src/runtime/policy.js";
import {
  detectLaneCompletion,
  evaluateCompletedLane
} from "../../src/tools/lane-completion.js";

describe("lane completion", () => {
  test("detects_completion_when_all_conditions_met", async () => {
    const result = detectLaneCompletion(
      { agentId: "test-lane-1", status: "Finished" },
      true,
      true
    );

    expect(result?.completed).toBe(true);
    expect(result?.greenLevel).toBe(3);
    expect(result?.reviewStatus).toBe("approved");
  });

  test("no_completion_when_error_present", async () => {
    expect(
      detectLaneCompletion(
        { agentId: "test-lane-1", status: "Finished", error: "Build failed" },
        true,
        true
      )
    ).toBeUndefined();
  });

  test("no_completion_when_not_finished", async () => {
    expect(
      detectLaneCompletion(
        { agentId: "test-lane-1", status: "Running" },
        true,
        true
      )
    ).toBeUndefined();
  });

  test("no_completion_when_tests_not_green", async () => {
    expect(
      detectLaneCompletion(
        { agentId: "test-lane-1", status: "Finished" },
        false,
        true
      )
    ).toBeUndefined();
  });

  test("no_completion_when_not_pushed", async () => {
    expect(
      detectLaneCompletion(
        { agentId: "test-lane-1", status: "Finished" },
        true,
        false
      )
    ).toBeUndefined();
  });

  test("evaluate_triggers_closeout_for_completed_lane", async () => {
    const actions = evaluateCompletedLane(
      laneContext("completed-lane", 3, 0, "none", "approved", "scoped", false, true)
    );

    expect(actions).toContainEqual({ type: "closeout_lane" });
    expect(actions).toContainEqual({ type: "cleanup_lane" });
  });
});
