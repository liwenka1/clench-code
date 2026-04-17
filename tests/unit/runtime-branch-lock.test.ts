import { describe, expect, test } from "vitest";

import { detectBranchLockCollisions } from "../../src/runtime/branch-lock.js";

describe("runtime branch lock", () => {
  test("detects same branch same module collisions", () => {
    const collisions = detectBranchLockCollisions([
      {
        laneId: "lane-a",
        branch: "feature/lock",
        worktree: "wt-a",
        modules: ["runtime/mcp"]
      },
      {
        laneId: "lane-b",
        branch: "feature/lock",
        worktree: "wt-b",
        modules: ["runtime/mcp"]
      }
    ]);

    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toEqual({
      branch: "feature/lock",
      module: "runtime/mcp",
      laneIds: ["lane-a", "lane-b"]
    });
  });

  test("detects nested module scope collisions", () => {
    const collisions = detectBranchLockCollisions([
      {
        laneId: "lane-a",
        branch: "feature/lock",
        modules: ["runtime"]
      },
      {
        laneId: "lane-b",
        branch: "feature/lock",
        modules: ["runtime/mcp"]
      }
    ]);

    expect(collisions[0]?.module).toBe("runtime");
  });

  test("ignores different branches", () => {
    const collisions = detectBranchLockCollisions([
      {
        laneId: "lane-a",
        branch: "feature/a",
        modules: ["runtime/mcp"]
      },
      {
        laneId: "lane-b",
        branch: "feature/b",
        modules: ["runtime/mcp"]
      }
    ]);

    expect(collisions).toEqual([]);
  });
});
