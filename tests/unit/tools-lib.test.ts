import { describe, expect, test } from "vitest";

import { PermissionPolicy } from "../../src/runtime/index.js";
import {
  GlobalToolRegistry,
  allowedToolsForSubagent,
  executeTool,
  normalizeAllowedTools
} from "../../src/tools/index.js";

describe("tools library", () => {
  test("ports normalize_allowed_tools behavior", async () => {
    expect(normalizeAllowedTools(["Read", "Bash", "mcp__demo__echo"])).toEqual([
      "read_file",
      "bash",
      "mcp__demo__echo"
    ]);
    expect(() => normalizeAllowedTools(["Nope"])).toThrow("unknown tool");
  });

  test("ports registry definitions and permission spec behavior", async () => {
    const registry = GlobalToolRegistry.builtin();
    const entries = registry.entries();
    expect(entries.some((entry) => entry.name === "read_file" && entry.requiredPermission === "read-only")).toBe(true);
    expect(entries.some((entry) => entry.name === "write_file" && entry.requiredPermission === "workspace-write")).toBe(true);
    expect(entries.some((entry) => entry.name === "bash" && entry.requiredPermission === "danger-full-access")).toBe(true);
  });

  test("ports execute_tool permission gating behavior", async () => {
    expect(
      executeTool("write_file", { path: "demo.txt" }, new PermissionPolicy("workspace-write"))
    ).toBe("demo.txt");
    expect(() =>
      executeTool("write_file", { path: "demo.txt" }, new PermissionPolicy("read-only"))
    ).toThrow("requires workspace-write permission");
    expect(() =>
      executeTool("bash", { command: "pwd" }, new PermissionPolicy("workspace-write"))
    ).toThrow("requires approval");
  });

  test("ports tool search and subagent tool allow-list behavior", async () => {
    const registry = GlobalToolRegistry.builtin();
    const search = registry.search("bash", 5);
    expect(search).toEqual([{ name: "bash", source: "runtime" }]);

    const general = allowedToolsForSubagent("general-purpose");
    const explore = allowedToolsForSubagent("Explore");
    const plan = allowedToolsForSubagent("Plan");
    const verification = allowedToolsForSubagent("Verification");

    expect(general.has("write_file")).toBe(true);
    expect(explore.has("write_file")).toBe(false);
    expect(plan.has("glob_search")).toBe(true);
    expect(verification.has("bash")).toBe(true);
  });
});
