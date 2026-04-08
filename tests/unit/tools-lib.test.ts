import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { PermissionPolicy } from "../../src/runtime/index.js";
import { PluginDefinition, PluginHooks, PluginTool } from "../../src/plugins/index.js";
import {
  GlobalToolRegistry,
  allowedToolsForSubagent,
  executeTool,
  loadWorkspaceToolRegistry,
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
    expect(entries.some((entry) => entry.name === "Config" && entry.requiredPermission === "read-only")).toBe(true);
    expect(entries.some((entry) => entry.name === "MCP" && entry.requiredPermission === "read-only")).toBe(true);
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

  test("execute_tool_supports_config_and_mcp_surface", () => {
    const ro = new PermissionPolicy("read-only");
    expect(executeTool("Config", { section: "model", value: "sonnet" }, ro)).toContain('"section":"model"');
    expect(executeTool("MCP", { server: "demo", toolName: "echo", arguments: { ok: true } }, ro)).toContain('"server":"demo"');
    expect(executeTool("ListMcpResources", { server: "demo" }, ro)).toContain('"resources":[]');
    expect(executeTool("ReadMcpResource", { server: "demo", uri: "resource://demo", fallback: "body" }, ro)).toContain('"resource://demo"');
  });

  test("registry_can_include_plugin_tools", () => {
    const registry = GlobalToolRegistry.builtin().withPlugins([
      new PluginDefinition(
        { name: "demo", version: "1.0.0", description: "Demo plugin" },
        new PluginHooks(),
        undefined,
        [
          new PluginTool(
            "demo@external",
            "demo",
            { name: "plugin_echo", inputSchema: { type: "object" } },
            process.execPath,
            [
              "--input-type=module",
              "-e",
              "const chunks=[];for await (const c of process.stdin) chunks.push(c);process.stdout.write(JSON.stringify({plugin:process.env.CLAWD_PLUGIN_ID,input:JSON.parse(Buffer.concat(chunks).toString('utf8'))}))"
            ]
          )
        ]
      )
    ]);

    expect(registry.entries().some((entry) => entry.name === "plugin_echo" && entry.source === "plugin")).toBe(true);
    expect(
      registry
        .withPermissionPolicy(new PermissionPolicy("workspace-write"))
        .executeTool("plugin_echo", { message: "hello" })
    ).toContain("demo@external");
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
    expect(explore.has("ListMcpResources")).toBe(true);
    expect(plan.has("Config")).toBe(true);
  });

  test("workspace_tool_registry_loads_enabled_plugins_from_config", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tool-registry-"));
    const pluginScript = path.join(root, "echo-json.sh");
    const pluginManifest = path.join(root, "demo-plugin.json");
    const localConfig = path.join(root, ".clench", "settings.local.json");
    writeFileSync(
      pluginScript,
      "#!/bin/sh\nINPUT=$(cat)\nprintf '{\"plugin\":\"%s\",\"input\":%s}' \"$CLAWD_PLUGIN_ID\" \"$INPUT\"\n",
      "utf8"
    );
    chmodSync(pluginScript, 0o755);
    writeFileSync(
      pluginManifest,
      JSON.stringify(
        {
          metadata: {
            name: "demo-plugin",
            version: "1.0.0",
            description: "Demo plugin"
          },
          tools: [{ name: "plugin_echo", command: "./echo-json.sh" }]
        },
        null,
        2
      ),
      "utf8"
    );
    mkdirSync(path.dirname(localConfig), { recursive: true });
    writeFileSync(
      localConfig,
      JSON.stringify(
        {
          plugins: {
            "demo-plugin": {
              enabled: true,
              path: pluginManifest
            }
          },
          mcp: {
            demo: {
              type: "sdk",
              name: "demo-sdk",
              tools: [
                {
                  name: "echo",
                  description: "Echo MCP tool",
                  inputSchema: { type: "object" },
                  echoArguments: true
                }
              ]
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const registry = loadWorkspaceToolRegistry(root, new PermissionPolicy("workspace-write"));
      expect(registry.entries().some((entry) => entry.name === "plugin_echo" && entry.source === "plugin")).toBe(true);
      expect(registry.entries().some((entry) => entry.name === "mcp__demo__echo")).toBe(true);
      expect(registry.toolDefinition("plugin_echo")?.name).toBe("plugin_echo");
      expect(registry.toolDefinition("mcp__demo__echo")?.name).toBe("mcp__demo__echo");
      expect(executeTool("Config", { section: "model" }, new PermissionPolicy("read-only"))).toContain("section");
      expect(registry.executeTool("plugin_echo", { message: "hello" })).toContain("demo-plugin@external");
      expect(registry.executeTool("mcp__demo__echo", { text: "hello mcp" })).toContain("hello mcp");
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
