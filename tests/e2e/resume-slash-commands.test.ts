import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { PermissionPolicy, appendTaskOutput, resetGlobalTaskRegistry, resetGlobalTeamCronRegistry } from "../../src/runtime/index.js";
import { executeTool } from "../../src/tools/index.js";
import { runCli } from "../helpers/runCli";
import { writeJsonFile, writeJsonlFile } from "../helpers/sessionFixtures";
import { createTempWorkspace, type TempWorkspace } from "../helpers/tempWorkspace";

const workspaces: TempWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0, workspaces.length).map((workspace) => workspace.cleanup()));
  resetGlobalTaskRegistry();
  resetGlobalTeamCronRegistry();
});

describe("resume slash commands", () => {
  test("resumed_binary_accepts_slash_commands_with_arguments", async () => {
    const workspace = await createTempWorkspace("clench-resume-slash-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    const exportPath = join(workspace.root, "notes.txt");

    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "session" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "ship the slash command harness" }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          blocks: [{ type: "tool_use", id: "tool-1", name: "bash", input: "{\"command\":\"echo hi\"}" }]
        }
      },
      {
        type: "message",
        message: {
          role: "tool",
          blocks: [{ type: "tool_result", tool_use_id: "tool-1", tool_name: "bash", output: "hi", is_error: false }]
        }
      }
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
    expect(transcript).toContain("### tool_use bash (tool-1)");
    expect(transcript).toContain("### tool_result bash (tool-1) error=false");
    expect(transcript).toContain("echo hi");
    expect(transcript).toContain("hi");

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

    const deleted = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/session", "delete", forkedPath!.trim()]
    });
    expect(deleted.exitCode).toBe(0);
    expect(deleted.stdout).toContain("deleted");
    expect(deleted.stdout).toContain(forkedPath!.trim());
    expect(fs.existsSync(forkedPath!.trim())).toBe(false);
  });

  test("session_delete_refuses_active_session_without_force", async () => {
    const workspace = await createTempWorkspace("clench-session-delete-guard-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "active.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "active" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "keep me" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/session", "delete", sessionPath]
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/active session/i);
    expect(fs.existsSync(sessionPath)).toBe(true);
  });

  test("session_delete_force_removes_active_session_and_clears_following_status_session", async () => {
    const workspace = await createTempWorkspace("clench-session-delete-force-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "active.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "active" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "delete me" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/session", "delete", sessionPath, "--force", "/status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("deleted");
    expect(result.stdout).toContain("Status");
    expect(result.stdout).not.toContain(`Session          ${sessionPath}`);
    expect(fs.existsSync(sessionPath)).toBe(false);
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

    const disabled = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/plugin", "disable", "demo-plugin"]
    });
    expect(disabled.exitCode).toBe(0);
    expect(disabled.stdout).toContain("disabled");

    const listedDisabled = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/plugin", "list"]
    });
    expect(listedDisabled.exitCode).toBe(0);
    expect(listedDisabled.stdout).toContain("demo-plugin enabled=false");
    expect(listedDisabled.stdout).toContain("health=stopped");

    await writeJsonFile(pluginManifest, {
      metadata: {
        name: "demo-plugin",
        version: "2.0.0",
        description: "Demo plugin updated"
      },
      tools: [
        {
          name: "plugin_echo",
          command: process.execPath,
          args: ["--version"],
          requiredPermission: "read-only"
        },
        {
          name: "plugin_echo_two",
          command: process.execPath,
          args: ["--version"],
          requiredPermission: "read-only"
        }
      ]
    });

    const updated = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/plugin", "update", "demo-plugin"]
    });
    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain("updated");
    expect(updated.stdout).toContain("2.0.0");

    const listedUpdated = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/plugin", "list"]
    });
    expect(listedUpdated.exitCode).toBe(0);
    expect(listedUpdated.stdout).toContain("demo-plugin enabled=false");
    expect(listedUpdated.stdout).toContain("version=2.0.0");
    expect(listedUpdated.stdout).toContain("tools=2");

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

    const uninstalled = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/plugin", "uninstall", "demo-plugin"]
    });
    expect(uninstalled.exitCode).toBe(0);
    expect(uninstalled.stdout).toContain("uninstalled");
    expect(uninstalled.stdout).toContain("demo-plugin");

    const listedRemoved = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/plugin", "list"]
    });
    expect(listedRemoved.exitCode).toBe(0);
    expect(listedRemoved.stdout).not.toContain("demo-plugin");
  });

  test("top_level_plugin_and_mcp_commands_alias_slash_surface", async () => {
    const workspace = await createTempWorkspace("clench-top-level-plugin-mcp-");
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
      args: ["./dist/index.js", "plugin", "install", pluginManifest]
    });
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout).toContain("installed");

    const listed = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "plugins", "list"]
    });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("demo-plugin enabled=false");

    await writeJsonFile(pluginManifest, {
      metadata: {
        name: "demo-plugin",
        version: "9.9.9",
        description: "Demo plugin updated via top-level alias"
      },
      tools: [
        {
          name: "plugin_echo",
          command: process.execPath,
          args: ["--version"],
          requiredPermission: "read-only"
        },
        {
          name: "plugin_echo_two",
          command: process.execPath,
          args: ["--version"],
          requiredPermission: "read-only"
        }
      ]
    });

    const updated = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "plugin", "update", "demo-plugin"]
    });
    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain("updated");
    expect(updated.stdout).toContain("9.9.9");

    const enabled = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "plugin", "enable", "demo-plugin"]
    });
    expect(enabled.exitCode).toBe(0);
    expect(enabled.stdout).toContain("enabled");

    const mcpList = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "mcp", "list"]
    });
    expect(mcpList.exitCode).toBe(0);
    expect(mcpList.stdout).toContain("demo");
    expect(mcpList.stdout).toContain("status=connected");

    const mcpShow = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "mcp", "show", "demo"]
    });
    expect(mcpShow.exitCode).toBe(0);
    expect(mcpShow.stdout).toContain("status           connected");
  });

  test("top_level_session_config_export_history_permissions_alias_slash_surface", async () => {
    const workspace = await createTempWorkspace("clench-top-level-headless-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    const exportPath = join(workspace.root, "transcript.md");
    await writeJsonFile(join(workspace.root, ".clench.json"), { model: "sonnet" });
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "headless-session" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "alpha" }] } },
      { type: "message", message: { role: "assistant", blocks: [{ type: "text", text: "beta" }] } }
    ]);

    const config = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "config", "model"]
    });
    expect(config.exitCode).toBe(0);
    expect(config.stdout).toContain("Merged section: model");
    expect(config.stdout).toContain("sonnet");

    const sessionList = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "session", "list"]
    });
    expect(sessionList.exitCode).toBe(0);
    expect(sessionList.stdout).toContain("Sessions");

    const history = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "history", "2"]
    });
    expect(history.exitCode).toBe(0);
    expect(history.stdout).toContain("Prompt history");
    expect(history.stdout).toContain("alpha");

    const permissions = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "permissions"]
    });
    expect(permissions.exitCode).toBe(0);
    expect(permissions.stdout).toContain("Permission mode");

    const exported = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "export", exportPath]
    });
    expect(exported.exitCode).toBe(0);
    expect(exported.stdout).toContain(`wrote transcript  ${exportPath}`);

    const compacted = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "compact"]
    });
    expect(compacted.exitCode).toBe(0);
    expect(compacted.stdout).toContain("Compact");

    const cleared = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "clear", "--confirm"]
    });
    expect(cleared.exitCode).toBe(0);
    expect(cleared.stdout).toContain("Session cleared");
  });

  test("top_level_model_alias_uses_model_slash_surface", async () => {
    const workspace = await createTempWorkspace("clench-top-level-model-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "model", "sonnet"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Model");
    expect(result.stdout).toContain("Current          claude-sonnet-4-6");
    expect(result.stdout).toContain("Previous         claude-opus-4-6");

    const saved = JSON.parse(await readFile(join(workspace.root, ".clench", "settings.local.json"), "utf8"));
    expect(saved.model).toBe("claude-sonnet-4-6");
  });

  test("top_level_model_explicit_provider_persists_selection", async () => {
    const workspace = await createTempWorkspace("clench-top-level-model-provider-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "model", "openai/gpt-4.1-mini"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Model");
    expect(result.stdout).toContain("Current          openai/gpt-4.1-mini");
    expect(result.stdout).toContain("Previous         claude-opus-4-6");

    const saved = JSON.parse(await readFile(join(workspace.root, ".clench", "settings.local.json"), "utf8"));
    expect(saved.model).toBe("openai/gpt-4.1-mini");
  });

  test("top_level_model_add_interactively_persists_provider_config", async () => {
    const workspace = await createTempWorkspace("clench-top-level-model-add-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "model", "add", "local"],
      stdin: "\n\n\n\nqwen2.5-coder:14b\ny\n"
    });

    expect(result.exitCode).toBe(0);

    const saved = JSON.parse(await readFile(join(workspace.root, ".clench", "settings.local.json"), "utf8"));
    expect(saved.providers.local).toEqual({
      kind: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "dummy",
      defaultModel: "qwen2.5-coder:14b"
    });
    expect(saved.model).toBe("local/qwen2.5-coder:14b");
  });

  test("top_level_model_provider_id_uses_saved_default_model", async () => {
    const workspace = await createTempWorkspace("clench-top-level-model-provider-default-");
    workspaces.push(workspace);

    fs.mkdirSync(join(workspace.root, ".clench"), { recursive: true });
    await writeFile(
      join(workspace.root, ".clench", "settings.local.json"),
      JSON.stringify(
        {
          providers: {
            aaa: {
              kind: "openai",
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: "dummy",
              defaultModel: "qwen2.5:7b"
            },
            cccc: {
              kind: "openai",
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: "dummy",
              defaultModel: "qwen3.5:4b"
            }
          },
          model: "aaa/qwen2.5:7b"
        },
        null,
        2
      )
    );

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "model", "cccc"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Current          cccc/qwen3.5:4b");
    expect(result.stdout).toContain("Previous         aaa/qwen2.5:7b");

    const saved = JSON.parse(await readFile(join(workspace.root, ".clench", "settings.local.json"), "utf8"));
    expect(saved.model).toBe("cccc/qwen3.5:4b");
    expect(saved.providers.cccc.defaultModel).toBe("qwen3.5:4b");
  });

  test("top_level_model_rejects_unknown_bare_selection_without_persisting", async () => {
    const workspace = await createTempWorkspace("clench-top-level-model-unknown-");
    workspaces.push(workspace);

    fs.mkdirSync(join(workspace.root, ".clench"), { recursive: true });
    await writeFile(
      join(workspace.root, ".clench", "settings.local.json"),
      JSON.stringify(
        {
          providers: {
            cccc: {
              kind: "openai",
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: "dummy",
              defaultModel: "qwen3.5:4b"
            }
          },
          model: "cccc/qwen3.5:4b"
        },
        null,
        2
      )
    );

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "model", "sss"]
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown model selection 'sss'.");
    expect(result.stderr).toContain("Configured providers: cccc");
    expect(result.stderr).toContain("/model sonnet to use a built-in alias");
    expect(result.stderr).toContain("/model <provider-id> to use a provider default model");
    expect(result.stderr).toContain("/model <provider-id>/<model-id> to select an explicit model");
    expect(result.stderr).toContain("/model list to inspect configured providers");

    const saved = JSON.parse(await readFile(join(workspace.root, ".clench", "settings.local.json"), "utf8"));
    expect(saved.model).toBe("cccc/qwen3.5:4b");
  });

  test("top_level_model_explains_how_to_fix_unknown_provider_without_persisting", async () => {
    const workspace = await createTempWorkspace("clench-top-level-model-unknown-provider-");
    workspaces.push(workspace);

    fs.mkdirSync(join(workspace.root, ".clench"), { recursive: true });
    await writeFile(
      join(workspace.root, ".clench", "settings.local.json"),
      JSON.stringify(
        {
          providers: {
            aaa: {
              kind: "openai",
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: "dummy"
            },
            cccc: {
              kind: "openai",
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: "dummy",
              defaultModel: "qwen3.5:4b"
            }
          },
          model: "cccc/qwen3.5:4b"
        },
        null,
        2
      )
    );

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "model", "nope/qwen3.5:4b"]
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown provider 'nope'.");
    expect(result.stderr).toContain("Configured providers: aaa, cccc");
    expect(result.stderr).toContain("/model add nope to configure it");
    expect(result.stderr).toContain("/model <provider-id>/<model-id> to select an explicit model");
    expect(result.stderr).toContain("/model list to inspect configured providers");

    const saved = JSON.parse(await readFile(join(workspace.root, ".clench", "settings.local.json"), "utf8"));
    expect(saved.model).toBe("cccc/qwen3.5:4b");
  });

  test("top_level_model_explains_how_to_fix_provider_without_default_model", async () => {
    const workspace = await createTempWorkspace("clench-top-level-model-provider-missing-default-");
    workspaces.push(workspace);

    fs.mkdirSync(join(workspace.root, ".clench"), { recursive: true });
    await writeFile(
      join(workspace.root, ".clench", "settings.local.json"),
      JSON.stringify(
        {
          providers: {
            aaa: {
              kind: "openai",
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: "dummy"
            },
            cccc: {
              kind: "openai",
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: "dummy",
              defaultModel: "qwen3.5:4b"
            }
          },
          model: "cccc/qwen3.5:4b"
        },
        null,
        2
      )
    );

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "model", "aaa"]
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("provider 'aaa' is configured, but it has no default model yet.");
    expect(result.stderr).toContain("/model aaa/<model-id> to switch with an explicit model");
    expect(result.stderr).toContain("/model add aaa to set its default model");
    expect(result.stderr).toContain("/model list to inspect configured providers");

    const saved = JSON.parse(await readFile(join(workspace.root, ".clench", "settings.local.json"), "utf8"));
    expect(saved.model).toBe("cccc/qwen3.5:4b");
  });

  test("top_level_model_list_shows_current_default_and_configured_providers", async () => {
    const workspace = await createTempWorkspace("clench-top-level-model-list-");
    workspaces.push(workspace);

    fs.mkdirSync(join(workspace.root, ".clench"), { recursive: true });
    await writeFile(
      join(workspace.root, ".clench", "settings.local.json"),
      JSON.stringify(
        {
          providers: {
            test: { kind: "openai" },
            aaa: {
              kind: "openai",
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: "dummy",
              defaultModel: "qwen3.5:4b"
            }
          },
          model: "aaa/qwen3.5:4b"
        },
        null,
        2
      )
    );

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/model", "list"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Model");
    expect(result.stdout).toContain("Current          aaa/qwen3.5:4b");
    expect(result.stdout).toContain("Default          aaa/qwen3.5:4b");
    expect(result.stdout).toContain("Provider         aaa");
    expect(result.stdout).toContain("Base URL         http://127.0.0.1:11434/v1");
    expect(result.stdout).toContain("Configured providers");
    expect(result.stdout).toContain("* aaa  kind=openai  base_url=http://127.0.0.1:11434/v1  default_model=qwen3.5:4b");
    expect(result.stdout).toContain("test  kind=openai  base_url=https://api.openai.com/v1");
  });

  test("diff_reports_no_git_repository_when_workspace_is_not_git", async () => {
    const workspace = await createTempWorkspace("clench-diff-nogit-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "diff"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Diff");
    expect(result.stdout).toContain("no git repository");
  });

  test("cost_reports_zero_usage_without_resumed_session", async () => {
    const workspace = await createTempWorkspace("clench-cost-empty-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "cost"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Cost");
    expect(result.stdout).toContain("Turns");
    expect(result.stdout).toMatch(/Turns\s*0/);
    expect(result.stdout).toMatch(/Total tokens\s*0/);
    expect(result.stdout).toContain("Estimated cost");
    expect(result.stdout).toContain("$0.0000");
  });

  test("resume_without_target_prints_usage", async () => {
    const workspace = await createTempWorkspace("clench-resume-usage-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/resume"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Resume");
    expect(result.stdout).toContain("/resume <session-path|session-id|latest>");
    expect(result.stdout).toContain("/session list");
  });

  test("resume_switches_to_explicit_session_path", async () => {
    const workspace = await createTempWorkspace("clench-resume-path-");
    workspaces.push(workspace);

    const first = join(workspace.root, "first.jsonl");
    const second = join(workspace.root, "second.jsonl");
    await writeJsonlFile(first, [
      { type: "session_meta", version: 1, session_id: "first" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "first session" }] } }
    ]);
    await writeJsonlFile(second, [
      { type: "session_meta", version: 1, session_id: "second" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "second session" }] } }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", first, "/resume", second, "/status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Session");
    expect(result.stdout).toContain(`resumed          ${second}`);
    expect(result.stdout).toContain(`Session          ${second}`);
    expect(result.stdout).toContain("Messages         1");
  });

  test("cost_reports_cumulative_usage_for_resumed_session", async () => {
    const workspace = await createTempWorkspace("clench-cost-session-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "cost-session" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "ship it" }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          blocks: [{ type: "text", text: "done" }],
          usage: {
            input_tokens: 1200,
            output_tokens: 300,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 50
          }
        }
      }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/cost"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Cost");
    expect(result.stdout).toContain("claude-opus-4-6");
    expect(result.stdout).toMatch(/Turns\s*1/);
    expect(result.stdout).toMatch(/Input tokens\s*1200/);
    expect(result.stdout).toMatch(/Output tokens\s*300/);
    expect(result.stdout).toMatch(/Cache create\s*100/);
    expect(result.stdout).toMatch(/Cache read\s*50/);
    expect(result.stdout).toMatch(/Total tokens\s*1650/);
    expect(result.stdout).toContain("$0.0424");
  });

  test("stats_alias_routes_to_cost_surface", async () => {
    const workspace = await createTempWorkspace("clench-stats-alias-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "stats-session" },
      {
        type: "message",
        message: {
          role: "assistant",
          blocks: [{ type: "text", text: "done" }],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 1
          }
        }
      }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/stats"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Cost");
    expect(result.stdout).toMatch(/Turns\s*1/);
    expect(result.stdout).toMatch(/Total tokens\s*18/);
  });

  test("agents_lists_discovered_definitions", async () => {
    const workspace = await createTempWorkspace("clench-agents-list-");
    workspaces.push(workspace);

    const agentsDir = join(workspace.root, ".claude", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "planner.toml"),
      [
        'name = "planner"',
        'description = "Plan tasks"',
        'model = "claude-sonnet-4-6"',
        'model_reasoning_effort = "high"'
      ].join("\n"),
      "utf8"
    );

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/agents"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agents");
    expect(result.stdout).toContain("1 active agents");
    expect(result.stdout).toContain("Project:");
    expect(result.stdout).toContain("planner");
    expect(result.stdout).toContain("Plan tasks");
    expect(result.stdout).toContain("claude-sonnet-4-6");
  });

  test("agents_help_surfaces_usage_from_top_level_alias", async () => {
    const workspace = await createTempWorkspace("clench-agents-help-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "agents", "help"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Agents");
    expect(result.stdout).toContain("/agents [list|help]");
    expect(result.stdout).toContain("clench agents [list|help]");
  });

  test("skills_lists_discovered_definitions", async () => {
    const workspace = await createTempWorkspace("clench-skills-list-");
    workspaces.push(workspace);

    const skillsDir = join(workspace.root, ".claude", "skills", "reviewer");
    fs.mkdirSync(skillsDir, { recursive: true });
    await writeFile(
      join(skillsDir, "SKILL.md"),
      [
        "---",
        "name: reviewer",
        "description: Review code changes",
        "---",
        "",
        "# Reviewer"
      ].join("\n"),
      "utf8"
    );

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/skills"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Skills");
    expect(result.stdout).toContain("1 active skills");
    expect(result.stdout).toContain("Project:");
    expect(result.stdout).toContain("reviewer");
    expect(result.stdout).toContain("Review code changes");
  });

  test("skills_help_surfaces_usage_from_top_level_alias", async () => {
    const workspace = await createTempWorkspace("clench-skills-help-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "skills", "help"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Skills");
    expect(result.stdout).toContain("/skills [list|install <path>|help|<skill> [args]]");
    expect(result.stdout).toContain("clench skills [list|install <path>|help|<skill> [args]]");
  });

  test("skills_install_copies_skill_into_install_root", async () => {
    const workspace = await createTempWorkspace("clench-skills-install-");
    workspaces.push(workspace);

    const configHome = join(workspace.root, ".config-home");
    const sourceDir = join(workspace.root, "sample-skill");
    fs.mkdirSync(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "SKILL.md"),
      [
        "---",
        "name: reviewer",
        "description: Review code changes",
        "---",
        "",
        "# Reviewer"
      ].join("\n"),
      "utf8"
    );

    const result = await runCli({
      cwd: workspace.root,
      env: { CLAW_CONFIG_HOME: configHome },
      args: ["./dist/index.js", "/skills", "install", sourceDir]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Skill installed");
    expect(result.stdout).toContain("Invocation name  reviewer");
    expect(result.stdout).toContain(join(configHome, "skills", "reviewer"));
    expect(fs.existsSync(join(configHome, "skills", "reviewer", "SKILL.md"))).toBe(true);
  });

  test("skills_install_supports_top_level_alias", async () => {
    const workspace = await createTempWorkspace("clench-skills-install-alias-");
    workspaces.push(workspace);

    const configHome = join(workspace.root, ".config-home");
    const sourceFile = join(workspace.root, "helper.md");
    await writeFile(
      sourceFile,
      [
        "---",
        "name: helper",
        "description: Helper skill",
        "---",
        "",
        "# Helper"
      ].join("\n"),
      "utf8"
    );

    const result = await runCli({
      cwd: workspace.root,
      env: { CLAW_CONFIG_HOME: configHome },
      args: ["./dist/index.js", "skills", "install", sourceFile]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Skill installed");
    expect(result.stdout).toContain("Invocation name  helper");
    expect(fs.existsSync(join(configHome, "skills", "helper", "SKILL.md"))).toBe(true);
  });

  test("tasks_list_surfaces_empty_registry_from_top_level_alias", async () => {
    const workspace = await createTempWorkspace("clench-tasks-list-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "list"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Tasks");
    expect(result.stdout).toContain("Count");
    expect(result.stdout).toContain("No tasks created in this process.");
  });

  test("tasks_list_surfaces_persisted_tasks_across_processes", async () => {
    const workspace = await createTempWorkspace("clench-tasks-persisted-");
    workspaces.push(workspace);

    const previousCwd = process.cwd();
    process.chdir(workspace.root);
    try {
      resetGlobalTaskRegistry();
      resetGlobalTeamCronRegistry();
      executeTool("TaskCreate", { prompt: "Persisted task from tools", description: "cross-process" }, new PermissionPolicy("danger-full-access"));
    } finally {
      process.chdir(previousCwd);
      resetGlobalTaskRegistry();
      resetGlobalTeamCronRegistry();
    }

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "list"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Tasks");
    expect(result.stdout).toContain("Persisted task from tools");
    expect(result.stdout).toContain("cross-process");
  });

  test("tasks_output_surfaces_persisted_output_across_processes", async () => {
    const workspace = await createTempWorkspace("clench-tasks-output-");
    workspaces.push(workspace);

    const previousCwd = process.cwd();
    process.chdir(workspace.root);
    let taskId = "";
    try {
      resetGlobalTaskRegistry();
      resetGlobalTeamCronRegistry();
      const created = executeTool("TaskCreate", { prompt: "Output task" }, new PermissionPolicy("danger-full-access")) as string;
      taskId = (JSON.parse(created) as { task_id: string }).task_id;
      appendTaskOutput(taskId, "first line\nsecond line\n");
    } finally {
      process.chdir(previousCwd);
      resetGlobalTaskRegistry();
      resetGlobalTeamCronRegistry();
    }

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "output", taskId]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Task Output");
    expect(result.stdout).toContain(taskId);
    expect(result.stdout).toContain("first line");
    expect(result.stdout).toContain("second line");
  });

  test("tasks_create_and_update_support_top_level_alias_and_persist_state", async () => {
    const workspace = await createTempWorkspace("clench-tasks-create-");
    workspaces.push(workspace);

    const createResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "create", "Ship task UI", "high priority"]
    });
    expect(createResult.exitCode).toBe(0);
    expect(createResult.stdout).toContain("Task created");
    expect(createResult.stdout).toContain("Ship task UI");

    const taskIdMatch = createResult.stdout.match(/task_[A-Za-z0-9_]+/);
    expect(taskIdMatch?.[0]).toBeTruthy();
    const taskId = taskIdMatch![0];

    const updateResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "update", taskId, "extra context"]
    });
    expect(updateResult.exitCode).toBe(0);
    expect(updateResult.stdout).toContain("Task updated");
    expect(updateResult.stdout).toContain("extra context");

    const getResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "get", taskId]
    });
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout).toContain(taskId);
    expect(getResult.stdout).toContain("Messages");
    expect(getResult.stdout).toContain("1");
  });

  test("tasks_messages_and_delete_support_top_level_alias", async () => {
    const workspace = await createTempWorkspace("clench-tasks-messages-");
    workspaces.push(workspace);

    const createResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "create", "Inspect me", "demo"]
    });
    expect(createResult.exitCode).toBe(0);
    const taskIdMatch = createResult.stdout.match(/task_[A-Za-z0-9_]+/);
    expect(taskIdMatch?.[0]).toBeTruthy();
    const taskId = taskIdMatch![0];

    const updateResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "update", taskId, "first note"]
    });
    expect(updateResult.exitCode).toBe(0);

    const messagesResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "messages", taskId]
    });
    expect(messagesResult.exitCode).toBe(0);
    expect(messagesResult.stdout).toContain("Task Messages");
    expect(messagesResult.stdout).toContain("first note");

    const deleteResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "delete", taskId]
    });
    expect(deleteResult.exitCode).toBe(0);
    expect(deleteResult.stdout).toContain("Task deleted");

    const listResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "list"]
    });
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain("No tasks created in this process.");
  });

  test("teams_list_and_get_surface_persisted_state_across_processes", async () => {
    const workspace = await createTempWorkspace("clench-teams-list-");
    workspaces.push(workspace);

    const previousCwd = process.cwd();
    process.chdir(workspace.root);
    let teamId = "";
    let taskId = "";
    try {
      resetGlobalTaskRegistry();
      resetGlobalTeamCronRegistry();
      const createdTask = executeTool(
        "TaskCreate",
        { prompt: "Team task", description: "owned by team" },
        new PermissionPolicy("danger-full-access")
      ) as string;
      taskId = (JSON.parse(createdTask) as { task_id: string }).task_id;
      const createdTeam = executeTool(
        "TeamCreate",
        { name: "Platform Team", tasks: [{ task_id: taskId }] },
        new PermissionPolicy("danger-full-access")
      ) as string;
      teamId = (JSON.parse(createdTeam) as { team_id: string }).team_id;
    } finally {
      process.chdir(previousCwd);
      resetGlobalTaskRegistry();
      resetGlobalTeamCronRegistry();
    }

    const listResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "teams", "list"]
    });
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain("Teams");
    expect(listResult.stdout).toContain("Platform Team");

    const getResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "teams", "get", teamId]
    });
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout).toContain(teamId);
    expect(getResult.stdout).toContain(taskId);
    expect(getResult.stdout).toContain("Team task");
    expect(getResult.stdout).toContain("created");
  });

  test("teams_create_supports_top_level_alias_and_persists_state", async () => {
    const workspace = await createTempWorkspace("clench-teams-create-");
    workspaces.push(workspace);

    const previousCwd = process.cwd();
    let taskId = "";
    process.chdir(workspace.root);
    try {
      resetGlobalTaskRegistry();
      resetGlobalTeamCronRegistry();
      const createdTask = executeTool(
        "TaskCreate",
        { prompt: "Owned by created team" },
        new PermissionPolicy("danger-full-access")
      ) as string;
      taskId = (JSON.parse(createdTask) as { task_id: string }).task_id;
    } finally {
      process.chdir(previousCwd);
      resetGlobalTaskRegistry();
      resetGlobalTeamCronRegistry();
    }

    const createResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "teams", "create", "Platform Team", taskId]
    });
    expect(createResult.exitCode).toBe(0);
    expect(createResult.stdout).toContain("Team created");
    expect(createResult.stdout).toContain("Platform Team");
    expect(createResult.stdout).toContain(taskId);

    const listResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "teams", "list"]
    });
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain("Platform Team");
   });

  test("teams_message_supports_top_level_alias_and_updates_member_tasks", async () => {
    const workspace = await createTempWorkspace("clench-teams-message-");
    workspaces.push(workspace);

    const createTaskOne = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "create", "Task one"]
    });
    const createTaskTwo = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "create", "Task two"]
    });
    const taskIdOne = createTaskOne.stdout.match(/task_[A-Za-z0-9_]+/)?.[0] ?? "";
    const taskIdTwo = createTaskTwo.stdout.match(/task_[A-Za-z0-9_]+/)?.[0] ?? "";
    expect(taskIdOne).toBeTruthy();
    expect(taskIdTwo).toBeTruthy();

    const createTeam = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "teams", "create", "Demo team", taskIdOne, taskIdTwo]
    });
    const teamId = createTeam.stdout.match(/team_[A-Za-z0-9_]+/)?.[0] ?? "";
    expect(teamId).toBeTruthy();

    const messageResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "teams", "message", teamId, "broadcast update"]
    });
    expect(messageResult.exitCode).toBe(0);
    expect(messageResult.stdout).toContain("Team message applied");
    expect(messageResult.stdout).toContain("2");

    const taskOneMessages = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "messages", taskIdOne]
    });
    expect(taskOneMessages.exitCode).toBe(0);
    expect(taskOneMessages.stdout).toContain("broadcast update");

    const teamGet = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "teams", "get", teamId]
    });
    expect(teamGet.exitCode).toBe(0);
    expect(teamGet.stdout).toContain("running");
  });

  test("teams_run_supports_top_level_alias_and_marks_tasks_running", async () => {
    const workspace = await createTempWorkspace("clench-teams-run-");
    workspaces.push(workspace);

    const createTaskOne = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "create", "Task one"]
    });
    const createTaskTwo = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "create", "Task two"]
    });
    const taskIdOne = createTaskOne.stdout.match(/task_[A-Za-z0-9_]+/)?.[0] ?? "";
    const taskIdTwo = createTaskTwo.stdout.match(/task_[A-Za-z0-9_]+/)?.[0] ?? "";
    expect(taskIdOne).toBeTruthy();
    expect(taskIdTwo).toBeTruthy();

    const createTeam = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "teams", "create", "Demo team", taskIdOne, taskIdTwo]
    });
    const teamId = createTeam.stdout.match(/team_[A-Za-z0-9_]+/)?.[0] ?? "";
    expect(teamId).toBeTruthy();

    const runResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "teams", "run", teamId]
    });
    expect(runResult.exitCode).toBe(0);
    expect(runResult.stdout).toContain("Team run started");

    const taskOneGet = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "get", taskIdOne]
    });
    expect(taskOneGet.exitCode).toBe(0);
    expect(taskOneGet.stdout).toContain("running");

    const teamGet = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "teams", "get", teamId]
    });
    expect(teamGet.exitCode).toBe(0);
    expect(teamGet.stdout).toContain("running");
  });

  test("teams_list_surfaces_task_status_summary", async () => {
    const workspace = await createTempWorkspace("clench-teams-summary-");
    workspaces.push(workspace);

    const firstTask = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "create", "Task one"]
    });
    const secondTask = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "create", "Task two"]
    });
    const taskIdOne = firstTask.stdout.match(/task_[A-Za-z0-9_]+/)?.[0] ?? "";
    const taskIdTwo = secondTask.stdout.match(/task_[A-Za-z0-9_]+/)?.[0] ?? "";
    expect(taskIdOne).toBeTruthy();
    expect(taskIdTwo).toBeTruthy();

    const updateTask = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "update", taskIdTwo, "move forward"]
    });
    expect(updateTask.exitCode).toBe(0);

    const createTeam = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "teams", "create", "Demo team", taskIdOne, taskIdTwo]
    });
    expect(createTeam.exitCode).toBe(0);

    const listResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "teams", "list"]
    });
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain("task_statuses=");
    expect(listResult.stdout).toContain("created:2");
  });

  test("crons_list_and_get_surface_persisted_state_across_processes", async () => {
    const workspace = await createTempWorkspace("clench-crons-list-");
    workspaces.push(workspace);

    const previousCwd = process.cwd();
    process.chdir(workspace.root);
    let cronId = "";
    try {
      resetGlobalTaskRegistry();
      resetGlobalTeamCronRegistry();
      const createdCron = executeTool(
        "CronCreate",
        { schedule: "0 * * * *", prompt: "Hourly check", description: "health probe" },
        new PermissionPolicy("danger-full-access")
      ) as string;
      cronId = (JSON.parse(createdCron) as { cron_id: string }).cron_id;
    } finally {
      process.chdir(previousCwd);
      resetGlobalTaskRegistry();
      resetGlobalTeamCronRegistry();
    }

    const listResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "crons", "list"]
    });
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain("Crons");
    expect(listResult.stdout).toContain("0 * * * *");
    expect(listResult.stdout).toContain("health probe");

    const getResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "crons", "get", cronId]
    });
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout).toContain(cronId);
    expect(getResult.stdout).toContain("Hourly check");
  });

  test("crons_create_supports_top_level_alias_and_persists_state", async () => {
    const workspace = await createTempWorkspace("clench-crons-create-");
    workspaces.push(workspace);

    const createResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "crons", "create", "0 * * * *", "Hourly check", "health probe"]
    });
    expect(createResult.exitCode).toBe(0);
    expect(createResult.stdout).toContain("Cron created");
    expect(createResult.stdout).toContain("0 * * * *");
    expect(createResult.stdout).toContain("Hourly check");

    const listResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "crons", "list"]
    });
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain("health probe");
  });

  test("crons_create_team_and_run_support_top_level_alias", async () => {
    const workspace = await createTempWorkspace("clench-crons-team-run-");
    workspaces.push(workspace);

    const createTaskOne = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "create", "Task one"]
    });
    const createTaskTwo = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "create", "Task two"]
    });
    const taskIdOne = createTaskOne.stdout.match(/task_[A-Za-z0-9_]+/)?.[0] ?? "";
    const taskIdTwo = createTaskTwo.stdout.match(/task_[A-Za-z0-9_]+/)?.[0] ?? "";
    expect(taskIdOne).toBeTruthy();
    expect(taskIdTwo).toBeTruthy();

    const createTeam = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "teams", "create", "Demo team", taskIdOne, taskIdTwo]
    });
    const teamId = createTeam.stdout.match(/team_[A-Za-z0-9_]+/)?.[0] ?? "";
    expect(teamId).toBeTruthy();

    const createCron = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "crons", "create-team", "0 * * * *", teamId, "team trigger"]
    });
    expect(createCron.exitCode).toBe(0);
    expect(createCron.stdout).toContain("Cron created");
    expect(createCron.stdout).toContain(teamId);
    const cronId = createCron.stdout.match(/cron_[A-Za-z0-9_]+/)?.[0] ?? "";
    expect(cronId).toBeTruthy();

    const runResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "crons", "run", cronId]
    });
    expect(runResult.exitCode).toBe(0);
    expect(runResult.stdout).toContain("Cron Run");
    expect(runResult.stdout).toContain("team");
    expect(runResult.stdout).toContain(teamId);

    const taskGet = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "get", taskIdOne]
    });
    expect(taskGet.exitCode).toBe(0);
    expect(taskGet.stdout).toContain("running");
  });

  test("crons_run_supports_top_level_alias_and_surfaces_created_task", async () => {
    const workspace = await createTempWorkspace("clench-crons-run-");
    workspaces.push(workspace);

    const createResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "crons", "create", "0 * * * *", "Hourly check", "health probe"]
    });
    expect(createResult.exitCode).toBe(0);
    const cronIdMatch = createResult.stdout.match(/cron_[A-Za-z0-9_]+/);
    expect(cronIdMatch?.[0]).toBeTruthy();
    const cronId = cronIdMatch![0];

    const runResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "crons", "run", cronId]
    });
    expect(runResult.exitCode).toBe(0);
    expect(runResult.stdout).toContain("Cron Run");
    expect(runResult.stdout).toContain(cronId);
    expect(runResult.stdout).toContain("task_");

    const tasksResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "tasks", "list"]
    });
    expect(tasksResult.exitCode).toBe(0);
    expect(tasksResult.stdout).toContain("Hourly check");
    expect(tasksResult.stdout).toContain("health probe");
  });

  test("crons_disable_supports_top_level_alias_and_persists_state", async () => {
    const workspace = await createTempWorkspace("clench-crons-disable-");
    workspaces.push(workspace);

    const createResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "crons", "create", "0 * * * *", "Hourly check", "health probe"]
    });
    expect(createResult.exitCode).toBe(0);
    const cronIdMatch = createResult.stdout.match(/cron_[A-Za-z0-9_]+/);
    expect(cronIdMatch?.[0]).toBeTruthy();
    const cronId = cronIdMatch![0];

    const disableResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "crons", "disable", cronId]
    });
    expect(disableResult.exitCode).toBe(0);
    expect(disableResult.stdout).toContain("Cron disabled");

    const getResult = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "crons", "get", cronId]
    });
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout).toContain("Enabled");
    expect(getResult.stdout).toContain("false");
  });

  test("doctor_renders_diagnostics_from_slash_surface", async () => {
    const workspace = await createTempWorkspace("clench-slash-doctor-");
    workspaces.push(workspace);

    await writeJsonFile(join(workspace.root, ".clench.json"), {
      sandbox: { enabled: false }
    });

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/doctor"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Doctor");
    expect(result.stdout).toContain("Provider");
    expect(result.stdout).toContain(".clench.json");
  });

  test("sandbox_renders_status_from_slash_surface", async () => {
    const workspace = await createTempWorkspace("clench-slash-sandbox-");
    workspaces.push(workspace);

    await writeJsonFile(join(workspace.root, ".clench.json"), {
      sandbox: {
        enabled: true,
        namespaceRestrictions: true,
        networkIsolation: false,
        filesystemMode: "allow-list",
        allowedMounts: ["src"]
      }
    });

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/sandbox"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Sandbox");
    expect(result.stdout).toContain("allow-list");
    expect(result.stdout).toContain(join(workspace.root, "src"));
  });

  test("version_renders_from_slash_surface", async () => {
    const workspace = await createTempWorkspace("clench-slash-version-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/version"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Clench Code");
    expect(result.stdout).toContain("Version");
  });

  test("init_bootstraps_repo_files_from_slash_surface", async () => {
    const workspace = await createTempWorkspace("clench-slash-init-");
    workspaces.push(workspace);
    await writeJsonFile(join(workspace.root, "package.json"), { name: "demo" });

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/init"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Init");
    expect(result.stdout).toContain(".claude.json");
    expect(result.stdout).toContain("CLAUDE.md");
    expect(fs.existsSync(join(workspace.root, ".claude"))).toBe(true);
    expect(fs.existsSync(join(workspace.root, ".claude.json"))).toBe(true);
    expect(fs.existsSync(join(workspace.root, "CLAUDE.md"))).toBe(true);
  });

  test("diff_shows_staged_and_unstaged_changes", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".clench-diff-git-"));
    workspaces.push({
      root,
      cleanup: async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    });
    const binDir = join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const gitScript = join(binDir, "git");
    await writeFile(
      gitScript,
      `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$2" = "--is-inside-work-tree" ]; then
  echo true
  exit 0
fi
if [ "$1" = "diff" ] && [ "$2" = "--cached" ]; then
  printf '%s\n' 'diff --git a/demo.txt b/demo.txt' '@@' '-line one' '+line one staged'
  exit 0
fi
if [ "$1" = "diff" ]; then
  printf '%s\n' 'diff --git a/demo.txt b/demo.txt' '@@' ' line one staged' '+line two unstaged'
  exit 0
fi
echo "unexpected git args: $*" >&2
exit 1
`,
      "utf8"
    );
    fs.chmodSync(gitScript, 0o755);

    const result = await runCli({
      cwd: root,
      args: ["./dist/index.js", "/diff"],
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Diff");
    expect(result.stdout).toContain("Staged changes");
    expect(result.stdout).toContain("Unstaged changes");
    expect(result.stdout).toContain("line one staged");
    expect(result.stdout).toContain("line two unstaged");
  });

  test("memory_reports_when_no_instruction_files_are_found", async () => {
    const workspace = await createTempWorkspace("clench-memory-empty-");
    workspaces.push(workspace);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "memory"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Memory");
    expect(result.stdout).toMatch(/Instruction files\s*0/);
    expect(result.stdout).toContain("No CLAUDE instruction files discovered");
  });

  test("memory_lists_discovered_instruction_files", async () => {
    const workspace = await createTempWorkspace("clench-memory-files-");
    workspaces.push(workspace);

    const nested = join(workspace.root, "packages", "app");
    fs.mkdirSync(join(workspace.root, ".clench"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    await writeFile(join(workspace.root, "CLAUDE.md"), "# root memory\nbody\n", "utf8");
    await writeFile(join(workspace.root, ".clench", "instructions.md"), "# local memory\n", "utf8");
    await writeFile(join(nested, "CLAUDE.local.md"), "nested memory\nline two\n", "utf8");

    const result = await runCli({
      cwd: nested,
      args: ["./dist/index.js", "/memory"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Memory");
    expect(result.stdout).toMatch(/Instruction files\s*3/);
    expect(result.stdout).toContain(join(workspace.root, "CLAUDE.md"));
    expect(result.stdout).toContain(join(workspace.root, ".clench", "instructions.md"));
    expect(result.stdout).toContain(join(nested, "CLAUDE.local.md"));
    expect(result.stdout).toContain("preview=# root memory");
    expect(result.stdout).toContain("preview=nested memory");
  });

  test("mcp_commands_surface_oauth_connection_state_from_saved_credentials", async () => {
    const workspace = await createTempWorkspace("clench-mcp-oauth-state-");
    workspaces.push(workspace);

    const configHome = join(workspace.root, ".config-home");
    await writeJsonFile(join(configHome, "credentials.json"), {
      oauth: {
        accessToken: "expired-token",
        refreshToken: "refresh-token",
        expiresAt: Math.floor(Date.now() / 1000) - 60,
        scopes: ["mcp:read"]
      }
    });
    await writeJsonFile(join(configHome, "settings.json"), {
      oauth: {
        clientId: "runtime-client",
        authorizeUrl: "https://issuer.example/oauth/authorize",
        tokenUrl: "https://issuer.example/oauth/token",
        scopes: ["mcp:read"]
      }
    });
    await writeJsonFile(join(workspace.root, ".clench.json"), {
      mcp: {
        remote: {
          type: "http",
          url: "https://vendor.example/mcp",
          headers: {},
          oauth: { clientId: "client-1" }
        }
      }
    });

    const mcpList = await runCli({
      cwd: workspace.root,
      env: { CLENCH_CONFIG_HOME: configHome },
      args: ["./dist/index.js", "/mcp", "list"]
    });
    expect(mcpList.exitCode).toBe(0);
    expect(mcpList.stdout).toContain("remote");
    expect(mcpList.stdout).toContain("status=connecting");
    expect(mcpList.stdout).toContain("refresh is available");

    const mcpShow = await runCli({
      cwd: workspace.root,
      env: { CLENCH_CONFIG_HOME: configHome },
      args: ["./dist/index.js", "/mcp", "show", "remote"]
    });
    expect(mcpShow.exitCode).toBe(0);
    expect(mcpShow.stdout).toContain("status           connecting");
    expect(mcpShow.stdout).toContain("error            saved OAuth token is expired; refresh is available");
  });

  test("mcp_commands_surface_idle_sse_runtime_session_state", async () => {
    const workspace = await createTempWorkspace("clench-mcp-sse-state-");
    workspaces.push(workspace);

    await writeJsonFile(join(workspace.root, ".clench.json"), {
      mcp: {
        remoteSse: {
          type: "sse",
          url: "https://vendor.example/sse",
          headers: {}
        }
      }
    });

    const mcpList = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/mcp", "list"]
    });
    expect(mcpList.exitCode).toBe(0);
    expect(mcpList.stdout).toContain("remoteSse");
    expect(mcpList.stdout).toContain("session=idle");
    expect(mcpList.stdout).toContain("reconnects=0");

    const mcpShow = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/mcp", "show", "remoteSse"]
    });
    expect(mcpShow.exitCode).toBe(0);
    expect(mcpShow.stdout).toContain("status           connected");
    expect(mcpShow.stdout).toContain("session          idle");
    expect(mcpShow.stdout).toContain("reconnects       0");
    expect(mcpShow.stdout).toContain("pending requests 0");
    expect(mcpShow.stdout).toContain("buffered events  0");
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
    expect(result.stdout).toContain("Model            claude-sonnet-4-6");
    expect(result.stdout).toContain("Config");
    expect(result.stdout).toContain("Merged section: model");
    expect(result.stdout).toContain("sonnet");
    const out = result.stdout;
    expect(out.indexOf("Status")).toBeLessThan(out.indexOf("Config"));
  });

  test("chained_slash_model_then_status_uses_updated_model", async () => {
    const workspace = await createTempWorkspace("clench-chain-model-slash-");
    workspaces.push(workspace);

    const sessionPath = join(workspace.root, "session.jsonl");
    await writeJsonlFile(sessionPath, [
      { type: "session_meta", version: 1, session_id: "chain-model-slash" }
    ]);

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "--resume", sessionPath, "/model", "haiku", "/status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Model");
    expect(result.stdout).toContain("Current          claude-haiku-4-5-20251213");
    expect(result.stdout).toContain("Previous         claude-opus-4-6");
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Model            claude-haiku-4-5-20251213");
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

  test("slash_status_surfaces_mcp_summary_when_servers_are_configured", async () => {
    const workspace = await createTempWorkspace("clench-slash-status-mcp-");
    workspaces.push(workspace);

    await writeJsonFile(join(workspace.root, ".clench.json"), {
      mcp: {
        remoteSse: {
          type: "sse",
          url: "https://vendor.example/sse",
          headers: {}
        }
      }
    });

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("MCP servers      1");
    expect(result.stdout).toContain("MCP SSE sessions 0/1 active");
    expect(result.stdout).toContain("MCP reconnects   0");
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

  test("slash_resume_latest_then_status_uses_updated_session", async () => {
    const workspace = await createTempWorkspace("clench-slash-resume-latest-");
    workspaces.push(workspace);

    const sessionsDir = join(workspace.root, ".clench", "sessions");
    const olderSession = join(sessionsDir, "older.jsonl");
    const latestSession = join(sessionsDir, "latest.jsonl");
    await writeJsonlFile(olderSession, [
      { type: "session_meta", version: 1, session_id: "older" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "older message" }] } }
    ]);
    await writeJsonlFile(latestSession, [
      { type: "session_meta", version: 1, session_id: "latest" },
      { type: "message", message: { role: "user", blocks: [{ type: "text", text: "latest message" }] } }
    ]);
    fs.utimesSync(olderSession, new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T00:00:00Z"));
    fs.utimesSync(latestSession, new Date("2024-01-02T00:00:00Z"), new Date("2024-01-02T00:00:00Z"));

    const result = await runCli({
      cwd: workspace.root,
      args: ["./dist/index.js", "/resume", "latest", "/status"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("resumed");
    expect(result.stdout).toContain("latest.jsonl");
    expect(result.stdout).toContain("Session");
    expect(result.stdout).toContain("Messages         1");
  });
});
