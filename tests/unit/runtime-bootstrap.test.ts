import { describe, expect, test } from "vitest";

import { BootstrapPlan } from "../../src/runtime/bootstrap.js";

describe("runtime bootstrap", () => {
  test("ports bootstrap helper behavior", async () => {
    const plan = BootstrapPlan.fromPhases([
      "cli_entry",
      "fast_path_version",
      "cli_entry",
      "main_runtime",
      "fast_path_version"
    ]);

    expect(plan.phases()).toEqual(["cli_entry", "fast_path_version", "main_runtime"]);
    expect(BootstrapPlan.claudeCodeDefault().phases()).toEqual([
      "cli_entry",
      "fast_path_version",
      "startup_profiler",
      "system_prompt_fast_path",
      "chrome_mcp_fast_path",
      "daemon_worker_fast_path",
      "bridge_fast_path",
      "daemon_fast_path",
      "background_session_fast_path",
      "template_fast_path",
      "environment_runner_fast_path",
      "main_runtime"
    ]);
  });
});
