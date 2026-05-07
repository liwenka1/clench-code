import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, test } from "vitest";

import {
  PermissionPolicy,
  getGlobalCronRegistry,
  getGlobalTaskRegistry,
  getGlobalTeamRegistry,
  persistTaskRuntimeStore,
  resetGlobalTaskRegistry,
  resetGlobalTeamCronRegistry
} from "../../src/runtime/index.js";
import { PluginDefinition, PluginHooks, PluginTool } from "../../src/plugins/index.js";
import {
  GlobalToolRegistry,
  allowedToolsForSubagent,
  executeTool,
  loadWorkspaceToolRegistry,
  normalizeAllowedTools
} from "../../src/tools/index.js";

describe("tools library", () => {
  beforeEach(() => {
    resetGlobalTaskRegistry();
    resetGlobalTeamCronRegistry();
  });

  test("ports normalize_allowed_tools behavior", async () => {
    expect(normalizeAllowedTools(["Read", "Bash", "mcp__demo__echo"])).toEqual([
      "read_file",
      "bash",
      "mcp__demo__echo"
    ]);
    expect(normalizeAllowedTools(["grep", "glob"])).toEqual([
      "grep_search",
      "glob_search"
    ]);
    expect(normalizeAllowedTools(["Write", "Grep", "Glob"])).toEqual([
      "write_file",
      "grep_search",
      "glob_search"
    ]);
    expect(() => normalizeAllowedTools(["Nope"])).toThrow("unknown tool");
  });

  test("ports registry definitions and permission spec behavior", async () => {
    const registry = GlobalToolRegistry.builtin();
    const entries = registry.entries();
    expect(entries.some((entry) => entry.name === "read_file" && entry.requiredPermission === "read-only")).toBe(true);
    expect(entries.some((entry) => entry.name === "write_file" && entry.requiredPermission === "workspace-write")).toBe(true);
    expect(entries.some((entry) => entry.name === "bash" && entry.requiredPermission === "danger-full-access")).toBe(true);
    expect(entries.some((entry) => entry.name === "Config" && entry.requiredPermission === "read-only")).toBe(true);
    expect(entries.some((entry) => entry.name === "MCP" && entry.requiredPermission === "read-only")).toBe(true);
  });

  test("ports execute_tool permission gating behavior", async () => {
    expect(
      executeTool("write_file", { path: "demo.txt" }, new PermissionPolicy("workspace-write"))
    ).toBe("demo.txt");
    expect(() =>
      executeTool("write_file", { path: "demo.txt" }, new PermissionPolicy("read-only"))
    ).toThrow("requires workspace-write permission");
    expect(() =>
      executeTool("bash", { command: "pwd" }, new PermissionPolicy("workspace-write"))
    ).toThrow("requires approval");
  });

  test("execute_tool_read_only_tools_succeed_under_read_only_policy", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "clench-tools-real-"));
    const previousCwd = process.cwd();
    const ro = new PermissionPolicy("read-only");
    try {
      mkdirSync(path.join(workspace, "src"), { recursive: true });
      writeFileSync(path.join(workspace, "src", "a.ts"), "export const foo = 1;\n", "utf8");
      process.chdir(workspace);

      const read = JSON.parse(executeTool("read_file", { path: "src/a.ts" }, ro) as string) as {
        path: string;
        content: string;
      };
      expect(read.path).toContain("src/a.ts");
      expect(read.content).toContain("foo");

      const grep = JSON.parse(executeTool("grep", { pattern: "foo", path: "." }, ro) as string) as {
        matches: Array<{ path: string; line: string }>;
      };
      expect(grep.matches[0]?.path).toBe("src/a.ts");
      expect(grep.matches[0]?.line).toContain("foo");

      const glob = JSON.parse(executeTool("glob", { glob_pattern: "*.ts" }, ro) as string) as {
        matches: string[];
      };
      expect(glob.matches).toContain("src/a.ts");
    } finally {
      process.chdir(previousCwd);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("execute_tool_bash_returns_stdout_stderr_and_exit_code", () => {
    const full = new PermissionPolicy("danger-full-access");
    const result = JSON.parse(executeTool("Bash", { command: "printf hello" }, full) as string) as {
      stdout: string;
      stderr: string;
      exitCode: number | null;
    };
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("execute_tool_task_and_toolsearch_succeed_under_read_only_policy", () => {
    const ro = new PermissionPolicy("read-only");
    const taskOut = JSON.parse(
      executeTool("Task", { subagent_type: "Explore" }, ro) as string
    ) as { subagentType: string; allowedTools: string[] };
    expect(taskOut.subagentType).toBe("Explore");
    expect(taskOut.allowedTools).toContain("read_file");

    const searchOut = executeTool("ToolSearch", { query: "bash", maxResults: 3 }, ro);
    expect(searchOut).toContain("bash");
  });

  test("execute_tool_task_registry_surfaces_create_list_get_update_messages_output_stop_and_delete", () => {
    const full = new PermissionPolicy("danger-full-access");
    const ro = new PermissionPolicy("read-only");

    const created = JSON.parse(
      executeTool("TaskCreate", { prompt: "Ship task support", description: "task system" }, full) as string
    ) as { task_id: string; status: string; prompt: string; description?: string };
    expect(created.task_id).toContain("task_");
    expect(created.status).toBe("created");
    expect(created.prompt).toBe("Ship task support");

    const listed = JSON.parse(executeTool("TaskList", {}, ro) as string) as {
      count: number;
      tasks: Array<{ task_id: string; prompt: string }>;
    };
    expect(listed.count).toBe(1);
    expect(listed.tasks[0]?.task_id).toBe(created.task_id);

    const fetched = JSON.parse(executeTool("TaskGet", { task_id: created.task_id }, ro) as string) as {
      task_id: string;
      description?: string;
    };
    expect(fetched.task_id).toBe(created.task_id);
    expect(fetched.description).toBe("task system");

    const updated = JSON.parse(
      executeTool("TaskUpdate", { task_id: created.task_id, message: "extra context" }, full) as string
    ) as { task_id: string; status: string; message_count: number; last_message: string };
    expect(updated.task_id).toBe(created.task_id);
    expect(updated.status).toBe("created");
    expect(updated.message_count).toBe(1);
    expect(updated.last_message).toBe("extra context");

    const outputBefore = JSON.parse(executeTool("TaskOutput", { task_id: created.task_id }, ro) as string) as {
      task_id: string;
      output: string;
      has_output: boolean;
    };
    expect(outputBefore.task_id).toBe(created.task_id);
    expect(outputBefore.output).toBe("");
    expect(outputBefore.has_output).toBe(false);

    getGlobalTaskRegistry().appendOutput(created.task_id, "line 1\nline 2\n");
    const outputAfter = JSON.parse(executeTool("TaskOutput", { task_id: created.task_id }, ro) as string) as {
      output: string;
      has_output: boolean;
    };
    expect(outputAfter.output).toBe("line 1\nline 2\n");
    expect(outputAfter.has_output).toBe(true);

    const messages = JSON.parse(executeTool("TaskMessages", { task_id: created.task_id }, ro) as string) as {
      task_id: string;
      count: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(messages.task_id).toBe(created.task_id);
    expect(messages.count).toBe(1);
    expect(messages.messages[0]?.role).toBe("user");
    expect(messages.messages[0]?.content).toBe("extra context");

    const stopped = JSON.parse(executeTool("TaskStop", { task_id: created.task_id }, full) as string) as {
      task_id: string;
      status: string;
      message: string;
    };
    expect(stopped.task_id).toBe(created.task_id);
    expect(stopped.status).toBe("stopped");
    expect(stopped.message).toBe("Task stopped");

    const deleted = JSON.parse(executeTool("TaskDelete", { task_id: created.task_id }, full) as string) as {
      task_id: string;
      status: string;
      message: string;
    };
    expect(deleted.task_id).toBe(created.task_id);
    expect(deleted.status).toBe("deleted");
    expect(deleted.message).toBe("Task deleted");
    expect(getGlobalTaskRegistry().get(created.task_id)).toBeUndefined();
  });

  test("execute_tool_run_task_packet_validates_and_creates_packet_tasks", () => {
    const full = new PermissionPolicy("danger-full-access");

    const created = JSON.parse(
      executeTool(
        "RunTaskPacket",
        {
          objective: "Ship task packet support",
          scope: "runtime/task system",
          repo: "clench-parity",
          branch_policy: "origin/main only",
          acceptance_tests: ["pnpm test"],
          commit_policy: "single commit",
          reporting_contract: "print task id",
          escalation_policy: "manual escalation"
        },
        full
      ) as string
    ) as { task_packet?: { branch_policy: string; acceptance_tests: string[] } };

    expect(created.task_packet?.branch_policy).toBe("origin/main only");
    expect(created.task_packet?.acceptance_tests).toEqual(["pnpm test"]);
    expect(() => executeTool("RunTaskPacket", { objective: "" }, full)).toThrow();
  });

  test("execute_tool_team_and_cron_registry_surfaces_create_message_run_delete_disable_run_and_list", () => {
    const full = new PermissionPolicy("danger-full-access");
    const ro = new PermissionPolicy("read-only");

    const task = JSON.parse(executeTool("TaskCreate", { prompt: "Ship cron wiring" }, full) as string) as {
      task_id: string;
    };

    const team = JSON.parse(
      executeTool("TeamCreate", { name: "Alpha Squad", tasks: [{ task_id: task.task_id }] }, full) as string
    ) as {
      team_id: string;
      task_count: number;
      task_ids: string[];
      status: string;
    };
    expect(team.team_id).toContain("team_");
    expect(team.task_count).toBe(1);
    expect(team.task_ids).toEqual([task.task_id]);
    expect(team.status).toBe("created");
    expect(getGlobalTaskRegistry().get(task.task_id)?.teamId).toBe(team.team_id);
    expect(getGlobalTeamRegistry().get(team.team_id)?.teamId).toBe(team.team_id);

    const messagedTeam = JSON.parse(
      executeTool("TeamMessage", { team_id: team.team_id, message: "broadcast update" }, full) as string
    ) as {
      team_id: string;
      status: string;
      updated_task_ids: string[];
      updated_count: number;
      message: string;
    };
    expect(messagedTeam.team_id).toBe(team.team_id);
    expect(messagedTeam.status).toBe("running");
    expect(messagedTeam.updated_task_ids).toEqual([task.task_id]);
    expect(messagedTeam.updated_count).toBe(1);
    expect(messagedTeam.message).toBe("Team message applied");
    expect(getGlobalTaskRegistry().get(task.task_id)?.messages[0]?.content).toBe("broadcast update");

    const runTeamResult = JSON.parse(
      executeTool("TeamRun", { team_id: team.team_id }, full) as string
    ) as {
      team_id: string;
      status: string;
      updated_task_ids: string[];
      updated_count: number;
      message: string;
    };
    expect(runTeamResult.team_id).toBe(team.team_id);
    expect(runTeamResult.status).toBe("running");
    expect(runTeamResult.updated_task_ids).toEqual([task.task_id]);
    expect(runTeamResult.updated_count).toBe(1);
    expect(runTeamResult.message).toBe("Team run started");
    expect(getGlobalTaskRegistry().get(task.task_id)?.status).toBe("running");

    const deletedTeam = JSON.parse(executeTool("TeamDelete", { team_id: team.team_id }, full) as string) as {
      team_id: string;
      status: string;
      message: string;
    };
    expect(deletedTeam.team_id).toBe(team.team_id);
    expect(deletedTeam.status).toBe("deleted");
    expect(deletedTeam.message).toBe("Team deleted");

    const cron = JSON.parse(
      executeTool(
        "CronCreate",
        { schedule: "0 * * * *", prompt: "Check status", description: "hourly check" },
        full
      ) as string
    ) as {
      cron_id: string;
      enabled: boolean;
      description?: string;
    };
    expect(cron.cron_id).toContain("cron_");
    expect(cron.enabled).toBe(true);
    expect(cron.description).toBe("hourly check");

    getGlobalCronRegistry().recordRun(cron.cron_id);
    const listed = JSON.parse(executeTool("CronList", {}, ro) as string) as {
      count: number;
      entries: Array<{ cron_id: string; run_count: number; last_run_at?: number }>;
    };
    expect(listed.count).toBe(1);
    expect(listed.entries[0]?.cron_id).toBe(cron.cron_id);
    expect(listed.entries[0]?.run_count).toBe(1);
    expect(listed.entries[0]?.last_run_at).toBeDefined();

    const disabledCron = JSON.parse(executeTool("CronDisable", { cron_id: cron.cron_id }, full) as string) as {
      cron_id: string;
      enabled: boolean;
      message: string;
    };
    expect(disabledCron.cron_id).toBe(cron.cron_id);
    expect(disabledCron.enabled).toBe(false);
    expect(disabledCron.message).toBe("Cron disabled");

    const runnableCron = JSON.parse(
      executeTool("CronCreate", { schedule: "*/5 * * * *", prompt: "Run me", description: "manual trigger" }, full) as string
    ) as { cron_id: string };
    const runResult = JSON.parse(executeTool("CronRun", { cron_id: runnableCron.cron_id }, full) as string) as {
      cron_id: string;
      run_count: number;
      target_type: string;
      task: { task_id: string; prompt: string };
      message: string;
    };
    expect(runResult.cron_id).toBe(runnableCron.cron_id);
    expect(runResult.run_count).toBe(1);
    expect(runResult.target_type).toBe("task");
    expect(runResult.task.task_id).toContain("task_");
    expect(runResult.task.prompt).toBe("Run me");
    expect(runResult.message).toBe("Cron run triggered");

    const teamTargetCron = JSON.parse(
      executeTool("CronCreate", { schedule: "*/10 * * * *", prompt: "ignored", team_id: team.team_id }, full) as string
    ) as { cron_id: string; team_id?: string };
    expect(teamTargetCron.team_id).toBe(team.team_id);
    const runTeamCron = JSON.parse(executeTool("CronRun", { cron_id: teamTargetCron.cron_id }, full) as string) as {
      target_type: string;
      team?: { team_id: string; status: string; updated_task_ids: string[] };
    };
    expect(runTeamCron.target_type).toBe("team");
    expect(runTeamCron.team?.team_id).toBe(team.team_id);
    expect(runTeamCron.team?.status).toBe("running");
    expect(runTeamCron.team?.updated_task_ids).toContain(task.task_id);

    const deletedCron = JSON.parse(executeTool("CronDelete", { cron_id: cron.cron_id }, full) as string) as {
      cron_id: string;
      status: string;
      message: string;
    };
    expect(deletedCron.cron_id).toBe(cron.cron_id);
    expect(deletedCron.status).toBe("deleted");
    expect(deletedCron.message).toBe("Cron entry removed");
  });

  test("task_team_and_cron_state_persist_across_registry_resets", () => {
    const root = mkdtempSync(path.join(tmpdir(), "task-runtime-store-"));
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const full = new PermissionPolicy("danger-full-access");
      const ro = new PermissionPolicy("read-only");

      const task = JSON.parse(executeTool("TaskCreate", { prompt: "Persist me" }, full) as string) as {
        task_id: string;
      };
      executeTool("TeamCreate", { name: "Persist Team", tasks: [{ task_id: task.task_id }] }, full);
      const cron = JSON.parse(executeTool("CronCreate", { schedule: "* * * * *", prompt: "Tick" }, full) as string) as {
        cron_id: string;
      };
      getGlobalCronRegistry().recordRun(cron.cron_id);
      persistTaskRuntimeStore();

      resetGlobalTaskRegistry({ clearPersisted: false });
      resetGlobalTeamCronRegistry({ clearPersisted: false });

      const taskList = JSON.parse(executeTool("TaskList", {}, ro) as string) as { count: number };
      const cronList = JSON.parse(executeTool("CronList", {}, ro) as string) as {
        count: number;
        entries: Array<{ run_count: number }>;
      };

      expect(taskList.count).toBe(1);
      expect(getGlobalTeamRegistry().list().length).toBe(1);
      expect(cronList.count).toBe(1);
      expect(cronList.entries[0]?.run_count).toBe(1);
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("execute_tool_supports_config_and_mcp_surface", () => {
    const ro = new PermissionPolicy("read-only");
    expect(executeTool("Config", { section: "model", value: "sonnet" }, ro)).toContain('"section":"model"');
    expect(executeTool("MCP", { server: "demo", toolName: "echo", arguments: { ok: true } }, ro)).toContain('"server":"demo"');
    expect(executeTool("ListMcpResources", { server: "demo" }, ro)).toContain('"resources":[]');
    expect(executeTool("ReadMcpResource", { server: "demo", uri: "resource://demo", fallback: "body" }, ro)).toContain('"resource://demo"');
  });

  test("execute_tool_async_webfetch_returns_prompt_aware_summary", async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe("/page");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><head><title>Ignored</title></head><body><h1>Test Page</h1><p>Hello <b>world</b> from local server.</p></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const registry = GlobalToolRegistry.builtin().withPermissionPolicy(new PermissionPolicy("read-only"));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server address");
      }

      const result = JSON.parse(
        await registry.executeToolAsync("WebFetch", {
          url: `http://127.0.0.1:${address.port}/page`,
          prompt: "Summarize this page"
        })
      ) as { code: number; result: string };
      expect(result.code).toBe(200);
      expect(result.result).toContain("Fetched");
      expect(result.result).toContain("Test Page");
      expect(result.result).toContain("Hello world from local server");

      const titleResult = JSON.parse(
        await registry.executeToolAsync("WebFetch", {
          url: `http://127.0.0.1:${address.port}/page`,
          prompt: "What is the page title?"
        })
      ) as { result: string };
      expect(titleResult.result).toContain("Title: Ignored");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("execute_tool_async_websearch_extracts_and_filters_results", async () => {
    const previousBaseUrl = process.env.CLAWD_WEB_SEARCH_BASE_URL;
    const server = createServer((request, response) => {
      expect(request.url).toBe("/search?q=rust+web+search");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`
        <html><body>
          <a class="result__a" href="https://docs.rs/reqwest">Reqwest docs</a>
          <a class="result__a" href="https://example.com/blocked">Blocked result</a>
        </body></html>
      `);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server address");
      }
      process.env.CLAWD_WEB_SEARCH_BASE_URL = `http://127.0.0.1:${address.port}/search`;

      const registry = GlobalToolRegistry.builtin().withPermissionPolicy(new PermissionPolicy("read-only"));
      const result = JSON.parse(
        await registry.executeToolAsync("WebSearch", {
          query: "rust web search",
          allowed_domains: ["https://DOCS.rs/"],
          blocked_domains: ["HTTPS://EXAMPLE.COM"]
        })
      ) as {
        query: string;
        results: Array<string | { tool_use_id: string; content: Array<{ title: string; url: string }> }>;
      };

      expect(result.query).toBe("rust web search");
      const searchBlock = result.results.find(
        (entry): entry is { tool_use_id: string; content: Array<{ title: string; url: string }> } =>
          typeof entry === "object" && entry !== null && "content" in entry
      );
      expect(searchBlock?.tool_use_id).toBe("web_search_1");
      expect(searchBlock?.content).toEqual([{ title: "Reqwest docs", url: "https://docs.rs/reqwest" }]);
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.CLAWD_WEB_SEARCH_BASE_URL;
      } else {
        process.env.CLAWD_WEB_SEARCH_BASE_URL = previousBaseUrl;
      }
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("registry_can_include_plugin_tools", () => {
    const registry = GlobalToolRegistry.builtin().withPlugins([
      new PluginDefinition(
        { name: "demo", version: "1.0.0", description: "Demo plugin" },
        new PluginHooks(),
        undefined,
        [
          new PluginTool(
            "demo@external",
            "demo",
            { name: "plugin_echo", inputSchema: { type: "object" } },
            process.execPath,
            [
              "--input-type=module",
              "-e",
              "const chunks=[];for await (const c of process.stdin) chunks.push(c);process.stdout.write(JSON.stringify({plugin:process.env.CLAWD_PLUGIN_ID,input:JSON.parse(Buffer.concat(chunks).toString('utf8'))}))"
            ]
          )
        ]
      )
    ]);

    expect(registry.entries().some((entry) => entry.name === "plugin_echo" && entry.source === "plugin")).toBe(true);
    expect(
      registry
        .withPermissionPolicy(new PermissionPolicy("workspace-write"))
        .executeTool("plugin_echo", { message: "hello" })
    ).toContain("demo@external");
  });

  test("execute_tool_unknown_name_throws", () => {
    expect(() =>
      executeTool("not_a_registered_tool", {}, new PermissionPolicy("danger-full-access"))
    ).toThrow("unknown tool");
  });

  test("ports tool search and subagent tool allow-list behavior", async () => {
    const registry = GlobalToolRegistry.builtin();
    const search = registry.search("bash", 5);
    expect(search).toEqual([{ name: "bash", source: "runtime" }]);

    const general = allowedToolsForSubagent("general-purpose");
    const explore = allowedToolsForSubagent("Explore");
    const plan = allowedToolsForSubagent("Plan");
    const verification = allowedToolsForSubagent("Verification");

    expect(general.has("write_file")).toBe(true);
    expect(explore.has("write_file")).toBe(false);
    expect(plan.has("glob_search")).toBe(true);
    expect(verification.has("bash")).toBe(true);
    expect(explore.has("ListMcpResources")).toBe(true);
    expect(plan.has("Config")).toBe(true);
  });

  test("workspace_tool_registry_loads_enabled_plugins_from_config", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tool-registry-"));
    const pluginScript = path.join(root, "echo-json.sh");
    const pluginManifest = path.join(root, "demo-plugin.json");
    const localConfig = path.join(root, ".clench", "settings.local.json");
    writeFileSync(
      pluginScript,
      "#!/bin/sh\nINPUT=$(cat)\nprintf '{\"plugin\":\"%s\",\"input\":%s}' \"$CLAWD_PLUGIN_ID\" \"$INPUT\"\n",
      "utf8"
    );
    chmodSync(pluginScript, 0o755);
    writeFileSync(
      pluginManifest,
      JSON.stringify(
        {
          metadata: {
            name: "demo-plugin",
            version: "1.0.0",
            description: "Demo plugin"
          },
          tools: [{ name: "plugin_echo", command: "./echo-json.sh" }]
        },
        null,
        2
      ),
      "utf8"
    );
    mkdirSync(path.dirname(localConfig), { recursive: true });
    writeFileSync(
      localConfig,
      JSON.stringify(
        {
          plugins: {
            "demo-plugin": {
              enabled: true,
              path: pluginManifest
            }
          },
          mcp: {
            demo: {
              type: "sdk",
              name: "demo-sdk",
              tools: [
                {
                  name: "echo",
                  description: "Echo MCP tool",
                  inputSchema: { type: "object" },
                  echoArguments: true
                }
              ]
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const registry = loadWorkspaceToolRegistry(root, new PermissionPolicy("workspace-write"));
      expect(registry.entries().some((entry) => entry.name === "plugin_echo" && entry.source === "plugin")).toBe(true);
      expect(registry.entries().some((entry) => entry.name === "mcp__demo__echo")).toBe(true);
      expect(registry.toolDefinition("plugin_echo")?.name).toBe("plugin_echo");
      expect(registry.toolDefinition("mcp__demo__echo")?.name).toBe("mcp__demo__echo");
      expect(executeTool("Config", { section: "model" }, new PermissionPolicy("read-only"))).toContain("section");
      expect(registry.executeTool("plugin_echo", { message: "hello" })).toContain("demo-plugin@external");
      expect(registry.executeTool("mcp__demo__echo", { text: "hello mcp" })).toContain("hello mcp");
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
