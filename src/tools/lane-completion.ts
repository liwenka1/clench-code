import {
  PolicyEngine,
  laneContext,
  policyRule,
  type LaneContext,
  type PolicyAction
} from "../runtime/policy.js";

export interface AgentOutput {
  agentId: string;
  status: string;
  currentBlocker?: string;
  error?: string;
}

export function detectLaneCompletion(
  output: AgentOutput,
  testGreen: boolean,
  hasPushed: boolean
): LaneContext | undefined {
  if (output.error) {
    return undefined;
  }
  if (!["completed", "finished"].includes(output.status.toLowerCase())) {
    return undefined;
  }
  if (output.currentBlocker) {
    return undefined;
  }
  if (!testGreen || !hasPushed) {
    return undefined;
  }

  return laneContext(output.agentId, 3, 0, "none", "approved", "scoped", false, true);
}

export function evaluateCompletedLane(context: LaneContext): PolicyAction[] {
  const engine = new PolicyEngine([
    policyRule(
      "closeout-completed-lane",
      {
        type: "and",
        conditions: [
          { type: "lane_completed" },
          { type: "green_at", level: 3 }
        ]
      },
      { type: "closeout_lane" },
      10
    ),
    policyRule(
      "cleanup-completed-session",
      { type: "lane_completed" },
      { type: "cleanup_lane" },
      5
    )
  ]);

  return engine.evaluate(context);
}
