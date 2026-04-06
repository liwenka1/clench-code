export const LaneEventName = {
  Started: "lane.started",
  Ready: "lane.ready",
  PromptMisdelivery: "lane.prompt_misdelivery",
  Blocked: "lane.blocked",
  Red: "lane.red",
  Green: "lane.green",
  CommitCreated: "lane.commit.created",
  PrOpened: "lane.pr.opened",
  MergeReady: "lane.merge.ready",
  Finished: "lane.finished",
  Failed: "lane.failed",
  Reconciled: "lane.reconciled",
  Merged: "lane.merged",
  Superseded: "lane.superseded",
  Closed: "lane.closed",
  BranchStaleAgainstMain: "branch.stale_against_main"
} as const;

export const LaneEventStatus = {
  Running: "running",
  Ready: "ready",
  Blocked: "blocked",
  Red: "red",
  Green: "green",
  Completed: "completed",
  Failed: "failed",
  Reconciled: "reconciled",
  Merged: "merged",
  Superseded: "superseded",
  Closed: "closed"
} as const;

export const LaneFailureClass = {
  PromptDelivery: "prompt_delivery",
  TrustGate: "trust_gate",
  BranchDivergence: "branch_divergence",
  Compile: "compile",
  Test: "test",
  PluginStartup: "plugin_startup",
  McpStartup: "mcp_startup",
  McpHandshake: "mcp_handshake",
  GatewayRouting: "gateway_routing",
  ToolRuntime: "tool_runtime",
  Infra: "infra"
} as const;

export type LaneEventNameValue = (typeof LaneEventName)[keyof typeof LaneEventName];
export type LaneEventStatusValue = (typeof LaneEventStatus)[keyof typeof LaneEventStatus];
export type LaneFailureClassValue = (typeof LaneFailureClass)[keyof typeof LaneFailureClass];

export interface LaneEventBlocker {
  failureClass: LaneFailureClassValue;
  detail: string;
}

export interface LaneEvent {
  event: LaneEventNameValue;
  status: LaneEventStatusValue;
  emittedAt: string;
  failureClass?: LaneFailureClassValue;
  detail?: string;
  data?: unknown;
}

export function laneEvent(
  event: LaneEventNameValue,
  status: LaneEventStatusValue,
  emittedAt: string
): LaneEvent {
  return { event, status, emittedAt };
}

export function startedLaneEvent(emittedAt: string): LaneEvent {
  return laneEvent(LaneEventName.Started, LaneEventStatus.Running, emittedAt);
}

export function finishedLaneEvent(emittedAt: string, detail?: string): LaneEvent {
  return {
    ...laneEvent(LaneEventName.Finished, LaneEventStatus.Completed, emittedAt),
    detail
  };
}

export function blockedLaneEvent(emittedAt: string, blocker: LaneEventBlocker): LaneEvent {
  return {
    ...laneEvent(LaneEventName.Blocked, LaneEventStatus.Blocked, emittedAt),
    failureClass: blocker.failureClass,
    detail: blocker.detail
  };
}

export function failedLaneEvent(emittedAt: string, blocker: LaneEventBlocker): LaneEvent {
  return {
    ...laneEvent(LaneEventName.Failed, LaneEventStatus.Failed, emittedAt),
    failureClass: blocker.failureClass,
    detail: blocker.detail
  };
}
