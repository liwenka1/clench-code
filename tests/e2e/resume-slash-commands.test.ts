import { readFile } from "node:fs/promises";
import { join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { runCli } from "../helpers/runCli";
import { writeJsonFile, writeJsonlFile } from "../helpers/sessionFixtures";
import { createTempWorkspace, type TempWorkspace } from "../helpers/tempWorkspace";

const workspaces: TempWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0, workspaces.length).map((workspace) => workspace.cleanup()));
});

describe("resume slash commands", () => {
  test("resumed_binary_accepts_slash_commands_with_arguments", async () => {
    const workspace = await createTempWorkspace("clench-resume-slash-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    const exportPath = join(workspace.root, "notes.txt");

    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "session" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "ship the slash command harness" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: [
        "./dist/index.js",
        "--resume",
        sessionPath,
        "/export",
        exportPath,
        "/clear",
        "--confirm"
      ]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Export");
    expect(result.stdout).toContain(`wrote transcript  ${exportPath}`);
    expect(result.stdout).toContain("Session cleared");
    expect(result.stdout).toContain("Mode             resumed session reset");
    expect(result.stdout).toContain("Backup           ");

    const transcript = await readFile(exportPath, "utf8");
    expect(transcript).toContain("# Conversation Export");
    expect(transcript).toContain("## user");
    expect(transcript).toContain("ship the slash command harness");

    const backupPath = `${sessionPath}.bak`;
    const backup = await readFile(backupPath, "utf8");
    expect(backup).toContain("ship the slash command harness");
    expect(backup).toContain("session_meta");
  });

  test("compact_session_command_rewrites_session_to_compacted_form", async () => {
    const workspace = await createTempWorkspace("clench-compact-session-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "compact-session" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "first" }] } },
      { type: "message", message: { role: "assistant", blocks: [{ type: "text", text: "second" }] } },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "third" }] } },
      { type: "message", message: { role: "assistant", blocks: [{ type: "text", text: "fourth" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/compact"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Compact");
    expect(result.stdout).toContain("removed messages 2");
    const compacted = await readFile(sessionPath, "utf8");
    expect(compacted).toContain("Conversation summary");
    expect(compacted).toContain("compaction");
  });

  test("session_commands_list_fork_and_switch_managed_sessions", async () => {
    const workspace = await createTempWorkspace("clench-session-commands-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "root-session" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "fork me" }] } }
    ]);

    const forked = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/session", "fork", "feature-branch"]
    });
    expect(forked.exitCode).toBe(0);
    expect(forked.stdout).toContain("forked");
    expect(forked.stdout).toContain("feature-branch");

    const listed = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/session", "list"]
    });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("Sessions");
    expect(listed.stdout).toContain(".clench");

    const forkedPath = listed.stdout
      .split("\n")
      .find((line) => line.includes(".clench") && line.includes(".jsonl"));
    expect(forkedPath).toBeTruthy();

    const switched = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/session", "switch", forkedPath!.trim()]
    });
    expect(switched.exitCode).toBe(0);
    expect(switched.stdout).toContain("switched");
    expect(switched.stdout).toContain(forkedPath!.trim());
  });

  test("plugin_and_mcp_commands_update_local_config_and_render_state", async () => {
    const workspace = await createTempWorkspace("clench-plugin-mcp-");
    workspaces.push(workspace);

    const pluginManifest = join(workspace.root, "demo-plugin.json");
    await writeJsonFile(pluginManifest, {
      metadata: {
        name: "demo-plugin",
        version: "1.2.3",
        description: "Demo plugin"
      },
      tools: [
        {
          name: "plugin_echo",
          command: process.execPath,
          args: ["--version"],
          requiredPermission: "read-only"
        }
      ]
    });
    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../fixtures/mcp-stdio-echo.mjs"
    );
    await writeJsonFile(join(workspace.root, ".clench.json"), {
      mcp: {
        demo: { type: "stdio", command: process.execPath, args: [fixture], env: {} }
      }
    });

    const installed = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/plugin", "install", pluginManifest]
    });
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout).toContain("installed");
    expect(installed.stdout).toContain("version          1.2.3");
    expect(installed.stdout).toContain("tools            1");

    const enabled = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/plugin", "enable", "demo-plugin"]
    });
    expect(enabled.exitCode).toBe(0);
    expect(enabled.stdout).toContain("enabled");

    const listed = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/plugin", "list"]
    });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("Plugins");
    expect(listed.stdout).toContain("demo-plugin enabled=true");
    expect(listed.stdout).toContain("version=1.2.3");
    expect(listed.stdout).toContain("tools=1");

    const mcpList = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/mcp", "list"]
    });
    expect(mcpList.exitCode).toBe(0);
    expect(mcpList.stdout).toContain("MCP");
    expect(mcpList.stdout).toContain("demo");
    expect(mcpList.stdout).toContain("status=connected");

    const mcpShow = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/mcp", "show", "demo"]
    });
    expect(mcpShow.exitCode).toBe(0);
    expect(mcpShow.stdout).toContain("status           connected");
    expect(mcpShow.stdout).toContain(`"command":"${process.execPath}"`);
  });

  test("export_without_destination_errors_on_dist", async () => {
    const workspace = await createTempWorkspace("clench-export-no-dest-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "export-no-dest" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "body" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/export"]
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/\/export requires a destination path/i);
  });

  test("export_nested_destination_creates_parent_directories", async () => {
    const workspace = await createTempWorkspace("clench-export-nested-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    const exportPath = join(workspace.root, "a", "b", "transcript.md");

    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "nested-export" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "nested export body" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/export", exportPath]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`wrote transcript  ${exportPath}`);

    const body = await readFile(exportPath, "utf8");
    expect(body).toContain("# Conversation Export");
    expect(body).toContain("nested export body");
  });

  test("export_transcript_includes_user_and_assistant_sections", async () => {
    const workspace = await createTempWorkspace("clench-export-roles-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    const exportPath = join(workspace.root, "roles.md");

    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "roles" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "user line" }] } },
      { type: "message", message: { role: "assistant", blocks: [{ type: "text", text: "assistant line" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/export", exportPath]
    });

    expect(result.exitCode).toBe(0);

    const body = await readFile(exportPath, "utf8");
    expect(body).toContain("## user");
    expect(body).toContain("## assistant");
    expect(body).toContain("user line");
    expect(body).toContain("assistant line");
  });

  test("clear_without_confirm_refuses_and_keeps_session_file", async () => {
    const workspace = await createTempWorkspace("clench-clear-no-confirm-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "clear-guard" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "keep this line" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/clear"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Refusing to clear without confirmation");
    const content = await readFile(sessionPath, "utf8");
    expect(content).toContain("keep this line");
  });

  test("export_without_resume_errors_on_dist", async () => {
    const workspace = await createTempWorkspace("clench-export-no-resume-");
    workspaces.push(workspace);

    const exportPath = join(workspace.root, "out.md");
    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/export", exportPath]
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/\/export requires a resumed session/i);
  });

  test("clear_without_resume_errors_on_dist", async () => {
    const workspace = await createTempWorkspace("clench-clear-no-resume-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/clear"]
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/\/clear requires a resumed session/i);
  });

  test("chained_slash_status_then_config_runs_in_order", async () => {
    const workspace = await createTempWorkspace("clench-chain-status-config-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain" }
    ]);
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/status", "/config", "model"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Model            claude-opus-4-6");
    expect(result.stdout).toContain("Config");
    expect(result.stdout).toContain("Merged section: model");
    expect(result.stdout).toContain("sonnet");
    const out = result.stdout;
    expect(out.indexOf("Status")).toBeLessThan(out.indexOf("Config"));
  });

  test("chained_slash_status_then_config_with_resume_equals_form", async () => {
    const workspace = await createTempWorkspace("clench-chain-resume-eq-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain-resume-eq" }
    ]);
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });

    const result = await runCli({
      cwd: workspace.root,
      args: [`./dist/index.js`, `--resume=${sessionPath}`, "/status", "/config", "model"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Merged section: model");
    expect(result.stdout).toContain("sonnet");
    const out = result.stdout;
    expect(out.indexOf("Status")).toBeLessThan(out.indexOf("Config"));
  });

  test("chained_slash_status_then_config_with_session_equals_form", async () => {
    const workspace = await createTempWorkspace("clench-chain-session-eq-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain-session-eq" }
    ]);
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });

    const result = await runCli({
      cwd: workspace.root,
      args: [`./dist/index.js`, `--session=${sessionPath}`, "/status", "/config", "model"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Merged section: model");
    expect(result.stdout).toContain("sonnet");
    const out = result.stdout;
    expect(out.indexOf("Status")).toBeLessThan(out.indexOf("Config"));
  });

  test("chained_slash_status_respects_permission_mode_danger_full_access", async () => {
    const workspace = await createTempWorkspace("clench-chain-pm-danger-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain-pm-danger" }
    ]);
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });

    const result = await runCli({
      cwd: workspace.root,
      args: [
        "./dist/index.js",
        "--permission-mode=danger-full-access",
        "--resume",
        sessionPath,
        "/status",
        "/config",
        "model"
      ]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Permission mode  danger-full-access");
    expect(result.stdout).toContain("Merged section: model");
    expect(result.stdout).toContain("sonnet");
    const out = result.stdout;
    expect(out.indexOf("Status")).toBeLessThan(out.indexOf("Config"));
  });

  test("chained_slash_status_respects_model_flag_before_resume", async () => {
    const workspace = await createTempWorkspace("clench-chain-model-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain-model" }
    ]);
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });

    const result = await runCli({
      cwd: workspace.root,
      args: [
        "./dist/index.js",
        "--model",
        "haiku",
        "--resume",
        sessionPath,
        "/status",
        "/config",
        "model"
      ]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Model            claude-haiku-4-5-20251213");
    expect(result.stdout).toContain("Merged section: model");
    expect(result.stdout).toContain("sonnet");
    const out = result.stdout;
    expect(out.indexOf("Status")).toBeLessThan(out.indexOf("Config"));
  });

  test("chained_slash_status_respects_model_equals_flag", async () => {
    const workspace = await createTempWorkspace("clench-chain-model-eq-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain-model-eq" }
    ]);
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });

    const result = await runCli({
      cwd: workspace.root,
      args: [
        "./dist/index.js",
        "--model=haiku",
        "--resume",
        sessionPath,
        "/status",
        "/config",
        "model"
      ]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Model            claude-haiku-4-5-20251213");
    expect(result.stdout).toContain("Merged section: model");
    expect(result.stdout).toContain("sonnet");
    const out = result.stdout;
    expect(out.indexOf("Status")).toBeLessThan(out.indexOf("Config"));
  });

  test("chained_slash_status_respects_permission_mode_flag", async () => {
    const workspace = await createTempWorkspace("clench-chain-pm-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain-pm" }
    ]);
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });

    const result = await runCli({
      cwd: workspace.root,
      args: [
        "./dist/index.js",
        "--permission-mode",
        "read-only",
        "--resume",
        sessionPath,
        "/status",
        "/config",
        "model"
      ]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Permission mode  read-only");
    expect(result.stdout).toContain("Merged section: model");
    expect(result.stdout).toContain("sonnet");
    const out = result.stdout;
    expect(out.indexOf("Status")).toBeLessThan(out.indexOf("Config"));
  });

  test("chained_slash_status_respects_permission_mode_equals_workspace_write", async () => {
    const workspace = await createTempWorkspace("clench-chain-pm-eq-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain-pm-eq" }
    ]);
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });

    const result = await runCli({
      cwd: workspace.root,
      args: [
        "./dist/index.js",
        "--permission-mode=workspace-write",
        "--resume",
        sessionPath,
        "/status",
        "/config",
        "model"
      ]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Permission mode  workspace-write");
    expect(result.stdout).toContain("Merged section: model");
    expect(result.stdout).toContain("sonnet");
    const out = result.stdout;
    expect(out.indexOf("Status")).toBeLessThan(out.indexOf("Config"));
  });

  test("chained_slash_status_shows_allowed_tools", async () => {
    const workspace = await createTempWorkspace("clench-chain-at-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain-at" }
    ]);
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });

    const result = await runCli({
      cwd: workspace.root,
      args: [
        "./dist/index.js",
        "--allowed-tools=bash,read_file",
        "--resume",
        sessionPath,
        "/status",
        "/config",
        "model"
      ]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Allowed tools    bash,read_file");
    expect(result.stdout).toContain("Merged section: model");
    expect(result.stdout).toContain("sonnet");
    const out = result.stdout;
    expect(out.indexOf("Status")).toBeLessThan(out.indexOf("Config"));
    expect(out.indexOf("Allowed tools")).toBeLessThan(out.indexOf("Config"));
  });

  test("chained_slash_status_shows_output_format", async () => {
    const workspace = await createTempWorkspace("clench-chain-ofmt-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain-ofmt" }
    ]);
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });

    const result = await runCli({
      cwd: workspace.root,
      args: [
        "./dist/index.js",
        "--output-format=ndjson",
        "--resume",
        sessionPath,
        "/status",
        "/config",
        "model"
      ]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Output format    ndjson");
    expect(result.stdout).toContain("Merged section: model");
    expect(result.stdout).toContain("sonnet");
    const out = result.stdout;
    expect(out.indexOf("Status")).toBeLessThan(out.indexOf("Config"));
    expect(out.indexOf("Output format")).toBeLessThan(out.indexOf("Config"));
  });

  test("chained_slash_status_two_token_output_format_and_allowed_tools", async () => {
    const workspace = await createTempWorkspace("clench-chain-ofmt-at-2tok-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain-2tok" }
    ]);
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });

    const result = await runCli({
      cwd: workspace.root,
      args: [
        "./dist/index.js",
        "--output-format",
        "text",
        "--allowed-tools",
        "bash",
        "--resume",
        sessionPath,
        "/status",
        "/config",
        "model"
      ]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Output format    text");
    expect(result.stdout).toContain("Allowed tools    bash");
    expect(result.stdout).toContain("Merged section: model");
    const out = result.stdout;
    expect(out.indexOf("Output format")).toBeLessThan(out.indexOf("Allowed tools"));
    expect(out.indexOf("Allowed tools")).toBeLessThan(out.indexOf("Config"));
  });

  test("chained_slash_status_then_help", async () => {
    const workspace = await createTempWorkspace("clench-chain-status-help-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain-help" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "hi" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/status", "/help"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Messages         1");
    expect(result.stdout).toContain("Interactive slash commands:");
    expect(result.stdout).toContain("/export");
    expect(result.stdout).toContain("/permissions");
    const out = result.stdout;
    expect(out.indexOf("Status")).toBeLessThan(out.indexOf("Interactive slash commands:"));
  });

  test("chained_slash_permissions_read_only_then_status", async () => {
    const workspace = await createTempWorkspace("clench-chain-perm-slash-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain-perm" }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/permissions", "read-only", "/status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Permission mode  read-only");
  });

  test("slash_permissions_no_args_prints_current_mode", async () => {
    const workspace = await createTempWorkspace("clench-perm-print-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--permission-mode", "workspace-write", "/permissions"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Permission mode  workspace-write");
    expect(result.stdout).not.toContain("Status");
  });

  test("slash_permissions_invalid_mode_errors_on_dist", async () => {
    const workspace = await createTempWorkspace("clench-perm-bad-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/permissions", "nope"]
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Unsupported \/permissions mode/i);
  });

  test("chained_slash_status_then_unknown_command_fails_after_status", async () => {
    const workspace = await createTempWorkspace("clench-chain-unknown-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain-unk" }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/status", "/not-a-real-slash"]
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Session          ");
    expect(result.stderr).toContain("unknown slash command outside the REPL: /not-a-real-slash");
    expect(result.stderr).toContain("Did you mean /status?");
  });

  test("status_command_applies_cli_flags_end_to_end", async () => {
    const workspace = await createTempWorkspace("clench-status-flags-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: [
        "./dist/index.js",
        "--model",
        "sonnet",
        "--permission-mode",
        "read-only",
        "status"
      ]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Model            claude-sonnet-4-6");
    expect(result.stdout).toContain("Permission mode  read-only");
  });

  test("resumed_config_command_loads_settings_files_end_to_end", async () => {
    const workspace = await createTempWorkspace("clench-resume-config-");
    workspaces.push(workspace);

    const configHome = join(workspace.root, "home", ".clench");
    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "resume-config" }
    ]);
    await writeJsonFile(join(configHome, "settings.json"), { model: "haiku" });
    await writeJsonFile(join(workspace.root, ".clench", "settings.local.json"), { model: "opus" });

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/config", "model"],
      env: {
        CLENCH_CONFIG_HOME: configHome
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Config");
    expect(result.stdout).toContain("Loaded files      2");
    expect(result.stdout).toContain(join(configHome, "settings.json"));
    expect(result.stdout).toContain(join(workspace.root, ".clench", "settings.local.json"));
    expect(result.stdout).toContain("Merged section: model");
    expect(result.stdout).toContain("opus");
  });

  test("resumed_config_command_shows_custom_merged_section", async () => {
    const workspace = await createTempWorkspace("clench-resume-config-custom-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "resume-config-custom" }
    ]);
    await writeJsonFile(join(workspace.root, ".clench.json"), {
      model: "sonnet",
      customLabel: "staging"
    });

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/config", "customLabel"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Merged section: customLabel");
    expect(result.stdout).toContain("staging");
  });

  test("resumed_config_section_missing_shows_undefined_placeholder", async () => {
    const workspace = await createTempWorkspace("clench-resume-config-missing-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "resume-config-missing" }
    ]);
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/config", "notInMerged"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Merged section: notInMerged");
    expect(result.stdout).toContain("<undefined>");
  });

  test("resumed_config_without_section_skips_merged_block", async () => {
    const workspace = await createTempWorkspace("clench-resume-config-no-section-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "resume-config-no-sec" }
    ]);
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/config"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Config");
    expect(result.stdout).toContain(".clench.json");
    expect(result.stdout).not.toContain("Merged section:");
  });

  test("resume_latest_restores_the_most_recent_managed_session", async () => {
    const workspace = await createTempWorkspace("clench-resume-latest-");
    workspaces.push(workspace);

    const sessionsDir = join(workspace.root, ".clench", "sessions");
    await writeJsonlFile(join(sessionsDir, "session-older.jsonl"), [
      { type: "session_meta", version: 1, session_id: "older" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "older session" }] } }
    ]);
    await writeJsonlFile(join(sessionsDir, "session-newer.jsonl"), [
      { type: "session_meta", version: 1, session_id: "newer" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "newer session" }] } },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "resume me" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", "latest", "/status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Messages         2");
    expect(result.stdout).toContain(join(sessionsDir, "session-newer.jsonl"));
  });
});
