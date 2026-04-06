import { describe, expect, test } from "vitest";

import { executeBash } from "../../src/runtime";

describe("runtime bash integration", () => {
  test("executes_simple_command", async () => {
    const output = await executeBash({
      command: "printf 'hello'",
      timeout: 1000,
      dangerouslyDisableSandbox: false
    });

    expect(output.stdout).toBe("hello");
    expect(output.interrupted).toBe(false);
    expect(output.sandboxStatus).toEqual({ enabled: true });
  });

  test("disables_sandbox_when_requested", async () => {
    const output = await executeBash({
      command: "printf 'hello'",
      timeout: 1000,
      dangerouslyDisableSandbox: true
    });

    expect(output.sandboxStatus.enabled).toBe(false);
  });

  test("long_output_truncated", async () => {
    const output = await executeBash({
      command:
        "node -e \"process.stdout.write('x'.repeat(20000))\"",
      timeout: 1000,
      dangerouslyDisableSandbox: false
    });

    expect(output.stdout.length).toBeLessThan(20000);
    expect(output.stdout).toContain("[output truncated");
  });
});
