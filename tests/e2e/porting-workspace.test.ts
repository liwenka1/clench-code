import { describe, expect, test } from "vitest";

import { bootstrapSession, buildPortManifest, QueryEnginePort } from "../../src/porting-workspace/index.js";
import { runCli } from "../helpers/runCli.js";

describe("python porting workspace parity", () => {
  test("test_manifest_counts_python_files", async () => {
    const manifest = buildPortManifest();

    expect(manifest.totalFiles).toBeGreaterThanOrEqual(20);
    expect(manifest.topLevelModules.length).toBeGreaterThan(0);
    expect(manifest.topLevelModules).toContain("src");
  });

  test("test_query_engine_summary_mentions_workspace", async () => {
    const summary = QueryEnginePort.fromWorkspace().renderSummary();

    expect(summary).toContain("Python Porting Workspace Summary");
    expect(summary).toContain("Command surface:");
    expect(summary).toContain("Tool surface:");
  });

  test("test_cli_summary_runs", async () => {
    const result = await runCli({
      cwd: process.cwd(),
      args: ["./dist/porting-workspace.js", "summary"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Python Porting Workspace Summary");
  });

  test("test_route_and_show_entry_cli_run", async () => {
    const [routeResult, showCommandResult, showToolResult] = await Promise.all([
      runCli({
        cwd: process.cwd(),
        args: ["./dist/porting-workspace.js", "route", "review", "--limit", "5"]
      }),
      runCli({
        cwd: process.cwd(),
        args: ["./dist/porting-workspace.js", "show-command", "review"]
      }),
      runCli({
        cwd: process.cwd(),
        args: ["./dist/porting-workspace.js", "show-tool", "MCPTool"]
      })
    ]);

    expect(routeResult.exitCode).toBe(0);
    expect(routeResult.stdout.toLowerCase()).toContain("review");
    expect(showCommandResult.stdout.toLowerCase()).toContain("review");
    expect(showToolResult.stdout.toLowerCase()).toContain("mcptool");
  });

  test("test_bootstrap_cli_runs", async () => {
    const session = bootstrapSession("review MCP tool", 5);
    const result = await runCli({
      cwd: process.cwd(),
      args: ["./dist/porting-workspace.js", "bootstrap", "review", "MCP", "tool", "--limit", "5"]
    });

    expect(session.matchedTools.length).toBeGreaterThanOrEqual(1);
    expect(session.output).toContain("Prompt: review MCP tool");
    expect(session.usage.inputTokens).toBeGreaterThanOrEqual(1);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Runtime Session");
    expect(result.stdout).toContain("Startup Steps");
    expect(result.stdout).toContain("Routed Matches");
  });

  test("test_exec_command_and_tool_cli_run", async () => {
    const [commandResult, toolResult] = await Promise.all([
      runCli({
        cwd: process.cwd(),
        args: ["./dist/porting-workspace.js", "exec-command", "review", "inspect", "security", "review"]
      }),
      runCli({
        cwd: process.cwd(),
        args: ["./dist/porting-workspace.js", "exec-tool", "MCPTool", "fetch", "resource", "list"]
      })
    ]);

    expect(commandResult.exitCode).toBe(0);
    expect(commandResult.stdout).toContain("Mirrored command 'review'");
    expect(toolResult.exitCode).toBe(0);
    expect(toolResult.stdout).toContain("Mirrored tool 'MCPTool'");
  });
});
