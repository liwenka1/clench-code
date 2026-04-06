import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  PluginDefinition,
  PluginHooks,
  PluginLifecycle,
  PluginTool,
  defaultToolPermissionLabel,
  parsePluginKind,
  parsePluginPermission,
  parsePluginToolPermission
} from "../../src/plugins/index.js";

describe("plugins library", () => {
  test("ports plugin metadata merge and emptiness behavior", async () => {
    const base = new PluginHooks(["pre-one"], [], []);
    const extra = new PluginHooks([], ["post-two"], ["failure-three"]);
    const merged = base.mergedWith(extra);

    expect(new PluginHooks().isEmpty()).toBe(true);
    expect(merged.isEmpty()).toBe(false);
    expect(merged.preToolUse).toEqual(["pre-one"]);
    expect(merged.postToolUse).toEqual(["post-two"]);
    expect(merged.postToolUseFailure).toEqual(["failure-three"]);
    expect(new PluginLifecycle([], []).isEmpty()).toBe(true);
  });

  test("ports plugin kind and permission parsing behavior", async () => {
    expect(parsePluginKind("external")).toBe("external");
    expect(parsePluginPermission("write")).toBe("write");
    expect(parsePluginToolPermission("workspace-write")).toBe("workspace-write");
    expect(defaultToolPermissionLabel()).toBe("workspace-write");
    expect(parsePluginKind("invalid")).toBeUndefined();
    expect(parsePluginToolPermission("admin")).toBeUndefined();
  });

  test("ports plugin tool execution and lifecycle validation behavior", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "plugin-lib-"));
    const toolScript = path.join(root, "echo-json.sh");
    writeFileSync(
      toolScript,
      "#!/bin/sh\nINPUT=$(cat)\nprintf '{\"plugin\":\"%s\",\"tool\":\"%s\",\"input\":%s}' \"$CLAWD_PLUGIN_ID\" \"$CLAWD_TOOL_NAME\" \"$INPUT\"\n",
      "utf8"
    );
    chmodSync(toolScript, 0o755);

    const plugin = new PluginDefinition(
      {
        name: "demo-plugin",
        version: "1.0.0",
        description: "Demo plugin"
      },
      new PluginHooks(),
      new PluginLifecycle(["printf 'plugin init'"], ["printf 'plugin shutdown'"]),
      [
        new PluginTool(
          "demo-plugin@external",
          "demo-plugin",
          { name: "plugin_echo", inputSchema: { type: "object" } },
          toolScript
        )
      ]
    );

    plugin.validate();
    expect(plugin.initialize()).toEqual(["plugin init"]);
    expect(plugin.shutdown()).toEqual(["plugin shutdown"]);
    expect(plugin.tools[0]?.requiredPermission).toBe("workspace-write");
    expect(plugin.tools[0]?.execute({ message: "hello" })).toContain("demo-plugin@external");

    expect(() =>
      new PluginDefinition(
        { name: "", version: "1.0.0", description: "broken" },
        new PluginHooks()
      ).validate()
    ).toThrow("plugin name cannot be empty");

    rmSync(root, { recursive: true, force: true });
  });
});
