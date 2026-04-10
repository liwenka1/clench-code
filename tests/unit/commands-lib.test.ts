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
    expect(parseSlashCommand("/status")).toEqual({ type: "status" });
    expect(parseSlashCommand(" /compact ")).toEqual({ type: "compact" });
    expect(parseSlashCommand("/export notes.md")).toEqual({ type: "export", destination: "notes.md" });
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

  test("parse_bare_commands_permissions_config_mcp_session_fork_and_marketplace_alias", () => {
    expect(parseSlashCommand("/permissions")).toEqual({ type: "permissions" });
    expect(parseSlashCommand("/config")).toEqual({ type: "config" });
    expect(parseSlashCommand("/mcp")).toEqual({ type: "mcp" });
    expect(parseSlashCommand("/mcp list")).toEqual({ type: "mcp", action: "list" });
    expect(parseSlashCommand("/mcp help")).toEqual({ type: "mcp", action: "help" });
    expect(parseSlashCommand("/marketplace list")).toEqual({ type: "plugin", action: "list" });
    expect(parseSlashCommand("/session fork")).toMatchObject({
      type: "session",
      action: "fork"
    });
  });

  test("parseSlashCommand_rejects_unknown_command_and_unexpected_tokens", () => {
    expect(() => parseSlashCommand("/not-a-real-command")).toThrow(SlashCommandParseError);
    expect(() => parseSlashCommand("/help please")).toThrow(SlashCommandParseError);
    expect(() => parseSlashCommand("/compact now")).toThrow(SlashCommandParseError);
  });

  test("ports slash command suggestion and help rendering behavior", async () => {
    const help = renderSlashCommandHelp();
    expect(help).toContain("Start here");
    expect(help).toContain("/export <path>");
    expect(help).toContain("/compact");
    expect(help).toContain("/plugin [list|install <path>|enable <name>|disable <name>|uninstall <name>]");
    expect(help).toContain("aliases: /plugins, /marketplace");

    const suggestions = suggestSlashCommands("/plugns", 3);
    expect(suggestions).toContain("/plugin");
    expect(suggestSlashCommands("/stats", 3)).toContain("/status");
    expect(suggestions.length).toBeLessThanOrEqual(3);
    expect(suggestSlashCommands("zzz", 3)).toEqual([]);
  });
});
