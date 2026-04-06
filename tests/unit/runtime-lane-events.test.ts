import { describe, expect, test } from "vitest";

import {
  LaneEventName,
  LaneFailureClass,
  blockedLaneEvent,
  failedLaneEvent,
  finishedLaneEvent,
  startedLaneEvent
} from "../../src/runtime/lane-events.js";

describe("runtime lane events", () => {
  test("ports lane event helper behavior", async () => {
    expect(LaneEventName.Started).toBe("lane.started");
    expect(LaneEventName.BranchStaleAgainstMain).toBe("branch.stale_against_main");
    expect(LaneFailureClass.McpStartup).toBe("mcp_startup");

    const blocker = {
      failureClass: LaneFailureClass.McpStartup,
      detail: "broken server"
    } as const;

    expect(startedLaneEvent("2026-04-04T00:00:00Z")).toEqual({
      event: "lane.started",
      status: "running",
      emittedAt: "2026-04-04T00:00:00Z"
    });
    expect(finishedLaneEvent("2026-04-04T00:00:01Z", "done")).toEqual({
      event: "lane.finished",
      status: "completed",
      emittedAt: "2026-04-04T00:00:01Z",
      detail: "done"
    });
    expect(blockedLaneEvent("2026-04-04T00:00:02Z", blocker)).toMatchObject({
      event: "lane.blocked",
      status: "blocked",
      failureClass: "mcp_startup",
      detail: "broken server"
    });
    expect(failedLaneEvent("2026-04-04T00:00:03Z", blocker)).toMatchObject({
      event: "lane.failed",
      status: "failed",
      failureClass: "mcp_startup",
      detail: "broken server"
    });
  });
});
