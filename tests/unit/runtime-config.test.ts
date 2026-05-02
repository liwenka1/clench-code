import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadRuntimeConfig, pluginState, resolveConfigLayers, setPluginEnabled } from "../../src/runtime";

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

  test("skips malformed config while exposing load diagnostics", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clench-config-"));
    fs.writeFileSync(path.join(cwd, ".clench.json"), '{"model":');

    const loaded = loadRuntimeConfig(cwd);

    expect(loaded.loadedFiles).toEqual([]);
    expect(loaded.merged).toEqual({});
    expect(loaded.loadDiagnostics).toHaveLength(1);
    expect(loaded.loadDiagnostics[0]?.kind).toBe("parse_error");
    expect(loaded.loadDiagnostics[0]?.path).toBe(path.join(cwd, ".clench.json"));
    expect(loaded.validation[path.join(cwd, ".clench.json")]?.errors[0]?.field).toBe("<parse>");
  });

  test("loads valid later layers after an earlier malformed config", () => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "clench-config-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clench-config-"));
    fs.mkdirSync(path.join(cwd, ".clench"));
    fs.writeFileSync(path.join(configHome, "settings.json"), '{"model":');
    fs.writeFileSync(path.join(cwd, ".clench", "settings.local.json"), '{"model":"sonnet"}');

    const previousConfigHome = process.env.CLENCH_CONFIG_HOME;
    process.env.CLENCH_CONFIG_HOME = configHome;
    try {
      const loaded = loadRuntimeConfig(cwd);

      expect(loaded.loadedFiles).toEqual([path.join(cwd, ".clench", "settings.local.json")]);
      expect(loaded.merged.model).toBe("sonnet");
      expect(loaded.loadDiagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["parse_error"]);
    } finally {
      if (previousConfigHome === undefined) {
        delete process.env.CLENCH_CONFIG_HOME;
      } else {
        process.env.CLENCH_CONFIG_HOME = previousConfigHome;
      }
    }
  });
});
