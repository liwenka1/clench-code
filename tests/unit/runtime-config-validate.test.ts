import { describe, expect, test } from "vitest";

import {
  checkUnsupportedConfigFormat,
  formatConfigDiagnostics,
  validateConfigFile
} from "../../src/runtime/config-validate.js";

describe("runtime config validate", () => {
  test("detects unknown top level key", () => {
    const result = validateConfigFile('{"model":"opus","unknownField":true}', "/test/settings.json");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.field).toBe("unknownField");
    expect(result.errors[0]?.kind.type).toBe("unknown_key");
  });

  test("detects wrong type for model", () => {
    const result = validateConfigFile('{"model":123}', "/test/settings.json");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.field).toBe("model");
    expect(result.errors[0]?.kind).toEqual({
      type: "wrong_type",
      expected: "a string",
      got: "a number"
    });
  });

  test("detects deprecated permission mode", () => {
    const result = validateConfigFile('{"permissionMode":"prompt"}', "/test/settings.json");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.field).toBe("permissionMode");
    expect(result.warnings[0]?.kind).toEqual({
      type: "deprecated",
      replacement: "permissions.defaultMode"
    });
  });

  test("reports line number for unknown key", () => {
    const result = validateConfigFile('{\n  "model":"opus",\n  "badKey": true\n}', "/test/settings.json");
    expect(result.errors[0]?.line).toBe(3);
  });

  test("validates nested hooks and sandbox keys", () => {
    const result = validateConfigFile(
      '{"hooks":{"PreToolUse":["cmd"],"BadHook":["x"]},"sandbox":{"enabled":true,"containerMode":"strict"}}',
      "/test/settings.json"
    );
    expect(result.errors.map((error) => error.field)).toEqual(["hooks.BadHook", "sandbox.containerMode"]);
  });

  test("validates plugin entry keys", () => {
    const result = validateConfigFile(
      '{"plugins":{"demo":{"enabled":true,"path":"./demo","autoUpdate":true}}}',
      "/test/settings.json"
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.field).toBe("plugins.demo.autoUpdate");
  });

  test("suggests close field names", () => {
    const result = validateConfigFile('{"modle":"opus"}', "/test/settings.json");
    expect(result.errors[0]?.kind).toEqual({
      type: "unknown_key",
      suggestion: "model"
    });
  });

  test("valid config produces no diagnostics", () => {
    const result = validateConfigFile(
      JSON.stringify({
        model: "opus",
        hooks: { PreToolUse: ["guard"] },
        permissions: { defaultMode: "read-only", allow: ["Read"] },
        mcp: {},
        sandbox: { enabled: false },
        plugins: { demo: { enabled: true, path: "/tmp/demo" } },
        oauth: { clientId: "abc", authorizeUrl: "https://a", tokenUrl: "https://b", scopes: ["mcp:read"] }
      }),
      "/test/settings.json"
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("formats diagnostics", () => {
    const result = validateConfigFile('{"permissionMode":"prompt","badKey":1}', "/test/settings.json");
    const output = formatConfigDiagnostics(result);
    expect(output).toContain("warning:");
    expect(output).toContain("error:");
    expect(output).toContain("badKey");
    expect(output).toContain("permissionMode");
  });

  test("rejects toml configs", () => {
    expect(() => checkUnsupportedConfigFormat("/home/.clench/settings.toml")).toThrow(/TOML/i);
    expect(() => checkUnsupportedConfigFormat("/home/.clench/settings.json")).not.toThrow();
  });

  test("uses the config path for parse diagnostics", () => {
    const result = validateConfigFile('{"model":', "/test/settings.json");
    expect(result.errors[0]?.path).toBe("/test/settings.json");
    expect(formatConfigDiagnostics(result)).toContain("/test/settings.json");
  });
});
