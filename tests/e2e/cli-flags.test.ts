import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { runCli } from "../helpers/runCli";
import { writeJsonFile, writeJsonlFile } from "../helpers/sessionFixtures";
import { createTempWorkspace, type TempWorkspace } from "../helpers/tempWorkspace";

const workspaces: TempWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0, workspaces.length).map((workspace) => workspace.cleanup()));
});

describe("cli flags and config defaults", () => {
  test("non_tty_empty_argv_prints_thin_status", async () => {
    const workspace = await createTempWorkspace("clench-cli-empty-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Model");
  });

  test("non_tty_persist_only_routes_to_thin_status", async () => {
    const workspace = await createTempWorkspace("clench-cli-persist-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--persist"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Model");
  });

  test("persist_with_explicit_status_routes_to_thin_status", async () => {
    const workspace = await createTempWorkspace("clench-cli-persist-status-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--persist", "status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status");
  });

  test("help_flag_prints_entry_usage_on_bundled_dist", async () => {
    const workspace = await createTempWorkspace("clench-cli-help-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--help"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage");
    expect(result.stdout).toContain("--resume");
    expect(result.stdout).toContain("REPL");
  });

  test("short_help_flag_prints_entry_usage_on_bundled_dist", async () => {
    const workspace = await createTempWorkspace("clench-cli-h-short-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "-h"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage");
    expect(result.stdout).toContain("--resume");
  });

  test("thin_slash_argv_with_help_prints_usage", async () => {
    const workspace = await createTempWorkspace("clench-cli-slash-help-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/status", "--help"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage");
    expect(result.stdout).toContain("--session");
  });

  test("slash_argv_with_short_help_prints_entry_usage_not_thin_status", async () => {
    const workspace = await createTempWorkspace("clench-cli-slash-status-h-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/status", "-h"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage");
    expect(result.stdout).toContain("One-shot prompt");
    expect(result.stdout).not.toContain("Interactive slash commands:");
  });

  test("status_command_applies_model_and_permission_mode_flags", async () => {
    const workspace = await createTempWorkspace("clench-cli-status-");
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

  test("status_command_applies_inline_eq_permission_mode", async () => {
    const workspace = await createTempWorkspace("clench-cli-status-ineq-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--permission-mode=workspace-write", "status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Permission mode  workspace-write");
  });

  test("status_command_applies_model_alias_when_output_format_flag_present", async () => {
    const workspace = await createTempWorkspace("clench-cli-status-ofmt-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: [
        "./dist/index.js",
        "--model",
        "haiku",
        "--output-format",
        "json",
        "status"
      ]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Model            claude-haiku-4-5-20251213");
    expect(result.stdout).toContain("Output format    json");
  });

  test("resume_flag_loads_a_saved_session_and_dispatches_status", async () => {
    const workspace = await createTempWorkspace("clench-cli-resume-status-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "resume-status.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "resume-status" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "resume fixture" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Messages         1");
    expect(result.stdout).toContain(`Session          ${sessionPath}`);
  });

  test("status_resume_takes_precedence_over_persist_when_both_flags", async () => {
    const workspace = await createTempWorkspace("clench-cli-resume-persist-");
    workspaces.push(workspace);

    const resumePath = join(workspace.root, "resume-wins.jsonl");
    await writeJsonlFile(resumePath, [
      { type: "session_meta", version: 1, session_id: "resume-wins" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "from resume" }] } }
    ]);

    const defaultPath = join(workspace.root, ".clench", "sessions", "default.jsonl");
    await writeJsonlFile(defaultPath, [
      { type: "session_meta", version: 1, session_id: "default" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "d1" }] } },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "d2" }] } },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "d3" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", resumePath, "--persist", "status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Messages         1");
    expect(result.stdout).toContain(`Session          ${resumePath}`);
  });

  test("resume_eq_form_loads_session_same_as_two_token_resume", async () => {
    const workspace = await createTempWorkspace("clench-cli-resume-eq-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "resume-eq.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "resume-eq" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "eq form" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: [`./dist/index.js`, `--resume=${sessionPath}`, "/status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Messages         1");
    expect(result.stdout).toContain(`Session          ${sessionPath}`);
  });

  test("session_eq_form_aliases_resume_for_thin_status", async () => {
    const workspace = await createTempWorkspace("clench-cli-session-eq-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session-eq.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "session-eq" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "session eq" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: [`./dist/index.js`, `--session=${sessionPath}`, "status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Messages         1");
    expect(result.stdout).toContain(`Session          ${sessionPath}`);
  });

  test("session_two_token_form_aliases_resume_for_thin_status", async () => {
    const workspace = await createTempWorkspace("clench-cli-session-two-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session-two.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "session-two" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "two-token" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--session", sessionPath, "status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Messages         1");
    expect(result.stdout).toContain(`Session          ${sessionPath}`);
  });

  test("resume_relative_path_resolves_against_cwd", async () => {
    const workspace = await createTempWorkspace("clench-cli-rel-resume-");
    workspaces.push(workspace);

    const rel = "nested/session.jsonl";
    const fullPath = join(workspace.root, rel);
    await writeJsonlFile(fullPath, [
      { type: "session_meta", version: 1, session_id: "rel" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "relative resume" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", rel, "/status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Messages         1");
    expect(result.stdout).toContain(`Session          ${realpathSync(fullPath)}`);
  });

  test("resume_missing_session_file_errors_on_dist", async () => {
    const workspace = await createTempWorkspace("clench-cli-missing-sess-");
    workspaces.push(workspace);

    const missing = join(workspace.root, "does-not-exist.jsonl");
    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", missing, "status"]
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/ENOENT|no such file|cannot open/i);
  });

  test("resume_single_json_file_with_messages_array_loads_for_status", async () => {
    const workspace = await createTempWorkspace("clench-cli-whole-json-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "whole.json");
    await writeJsonFile(sessionPath, {
      sessionId: "whole-json",
      messages: [{ role: "user", blocks: [{ type: "text", text: "whole json session" }] }]
    });

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Messages         1");
    expect(result.stdout).toMatch(/Session\s+.*whole\.json/);
  });

  test("resume_empty_session_file_shows_zero_messages", async () => {
    const workspace = await createTempWorkspace("clench-cli-empty-sess-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "empty.jsonl");
    await writeJsonlFile(sessionPath, []);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Messages         0");
    expect(result.stdout).toMatch(/Session\s+.*empty\.jsonl/);
  });

  test("resume_jsonl_session_meta_only_shows_zero_messages", async () => {
    const workspace = await createTempWorkspace("clench-cli-meta-only-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "meta-only.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "meta-only" }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Messages         0");
    expect(result.stdout).toMatch(/Session\s+.*meta-only\.jsonl/);
  });

  test("resume_jsonl_type_meta_line_shows_zero_messages", async () => {
    const workspace = await createTempWorkspace("clench-cli-meta-line-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "meta-line.jsonl");
    await writeJsonlFile(sessionPath, [{ type: "meta", sessionId: "save-session-format" }]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Messages         0");
    expect(result.stdout).toMatch(/Session\s+.*meta-line\.jsonl/);
  });

  test("slash_command_names_match_known_commands_and_suggest_nearby_unknown_ones", async () => {
    const workspace = await createTempWorkspace("clench-cli-slash-");
    workspaces.push(workspace);

    const helpResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/help"]
    });

    const unknownResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/zstats"]
    });

    expect(helpResult.exitCode).toBe(0);
    expect(helpResult.stdout).toContain("Interactive slash commands:");
    expect(helpResult.stdout).toContain("/status");
    expect(unknownResult.exitCode).not.toBe(0);
    expect(unknownResult.stderr).toContain("unknown slash command outside the REPL: /zstats");
    expect(unknownResult.stderr).toContain("Did you mean /status?");
  });

  test("unknown_global_flag_errors_on_dist", async () => {
    const workspace = await createTempWorkspace("clench-cli-unknown-flag-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--not-a-supported-cli-flag"]
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/unknown option/i);
    expect(result.stderr).toMatch(/--help/);
  });

  test("resume_latest_errors_when_no_managed_sessions_dir", async () => {
    const workspace = await createTempWorkspace("clench-cli-latest-empty-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", "latest", "status"]
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/no managed sessions/i);
  });

  test("slash_status_without_resume_prints_status_without_session_section", async () => {
    const workspace = await createTempWorkspace("clench-cli-slash-status-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Model");
    expect(result.stdout).toContain("Permission mode");
    expect(result.stdout).not.toContain("Messages");
    expect(result.stdout).not.toContain("Session");
  });

  test("slash_config_without_resume_loads_workspace_config", async () => {
    const workspace = await createTempWorkspace("clench-cli-config-noresume-");
    workspaces.push(workspace);

    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/config", "model"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Config");
    expect(result.stdout).toContain("Loaded files      1");
    expect(result.stdout).toContain(join(workspace.root, ".clench.json"));
    expect(result.stdout).toContain("Merged section: model");
    expect(result.stdout).toContain("sonnet");
  });

  test("config_command_loads_defaults_from_standard_config_locations", async () => {
    const workspace = await createTempWorkspace("clench-cli-config-");
    workspaces.push(workspace);

    const configHome = join(workspace.root, "home", ".clench");
    const sessionPath = join(workspace.root, "config-defaults.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "config-defaults" }
    ]);
    await writeJsonFile(join(configHome, "settings.json"), { model: "haiku" });
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });
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
    expect(result.stdout).toContain("Loaded files      3");
    expect(result.stdout).toContain(join(configHome, "settings.json"));
    expect(result.stdout).toContain(join(workspace.root, ".clench.json"));
    expect(result.stdout).toContain(join(workspace.root, ".clench", "settings.local.json"));
    expect(result.stdout).toContain("Merged section: model");
    expect(result.stdout).toContain("opus");
  });
});
