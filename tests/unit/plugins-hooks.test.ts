import { describe, expect, test } from "vitest";

import { HookRunner } from "../../src/plugins/hooks.js";
import { PluginHooks } from "../../src/plugins/index.js";

describe("plugins hooks", () => {
  test("ports plugin hook behavior", async () => {
    const runner = new HookRunner(
      new PluginHooks(
        ["printf 'plugin pre'"],
        ["printf 'plugin post'"],
        ["printf 'plugin failure'"]
      )
    );

    expect(runner.runPreToolUse("Read", '{"path":"README.md"}')).toEqual({
      denied: false,
      failed: false,
      messages: ["plugin pre"]
    });
    expect(runner.runPostToolUse("Read", '{"path":"README.md"}', "ok", false)).toEqual({
      denied: false,
      failed: false,
      messages: ["plugin post"]
    });
    expect(runner.runPostToolUseFailure("Read", '{"path":"README.md"}', "tool failed")).toEqual({
      denied: false,
      failed: false,
      messages: ["plugin failure"]
    });

    const denied = new HookRunner(new PluginHooks(["printf 'blocked by plugin'; exit 2"]));
    expect(denied.runPreToolUse("Bash", '{"command":"pwd"}').denied).toBe(true);

    const failed = new HookRunner(new PluginHooks(["printf 'broken plugin hook'; exit 1", "printf 'later plugin hook'"]));
    const result = failed.runPreToolUse("Bash", '{"command":"pwd"}');
    expect(result.failed).toBe(true);
    expect(result.messages).toContain("broken plugin hook");
    expect(result.messages).not.toContain("later plugin hook");
  });
});
