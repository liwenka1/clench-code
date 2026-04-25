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
    expect(parseSlashCommand("/agents")).toEqual({ type: "agents", args: [] });
    expect(parseSlashCommand("/agents help")).toEqual({ type: "agents", args: ["help"] });
    expect(parseSlashCommand("/skills")).toEqual({ type: "skills", args: [] });
    expect(parseSlashCommand("/skills help")).toEqual({ type: "skills", args: ["help"] });
    expect(parseSlashCommand("/tasks")).toEqual({ type: "tasks", action: "list" });
    expect(parseSlashCommand("/tasks get task_1")).toEqual({ type: "tasks", action: "get", target: "task_1" });
    expect(parseSlashCommand("/tasks stop task_1")).toEqual({ type: "tasks", action: "stop", target: "task_1" });
    expect(parseSlashCommand("/tasks output task_1")).toEqual({ type: "tasks", action: "output", target: "task_1" });
    expect(parseSlashCommand("/tasks messages task_1")).toEqual({ type: "tasks", action: "messages", target: "task_1" });
    expect(parseSlashCommand("/tasks delete task_1")).toEqual({ type: "tasks", action: "delete", target: "task_1" });
    expect(parseSlashCommand("/tasks create \"Ship task UI\" \"high priority\"")).toEqual({
      type: "tasks",
      action: "create",
      prompt: "Ship task UI",
      description: "high priority"
    });
    expect(parseSlashCommand("/tasks update task_1 \"extra context\"")).toEqual({
      type: "tasks",
      action: "update",
      target: "task_1",
      message: "extra context"
    });
    expect(parseSlashCommand("/teams")).toEqual({ type: "teams", action: "list" });
    expect(parseSlashCommand("/teams get team_1")).toEqual({ type: "teams", action: "get", target: "team_1" });
    expect(parseSlashCommand("/teams delete team_1")).toEqual({ type: "teams", action: "delete", target: "team_1" });
    expect(parseSlashCommand("/teams create \"Platform Team\" task_1 task_2")).toEqual({
      type: "teams",
      action: "create",
      name: "Platform Team",
      taskIds: ["task_1", "task_2"]
    });
    expect(parseSlashCommand("/teams message team_1 \"broadcast update\"")).toEqual({
      type: "teams",
      action: "message",
      target: "team_1",
      message: "broadcast update"
    });
    expect(parseSlashCommand("/teams run team_1")).toEqual({
      type: "teams",
      action: "run",
      target: "team_1"
    });
    expect(parseSlashCommand("/crons")).toEqual({ type: "crons", action: "list" });
    expect(parseSlashCommand("/crons get cron_1")).toEqual({ type: "crons", action: "get", target: "cron_1" });
    expect(parseSlashCommand("/crons delete cron_1")).toEqual({ type: "crons", action: "delete", target: "cron_1" });
    expect(parseSlashCommand("/crons disable cron_1")).toEqual({ type: "crons", action: "disable", target: "cron_1" });
    expect(parseSlashCommand("/crons run cron_1")).toEqual({ type: "crons", action: "run", target: "cron_1" });
    expect(parseSlashCommand("/crons create \"0 * * * *\" \"Hourly check\" \"health probe\"")).toEqual({
      type: "crons",
      action: "create",
      schedule: "0 * * * *",
      prompt: "Hourly check",
      description: "health probe"
    });
    expect(parseSlashCommand("/crons create-team \"0 * * * *\" team_1 \"health probe\"")).toEqual({
      type: "crons",
      action: "create-team",
      schedule: "0 * * * *",
      teamId: "team_1",
      description: "health probe"
    });
    expect(parseSlashCommand("/skill help")).toEqual({ type: "skills", args: ["help"] });
    expect(parseSlashCommand("/skills install ./demo-skill")).toEqual({ type: "skills", args: ["install", "./demo-skill"] });
    expect(parseSlashCommand("/version")).toEqual({ type: "version" });
    expect(parseSlashCommand("/init")).toEqual({ type: "init" });
    expect(parseSlashCommand("/doctor")).toEqual({ type: "doctor" });
    expect(parseSlashCommand("/sandbox")).toEqual({ type: "sandbox" });
    expect(parseSlashCommand("/stats")).toEqual({ type: "cost" });
    expect(parseSlashCommand("/resume")).toEqual({ type: "resume" });
    expect(parseSlashCommand("/resume latest")).toEqual({ type: "resume", target: "latest" });
    expect(parseSlashCommand("/cost")).toEqual({ type: "cost" });
    expect(parseSlashCommand("/diff")).toEqual({ type: "diff" });
    expect(parseSlashCommand("/memory")).toEqual({ type: "memory" });
    expect(parseSlashCommand("/model")).toEqual({ type: "model" });
    expect(parseSlashCommand("/model sonnet")).toEqual({ type: "model", model: "sonnet" });
    expect(parseSlashCommand("/model add local")).toEqual({ type: "model", action: "add", providerId: "local" });
    expect(parseSlashCommand("/model openai/gpt-4.1-mini")).toEqual({ type: "model", model: "openai/gpt-4.1-mini" });
    expect(parseSlashCommand("/history")).toEqual({ type: "history" });
    expect(parseSlashCommand("/history 5")).toEqual({ type: "history", count: 5 });
    expect(parseSlashCommand(" /compact ")).toEqual({ type: "compact" });
    expect(parseSlashCommand("/export notes.md")).toEqual({ type: "export", destination: "notes.md" });
    expect(parseSlashCommand("/session delete demo")).toEqual({ type: "session", action: "delete", target: "demo", force: false });
    expect(parseSlashCommand("/session delete demo --force")).toEqual({
      type: "session",
      action: "delete",
      target: "demo",
      force: true
    });
    expect(parseSlashCommand("/plugin update demo")).toEqual({ type: "plugin", action: "update", target: "demo" });
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
    expect(() => parseSlashCommand("/tasks stop")).toThrow("/tasks");
    expect(() => parseSlashCommand("/tasks output")).toThrow("/tasks");
    expect(() => parseSlashCommand("/tasks messages")).toThrow("/tasks");
    expect(() => parseSlashCommand("/tasks delete")).toThrow("/tasks");
    expect(() => parseSlashCommand("/tasks create")).toThrow("/tasks");
    expect(() => parseSlashCommand("/tasks update task_1")).toThrow("/tasks");
    expect(() => parseSlashCommand("/teams delete")).toThrow("/teams");
    expect(() => parseSlashCommand("/teams create")).toThrow("/teams");
    expect(() => parseSlashCommand("/teams message team_1")).toThrow("/teams");
    expect(() => parseSlashCommand("/teams run")).toThrow("/teams");
    expect(() => parseSlashCommand("/crons get")).toThrow("/crons");
    expect(() => parseSlashCommand("/crons create \"0 * * * *\"")).toThrow("/crons");
    expect(() => parseSlashCommand("/crons create-team \"0 * * * *\"")).toThrow("/crons");
    expect(() => parseSlashCommand("/crons disable")).toThrow("/crons");
    expect(() => parseSlashCommand("/crons run")).toThrow("/crons");
    expect(() => parseSlashCommand("/history nope")).toThrow("history: invalid count");
    expect(() => parseSlashCommand("/session switch")).toThrow("/session");
    expect(() => parseSlashCommand("/session delete demo --hard")).toThrow("--force");
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
    expect(help).toContain("/agents [list|help]");
    expect(help).toContain("/skills [list|install <path>|help|<skill> [args]]");
    expect(help).toContain("/tasks [list|get <task-id>|stop <task-id>|output <task-id>|messages <task-id>|delete <task-id>|create <prompt> [description]|update <task-id> <message>]");
    expect(help).toContain("/teams [list|get <team-id>|delete <team-id>|create <name> [task-id...]|message <team-id> <message>|run <team-id>]");
    expect(help).toContain("/crons [list|get <cron-id>|delete <cron-id>|create \"<schedule>\" \"<prompt>\" [description]|create-team \"<schedule>\" <team-id> [description]|disable <cron-id>|run <cron-id>]");
    expect(help).toContain("/version");
    expect(help).toContain("/init");
    expect(help).toContain("/doctor");
    expect(help).toContain("/sandbox");
    expect(help).toContain("/resume <session-path|session-id|latest>");
    expect(help).toContain("/cost");
    expect(help).toContain("/diff");
    expect(help).toContain("/memory");
    expect(help).toContain("/model [alias|provider/id|id|add [provider-id]]");
    expect(help).toContain("/history [count]");
    expect(help).toContain("/export <path>");
    expect(help).toContain("/compact");
    expect(help).toContain("/session [list|switch <session-id>|fork [branch-name]|delete <session-id> [--force]]");
    expect(help).toContain("/plugin [list|install <path>|enable <name>|disable <name>|uninstall <name>|update <name>]");
    expect(help).toContain("aliases: /plugins, /marketplace");

    const suggestions = suggestSlashCommands("/plugns", 3);
    expect(suggestions).toContain("/plugin");
    expect(suggestSlashCommands("/stats", 3)).toContain("/cost");
    expect(suggestions.length).toBeLessThanOrEqual(3);
    expect(suggestSlashCommands("zzz", 3)).toEqual([]);
  });
});
