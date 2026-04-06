import { describe, expect, test } from "vitest";

import {
  SlashCommandParseError,
  parseSlashCommand,
  renderSlashCommandHelp,
  suggestSlashCommands
} from "../../src/commands/index.js";

describe("commands library", () => {
  test("ports slash command parsing behavior", async () => {
    expect(parseSlashCommand("/help")).toEqual({ type: "help" });
    expect(parseSlashCommand(" /compact ")).toEqual({ type: "compact" });
    expect(parseSlashCommand("/plugins list")).toEqual({ type: "plugin", action: "list" });
    expect(parseSlashCommand("/marketplace enable demo")).toEqual({
      type: "plugin",
      action: "enable",
      target: "demo"
    });
    expect(parseSlashCommand("plain text")).toBeUndefined();
  });

  test("ports permission mode, clear, config, session, and MCP argument parsing", async () => {
    expect(parseSlashCommand("/permissions read-only")).toEqual({
      type: "permissions",
      mode: "read-only"
    });
    expect(parseSlashCommand("/clear --confirm")).toEqual({ type: "clear", confirm: true });
    expect(parseSlashCommand("/config env")).toEqual({ type: "config", section: "env" });
    expect(parseSlashCommand("/session switch abc123")).toEqual({
      type: "session",
      action: "switch",
      target: "abc123"
    });
    expect(parseSlashCommand("/mcp show remote")).toEqual({
      type: "mcp",
      action: "show",
      target: "remote"
    });

    expect(() => parseSlashCommand("/permissions admin")).toThrow(SlashCommandParseError);
    expect(() => parseSlashCommand("/session switch")).toThrow("/session");
    expect(() => parseSlashCommand("/mcp show alpha beta")).toThrow("/mcp");
  });

  test("ports slash command suggestion and help rendering behavior", async () => {
    const help = renderSlashCommandHelp();
    expect(help).toContain("Start here");
    expect(help).toContain("/compact");
    expect(help).toContain("/plugin [list|install <path>|enable <name>|disable <name>]");
    expect(help).toContain("aliases: /plugins, /marketplace");

    const suggestions = suggestSlashCommands("/plugns", 3);
    expect(suggestions).toContain("/plugin");
    expect(suggestions.length).toBeLessThanOrEqual(3);
    expect(suggestSlashCommands("zzz", 3)).toEqual([]);
  });
});
