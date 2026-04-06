import { describe, expect, test } from "vitest";

import { pluginState, resolveConfigLayers, setPluginEnabled } from "../../src/runtime";

describe("runtime config", () => {
  test("ports config discovery order and merge precedence behavior", async () => {
    const resolved = resolveConfigLayers([
      { model: "haiku", sandbox: { enabled: false } },
      { sandbox: { enabled: true } },
      { model: "sonnet" }
    ]);

    expect(resolved.model).toBe("sonnet");
    expect(resolved.sandbox?.enabled).toBe(true);
  });

  test("ports plugin state lookup and mutation behavior", async () => {
    const config = setPluginEnabled({}, "gitlens", true);
    expect(pluginState(config, "gitlens")).toEqual({ enabled: true });

    const disabled = setPluginEnabled(config, "gitlens", false);
    expect(pluginState(disabled, "gitlens")).toEqual({ enabled: false });
  });
});
