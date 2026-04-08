import { describe, expect, test } from "vitest";

import { pluginState, resolveConfigLayers, setPluginEnabled } from "../../src/runtime";

describe("runtime config", () => {
  test("ports config discovery order and merge precedence behavior", async () => {
    const resolved = resolveConfigLayers([
      { model: "haiku", sandbox: { enabled: false }, plugins: { demo: { enabled: false, path: "/tmp/demo" } } },
      { sandbox: { enabled: true }, mcp: { demo: { command: "node" } } },
      { model: "sonnet", plugins: { demo: { enabled: true } } }
    ]);

    expect(resolved.model).toBe("sonnet");
    expect(resolved.sandbox?.enabled).toBe(true);
    expect(resolved.plugins?.demo).toEqual({ enabled: true, path: "/tmp/demo" });
    expect(resolved.mcp).toEqual({ demo: { command: "node" } });
  });

  test("ports plugin state lookup and mutation behavior", async () => {
    const config = setPluginEnabled({}, "gitlens", true);
    expect(pluginState(config, "gitlens")).toEqual({ enabled: true });

    const disabled = setPluginEnabled(config, "gitlens", false);
    expect(pluginState(disabled, "gitlens")).toEqual({ enabled: false });
  });
});
