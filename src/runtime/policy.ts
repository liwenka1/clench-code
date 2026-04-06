export type ReviewStatus = "pending" | "approved";
export type DiffScope = "full" | "scoped";
export type LaneBlocker = "none" | "startup";
export type ReconcileReason = "already-merged";
export type StaleBranchPolicy = "warn-only" | "auto-rebase" | "auto-merge-forward";

export type BranchFreshness =
  | { type: "fresh" }
  | { type: "stale"; commitsBehind: number; missingFixes: string[] }
  | { type: "diverged"; commitsBehind: number; missingFixes: string[] };

export type StaleBranchAction =
  | { type: "noop" }
  | { type: "warn"; message: string }
  | { type: "rebase" }
  | { type: "merge_forward" };

export type PolicyCondition =
  | { type: "stale_branch" }
  | { type: "green_at"; level: number }
  | { type: "lane_reconciled" }
  | { type: "lane_completed" }
  | { type: "review_passed" }
  | { type: "diff_scoped" }
  | { type: "startup_blocked" }
  | { type: "and"; conditions: PolicyCondition[] };

export type PolicyAction =
  | { type: "merge_forward" }
  | { type: "merge_to_dev" }
  | { type: "closeout_lane" }
  | { type: "cleanup_lane" }
  | { type: "restart_worker" }
  | { type: "escalate" }
  | { type: "notify"; channel: string }
  | { type: "reconcile"; reason: ReconcileReason };

export interface PolicyRule {
  name: string;
  condition: PolicyCondition;
  action: PolicyAction;
  priority: number;
}

export interface LaneContext {
  laneName: string;
  greenLevel: number;
  staleAgeMs: number;
  blocker: LaneBlocker;
  reviewStatus: ReviewStatus;
  diffScope: DiffScope;
  reconciled: boolean;
  completed: boolean;
}

export const STALE_BRANCH_THRESHOLD_MS = 60 * 60 * 1000;

export function laneContext(
  laneName: string,
  greenLevel: number,
  staleAgeMs: number,
  blocker: LaneBlocker,
  reviewStatus: ReviewStatus,
  diffScope: DiffScope,
  reconciled: boolean,
  completed = false
): LaneContext {
  return {
    laneName,
    greenLevel,
    staleAgeMs,
    blocker,
    reviewStatus,
    diffScope,
    reconciled,
    completed
  };
}

export function reconciledLaneContext(laneName: string): LaneContext {
  return laneContext(laneName, 0, 0, "none", "pending", "full", true, true);
}

export function completedLaneContext(laneName: string): LaneContext {
  return laneContext(laneName, 0, 0, "none", "pending", "full", false, true);
}

export function policyRule(
  name: string,
  condition: PolicyCondition,
  action: PolicyAction,
  priority: number
): PolicyRule {
  return { name, condition, action, priority };
}

export class PolicyEngine {
  constructor(private readonly rules: PolicyRule[]) {}

  evaluate(context: LaneContext): PolicyAction[] {
    return [...this.rules]
      .map((rule, index) => ({ rule, index }))
      .sort((left, right) => left.rule.priority - right.rule.priority || left.index - right.index)
      .filter(({ rule }) => matchesCondition(rule.condition, context))
      .map(({ rule }) => rule.action);
  }
}

export type GreenLevel = 1 | 3 | 4;

export class GreenContract {
  constructor(private readonly requiredLevel: GreenLevel) {}

  isSatisfiedBy(level?: number): boolean {
    return typeof level === "number" && level >= this.requiredLevel;
  }
}

export function detectBranchFreshness(
  commitsBehind: number,
  missingFixes: string[] = [],
  diverged = false
): BranchFreshness {
  if (commitsBehind <= 0 && !diverged) {
    return { type: "fresh" };
  }
  if (diverged) {
    return { type: "diverged", commitsBehind, missingFixes };
  }
  return { type: "stale", commitsBehind, missingFixes };
}

export function applyStaleBranchPolicy(
  freshness: BranchFreshness,
  policy: StaleBranchPolicy
): StaleBranchAction {
  if (freshness.type === "fresh") {
    return { type: "noop" };
  }
  if (policy === "auto-rebase") {
    return { type: "rebase" };
  }
  if (policy === "auto-merge-forward") {
    return { type: "merge_forward" };
  }
  return {
    type: "warn",
    message: `${freshness.commitsBehind} commit(s) behind main${freshness.missingFixes.length > 0 ? `; missing fixes: ${freshness.missingFixes.join(", ")}` : ""}`
  };
}

function matchesCondition(condition: PolicyCondition, context: LaneContext): boolean {
  if (condition.type === "stale_branch") {
    return context.staleAgeMs >= STALE_BRANCH_THRESHOLD_MS;
  }
  if (condition.type === "green_at") {
    return context.greenLevel >= condition.level;
  }
  if (condition.type === "lane_reconciled") {
    return context.reconciled;
  }
  if (condition.type === "lane_completed") {
    return context.completed;
  }
  if (condition.type === "review_passed") {
    return context.reviewStatus === "approved";
  }
  if (condition.type === "diff_scoped") {
    return context.diffScope === "scoped";
  }
  if (condition.type === "startup_blocked") {
    return context.blocker === "startup";
  }
  return condition.conditions.every((child) => matchesCondition(child, context));
}
