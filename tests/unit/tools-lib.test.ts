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
    expect(normalizeAllowedTools(["Write", "Grep", "Glob"])).toEqual([
      "write_file",
      "grep_search",
      "glob_search"
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

  test("execute_tool_read_only_tools_succeed_under_read_only_policy", () => {
    const ro = new PermissionPolicy("read-only");
    expect(executeTool("read_file", { path: "src/a.ts" }, ro)).toContain("src/a.ts");
    expect(executeTool("grep_search", { pattern: "foo", path: "." }, ro)).toContain("foo");
    expect(executeTool("glob_search", { glob_pattern: "*.ts" }, ro)).toContain("glob_pattern");
  });

  test("execute_tool_task_and_toolsearch_succeed_under_read_only_policy", () => {
    const ro = new PermissionPolicy("read-only");
    const taskOut = JSON.parse(
      executeTool("Task", { subagent_type: "Explore" }, ro) as string
    ) as { subagentType: string; allowedTools: string[] };
    expect(taskOut.subagentType).toBe("Explore");
    expect(taskOut.allowedTools).toContain("read_file");

    const searchOut = executeTool("ToolSearch", { query: "bash", maxResults: 3 }, ro);
    expect(searchOut).toContain("bash");
  });

  test("execute_tool_unknown_name_throws", () => {
    expect(() =>
      executeTool("not_a_registered_tool", {}, new PermissionPolicy("danger-full-access"))
    ).toThrow("unknown tool");
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
