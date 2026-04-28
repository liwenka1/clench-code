import { describe, expect, test } from "vitest";

import { newSessionState, parseSlashCommand, renderHelp } from "../../src/cli";

describe("cli app", () => {
  test("ports app-layer helper behavior", async () => {
    expect(parseSlashCommand("/help")).toEqual({ type: "help" });
    expect(parseSlashCommand("/model claude-sonnet")).toEqual({
      type: "model",
      model: "claude-sonnet"
    });
    expect(parseSlashCommand("/model add local")).toEqual({
      type: "model",
      action: "add",
      providerId: "local"
    });
    expect(parseSlashCommand("/model list")).toEqual({
      type: "model",
      action: "list"
    });
    expect(parseSlashCommand("/clear --confirm")).toEqual({
      type: "clear",
      confirm: true
    });
    expect(renderHelp()).toContain("/status");
    expect(newSessionState("claude").lastModel).toBe("claude");
  });
});
