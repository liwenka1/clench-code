import { describe, expect, test } from "vitest";

import { parseCliArgs } from "../../src/cli";

describe("cli args", () => {
  test("ports argument and option parsing helpers", async () => {
    const cli = parseCliArgs([
      "--model",
      "claude-3-5-haiku",
      "--permission-mode",
      "read-only",
      "--config",
      "/tmp/config.toml",
      "--output-format",
      "ndjson",
      "prompt",
      "hello",
      "world"
    ]);

    expect(cli.model).toBe("claude-3-5-haiku");
    expect(cli.permissionMode).toBe("read-only");
    expect(cli.config).toBe("/tmp/config.toml");
    expect(cli.outputFormat).toBe("ndjson");
    expect(cli.command).toEqual({
      type: "prompt",
      prompt: ["hello", "world"]
    });
  });

  test("parses dump-manifests and bootstrap-plan commands", () => {
    expect(parseCliArgs(["dump-manifests"]).command).toEqual({ type: "dump-manifests" });
    expect(parseCliArgs(["doctor"]).command).toEqual({ type: "doctor" });
    expect(parseCliArgs(["sandbox"]).command).toEqual({ type: "sandbox" });
    expect(parseCliArgs(["bootstrap-plan", "route", "query", "--limit", "7"]).command).toEqual({
      type: "bootstrap-plan",
      query: ["route", "query"],
      limit: 7
    });
    expect(parseCliArgs(["bootstrap-plan", "route", "--limit=3"]).command).toEqual({
      type: "bootstrap-plan",
      query: ["route"],
      limit: 3
    });
  });
});
