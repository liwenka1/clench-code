import { describe, expect, test } from "vitest";

import { runHooks } from "../../src/runtime";

describe("runtime hooks", () => {
  test("ports hook runner behavior", async () => {
    const summary = await runHooks(
      [
        () => ({ type: "allow", message: "first" }),
        () => ({ type: "allow", message: "second" }),
        () => ({ type: "deny", reason: "blocked" }),
        () => ({ type: "allow", message: "never runs" })
      ],
      { toolName: "bash", input: "git status" }
    );

    expect(summary).toEqual({
      allowed: false,
      blockedBy: "blocked",
      feedback: ["first", "second", "blocked"]
    });
  });
});
