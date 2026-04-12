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
    expect(parseCliArgs(["version"]).command).toEqual({ type: "version" });
    expect(parseCliArgs(["--version"]).command).toEqual({ type: "version" });
    expect(parseCliArgs(["-V"]).command).toEqual({ type: "version" });
    expect(parseCliArgs(["init"]).command).toEqual({ type: "init" });
    expect(parseCliArgs(["login"]).command).toEqual({ type: "login" });
    expect(parseCliArgs(["logout"]).command).toEqual({ type: "logout" });
    expect(parseCliArgs(["dump-manifests"]).command).toEqual({ type: "dump-manifests" });
    expect(parseCliArgs(["doctor"]).command).toEqual({ type: "doctor" });
    expect(parseCliArgs(["sandbox"]).command).toEqual({ type: "sandbox" });
    expect(parseCliArgs(["state"]).command).toEqual({ type: "state" });
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
