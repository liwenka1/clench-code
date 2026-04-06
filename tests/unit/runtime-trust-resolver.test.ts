import { describe, expect, test } from "vitest";

import {
  TrustConfig,
  TrustResolver,
  detectTrustPrompt,
  pathMatchesTrustedRoot,
  trustDecisionEvents,
  trustDecisionPolicy
} from "../../src/runtime/trust-resolver.js";

describe("runtime trust resolver", () => {
  test("ports trust resolution logic", async () => {
    const screenText = "Do you trust the files in this folder?\n1. Yes, proceed\n2. No";
    expect(detectTrustPrompt(screenText)).toBe(true);

    const resolverAllow = new TrustResolver(new TrustConfig().withAllowlisted("/tmp/worktrees"));
    const noPrompt = resolverAllow.resolve("/tmp/worktrees/repo-a", "Ready for your input\n>");
    expect(noPrompt).toEqual({ type: "not_required" });
    expect(trustDecisionEvents(noPrompt)).toEqual([]);
    expect(trustDecisionPolicy(noPrompt)).toBeUndefined();

    const auto = resolverAllow.resolve("/tmp/worktrees/repo-a", screenText);
    expect(trustDecisionPolicy(auto)).toBe("auto_trust");
    expect(trustDecisionEvents(auto)).toEqual([
      { type: "trust_required", cwd: "/tmp/worktrees/repo-a" },
      { type: "trust_resolved", cwd: "/tmp/worktrees/repo-a", policy: "auto_trust" }
    ]);

    const needApproval = resolverAllow.resolve("/tmp/other/repo-b", screenText);
    expect(trustDecisionPolicy(needApproval)).toBe("require_approval");
    expect(trustDecisionEvents(needApproval)).toEqual([
      { type: "trust_required", cwd: "/tmp/other/repo-b" }
    ]);

    const denied = new TrustResolver(
      new TrustConfig().withAllowlisted("/tmp/worktrees").withDenied("/tmp/worktrees/repo-c")
    ).resolve("/tmp/worktrees/repo-c", screenText);
    expect(trustDecisionPolicy(denied)).toBe("deny");
    expect(trustDecisionEvents(denied)).toEqual([
      { type: "trust_required", cwd: "/tmp/worktrees/repo-c" },
      {
        type: "trust_denied",
        cwd: "/tmp/worktrees/repo-c",
        reason: "cwd matches denied trust root: /tmp/worktrees/repo-c"
      }
    ]);

    expect(pathMatchesTrustedRoot("/tmp/worktrees-other/repo-d", "/tmp/worktrees")).toBe(false);
  });
});
