import { chmodSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

import { runPromptMode } from "../../src/cli/prompt-run";
import { clearRemoteMcpSseSessions } from "../../src/runtime/mcp-remote.js";
import { withEnv } from "../helpers/envGuards";
import { writeJsonFile } from "../helpers/sessionFixtures";
import { createTempWorkspace, type TempWorkspace } from "../helpers/tempWorkspace";

function streamFromString(body: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  });
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe("cli prompt mode with tools", () => {
  const workspaces: TempWorkspace[] = [];
  let previousCwd = process.cwd();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.chdir(previousCwd);
  });

  afterEach(async () => {
    await clearRemoteMcpSseSessions();
  });

  afterEach(async () => {
    await Promise.all(workspaces.splice(0, workspaces.length).map((workspace) => workspace.cleanup()));
  });

  test("run_prompt_mode_bash_tool_then_text_second_stream", async () => {
    const messageStart = {
      type: "message_start",
      message: {
        id: "t1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-7-sonnet-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };

    const sseTool =
      sseData(messageStart) +
      sseData({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "tb1",
          name: "bash",
          input: {}
        }
      }) +
      sseData({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"command":"echo hi"}' }
      }) +
      sseData({ type: "content_block_stop", index: 1 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 3, output_tokens: 3 }
      }) +
      sseData({ type: "message_stop" });

    const sseText =
      sseData({
        ...messageStart,
        message: { ...messageStart.message, id: "t2" }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "After bash." }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 6, output_tokens: 2 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(streamFromString(sseTool), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
        .mockResolvedValueOnce(
          new Response(streamFromString(sseText), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
    );

    await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
      const summary = await runPromptMode({
        prompt: "Run bash",
        model: "claude-sonnet-4-6",
        permissionMode: "danger-full-access",
        outputFormat: "text",
        allowedTools: ["bash"]
      });

      expect(summary.iterations).toBe(2);
      expect(summary.toolResults).toHaveLength(1);
      expect(summary.assistantMessages).toHaveLength(2);
      expect(summary.assistantMessages[1]!.blocks[0]).toMatchObject({
        type: "text",
        text: "After bash."
      });
    });
  });

  test("run_prompt_mode_read_only_denies_bash_then_assistant_recovers", async () => {
    const messageStart = {
      type: "message_start",
      message: {
        id: "ro1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-7-sonnet-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };

    const sseTool =
      sseData(messageStart) +
      sseData({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "tb_ro",
          name: "bash",
          input: {}
        }
      }) +
      sseData({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"command":"whoami"}' }
      }) +
      sseData({ type: "content_block_stop", index: 1 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 2, output_tokens: 2 }
      }) +
      sseData({ type: "message_stop" });

    const sseText =
      sseData({
        ...messageStart,
        message: { ...messageStart.message, id: "ro2" }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Cannot run bash here." }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 5, output_tokens: 4 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(streamFromString(sseTool), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
        .mockResolvedValueOnce(
          new Response(streamFromString(sseText), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
    );

    await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
      const summary = await runPromptMode({
        prompt: "Run bash",
        model: "claude-sonnet-4-6",
        permissionMode: "read-only",
        outputFormat: "text",
        allowedTools: ["bash"]
      });

      expect(summary.iterations).toBe(2);
      expect(summary.toolResults).toHaveLength(1);
      expect(summary.toolResults[0]!.blocks[0]).toMatchObject({
        type: "tool_result",
        tool_name: "bash",
        is_error: true
      });
      const out = String((summary.toolResults[0]!.blocks[0] as { output: string }).output);
      expect(out).toMatch(/read-only|danger-full-access/i);
      expect(summary.assistantMessages[1]!.blocks[0]).toMatchObject({
        type: "text",
        text: "Cannot run bash here."
      });
    });
  });

  test("run_prompt_mode_loads_enabled_plugin_tools_from_workspace_config", async () => {
    const workspace = await createTempWorkspace("clench-plugin-prompt-");
    workspaces.push(workspace);
    previousCwd = process.cwd();
    process.chdir(workspace.root);

    const pluginScript = path.join(workspace.root, "plugin-echo.sh");
    const pluginManifest = path.join(workspace.root, "demo-plugin.json");
    await writeFile(
      pluginScript,
      "#!/bin/sh\nINPUT=$(cat)\nprintf '{\"plugin\":\"%s\",\"input\":%s}' \"$CLAWD_PLUGIN_ID\" \"$INPUT\"\n",
      "utf8"
    );
    chmodSync(pluginScript, 0o755);
    await writeJsonFile(pluginManifest, {
      metadata: {
        name: "demo-plugin",
        version: "1.0.0",
        description: "Demo plugin"
      },
      tools: [
        {
          name: "plugin_echo",
          command: "./plugin-echo.sh",
          requiredPermission: "workspace-write"
        }
      ]
    });
    await writeJsonFile(path.join(workspace.root, ".clench", "settings.local.json"), {
      plugins: {
        "demo-plugin": {
          enabled: true,
          path: pluginManifest
        }
      }
    });

    const messageStart = {
      type: "message_start",
      message: {
        id: "p1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-7-sonnet-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };

    const sseTool =
      sseData(messageStart) +
      sseData({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "plugin-1",
          name: "plugin_echo",
          input: {}
        }
      }) +
      sseData({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"message":"hello plugin"}' }
      }) +
      sseData({ type: "content_block_stop", index: 1 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 4, output_tokens: 3 }
      }) +
      sseData({ type: "message_stop" });

    const sseText =
      sseData({
        ...messageStart,
        message: { ...messageStart.message, id: "p2" }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Plugin tool completed." }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 6, output_tokens: 2 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(streamFromString(sseTool), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
        .mockResolvedValueOnce(
          new Response(streamFromString(sseText), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
    );

    await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
      const summary = await runPromptMode({
        prompt: "Run plugin",
        model: "claude-sonnet-4-6",
        permissionMode: "workspace-write",
        outputFormat: "text",
        allowedTools: ["plugin_echo"]
      });

      expect(summary.iterations).toBe(2);
      expect(summary.toolResults).toHaveLength(1);
      expect(summary.toolResults[0]!.blocks[0]).toMatchObject({
        type: "tool_result",
        tool_name: "plugin_echo",
        is_error: false
      });
      const output = String((summary.toolResults[0]!.blocks[0] as { output: string }).output);
      expect(output).toContain("demo-plugin@external");
      expect(output).toContain("hello plugin");
      expect(summary.assistantMessages[1]!.blocks[0]).toMatchObject({
        type: "text",
        text: "Plugin tool completed."
      });
    });
  });

  test("run_prompt_mode_loads_configured_mcp_tools_from_workspace_config", async () => {
    const workspace = await createTempWorkspace("clench-mcp-prompt-");
    workspaces.push(workspace);
    previousCwd = process.cwd();
    process.chdir(workspace.root);

    await writeJsonFile(path.join(workspace.root, ".clench", "settings.local.json"), {
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
    });

    const messageStart = {
      type: "message_start",
      message: {
        id: "m1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-7-sonnet-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };

    const sseTool =
      sseData(messageStart) +
      sseData({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "mcp-1",
          name: "mcp__demo__echo",
          input: {}
        }
      }) +
      sseData({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"text":"hello from mcp"}' }
      }) +
      sseData({ type: "content_block_stop", index: 1 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 4, output_tokens: 3 }
      }) +
      sseData({ type: "message_stop" });

    const sseText =
      sseData({
        ...messageStart,
        message: { ...messageStart.message, id: "m2" }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "MCP tool completed." }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 6, output_tokens: 2 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(streamFromString(sseTool), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
        .mockResolvedValueOnce(
          new Response(streamFromString(sseText), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
    );

    await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
      const summary = await runPromptMode({
        prompt: "Run mcp",
        model: "claude-sonnet-4-6",
        permissionMode: "read-only",
        outputFormat: "text",
        allowedTools: ["mcp__demo__echo"]
      });

      expect(summary.iterations).toBe(2);
      expect(summary.toolResults).toHaveLength(1);
      expect(summary.toolResults[0]!.blocks[0]).toMatchObject({
        type: "tool_result",
        tool_name: "mcp__demo__echo",
        is_error: false
      });
      const output = String((summary.toolResults[0]!.blocks[0] as { output: string }).output);
      expect(output).toContain("demo");
      expect(output).toContain("hello from mcp");
      expect(summary.assistantMessages[1]!.blocks[0]).toMatchObject({
        type: "text",
        text: "MCP tool completed."
      });
    });
  });

  test("run_prompt_mode_loads_remote_http_mcp_tools_with_saved_oauth_credentials", async () => {
    const workspace = await createTempWorkspace("clench-remote-mcp-prompt-");
    workspaces.push(workspace);
    previousCwd = process.cwd();
    process.chdir(workspace.root);

    const configHome = path.join(workspace.root, ".config-home");
    await writeJsonFile(path.join(configHome, "credentials.json"), {
      oauth: {
        accessToken: "saved-access-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: ["mcp:read"]
      }
    });
    await writeJsonFile(path.join(configHome, "settings.json"), {
      oauth: {
        clientId: "runtime-client",
        authorizeUrl: "https://issuer.example/oauth/authorize",
        tokenUrl: "https://issuer.example/oauth/token",
        scopes: ["mcp:read"]
      }
    });
    await writeJsonFile(path.join(workspace.root, ".clench", "settings.local.json"), {
      mcp: {
        remoteDemo: {
          type: "http",
          url: "https://vendor.example/mcp",
          headers: { "X-Test": "1" },
          oauth: { clientId: "client-1" }
        }
      }
    });

    const messageStart = {
      type: "message_start",
      message: {
        id: "rm1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-7-sonnet-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };

    const sseTool =
      sseData(messageStart) +
      sseData({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "remote-1",
          name: "mcp__remoteDemo__echo",
          input: {}
        }
      }) +
      sseData({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"text":"hello remote"}' }
      }) +
      sseData({ type: "content_block_stop", index: 1 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 4, output_tokens: 3 }
      }) +
      sseData({ type: "message_stop" });

    const sseText =
      sseData({
        ...messageStart,
        message: { ...messageStart.message, id: "rm2" }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "remote MCP completed." }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 6, output_tokens: 2 }
      }) +
      sseData({ type: "message_stop" });

    let providerCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://vendor.example/mcp") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { serverInfo: { name: "remote-echo", version: "1.0.0" } }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (body.method === "tools/list") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              result: {
                tools: [
                  {
                    name: "echo",
                    description: "Remote echo",
                    inputSchema: { type: "object", properties: { text: { type: "string" } } }
                  }
                ]
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (body.method === "resources/list") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              result: { resources: [] }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (body.method === "tools/call") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 4,
              result: {
                content: [{ type: "text", text: "remote:hello remote" }],
                structuredContent: { server: "remote-echo", tool: "echo", echoed: "hello remote" },
                isError: false
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      }

      providerCalls += 1;
      return new Response(streamFromString(providerCalls === 1 ? sseTool : sseText), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await withEnv({ ANTHROPIC_API_KEY: "test-key", CLENCH_CONFIG_HOME: configHome }, async () => {
      const summary = await runPromptMode({
        prompt: "Run remote mcp",
        model: "claude-sonnet-4-6",
        permissionMode: "read-only",
        outputFormat: "text",
        allowedTools: ["mcp__remoteDemo__echo"]
      });

      expect(summary.iterations).toBe(2);
      expect(summary.toolResults).toHaveLength(1);
      expect(summary.toolResults[0]!.blocks[0]).toMatchObject({
        type: "tool_result",
        tool_name: "mcp__remoteDemo__echo",
        is_error: false
      });
      const output = String((summary.toolResults[0]!.blocks[0] as { output: string }).output);
      expect(output).toContain("remote:hello remote");
      expect(summary.assistantMessages[1]!.blocks[0]).toMatchObject({
        type: "text",
        text: "remote MCP completed."
      });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://vendor.example/mcp",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer saved-access-token",
          "X-Test": "1"
        })
      })
    );
  });

  test("run_prompt_mode_reads_remote_mcp_resource_via_generic_tool", async () => {
    const workspace = await createTempWorkspace("clench-remote-mcp-resource-");
    workspaces.push(workspace);
    previousCwd = process.cwd();
    process.chdir(workspace.root);

    const configHome = path.join(workspace.root, ".config-home");
    await writeJsonFile(path.join(configHome, "credentials.json"), {
      oauth: {
        accessToken: "saved-access-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: ["mcp:read"]
      }
    });
    await writeJsonFile(path.join(configHome, "settings.json"), {
      oauth: {
        clientId: "runtime-client",
        authorizeUrl: "https://issuer.example/oauth/authorize",
        tokenUrl: "https://issuer.example/oauth/token",
        scopes: ["mcp:read"]
      }
    });
    await writeJsonFile(path.join(workspace.root, ".clench", "settings.local.json"), {
      mcp: {
        remoteDemo: {
          type: "http",
          url: "https://vendor.example/mcp",
          headers: { "X-Test": "1" },
          oauth: { clientId: "client-1" }
        }
      }
    });

    const messageStart = {
      type: "message_start",
      message: {
        id: "rr1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-7-sonnet-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };

    const sseTool =
      sseData(messageStart) +
      sseData({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "resource-1",
          name: "ReadMcpResource",
          input: {}
        }
      }) +
      sseData({
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"server":"remoteDemo","uri":"resource://notes"}'
        }
      }) +
      sseData({ type: "content_block_stop", index: 1 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 4, output_tokens: 3 }
      }) +
      sseData({ type: "message_stop" });

    const sseText =
      sseData({
        ...messageStart,
        message: { ...messageStart.message, id: "rr2" }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "remote resource completed." }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 6, output_tokens: 2 }
      }) +
      sseData({ type: "message_stop" });

    let providerCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://vendor.example/mcp") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { serverInfo: { name: "remote-echo", version: "1.0.0" } }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (body.method === "tools/list") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              result: { tools: [] }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (body.method === "resources/list") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              result: {
                resources: [
                  {
                    uri: "resource://notes",
                    name: "Notes",
                    mimeType: "text/plain"
                  }
                ]
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (body.method === "resources/read") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 5,
              result: {
                contents: [
                  {
                    uri: "resource://notes",
                    mimeType: "text/plain",
                    text: "remote note body"
                  }
                ]
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      }

      providerCalls += 1;
      return new Response(streamFromString(providerCalls === 1 ? sseTool : sseText), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await withEnv({ ANTHROPIC_API_KEY: "test-key", CLENCH_CONFIG_HOME: configHome }, async () => {
      const summary = await runPromptMode({
        prompt: "Read remote resource",
        model: "claude-sonnet-4-6",
        permissionMode: "read-only",
        outputFormat: "text",
        allowedTools: ["ReadMcpResource"]
      });

      expect(summary.iterations).toBe(2);
      expect(summary.toolResults).toHaveLength(1);
      expect(summary.toolResults[0]!.blocks[0]).toMatchObject({
        type: "tool_result",
        tool_name: "ReadMcpResource",
        is_error: false
      });
      const output = String((summary.toolResults[0]!.blocks[0] as { output: string }).output);
      expect(output).toContain("resource://notes");
      expect(output).toContain("remote note body");
      expect(summary.assistantMessages[1]!.blocks[0]).toMatchObject({
        type: "text",
        text: "remote resource completed."
      });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://vendor.example/mcp",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer saved-access-token"
        })
      })
    );
  });

  test("run_prompt_mode_lists_remote_mcp_resources_via_generic_tool", async () => {
    const workspace = await createTempWorkspace("clench-remote-mcp-list-");
    workspaces.push(workspace);
    previousCwd = process.cwd();
    process.chdir(workspace.root);

    const configHome = path.join(workspace.root, ".config-home");
    await writeJsonFile(path.join(configHome, "credentials.json"), {
      oauth: {
        accessToken: "saved-access-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: ["mcp:read"]
      }
    });
    await writeJsonFile(path.join(configHome, "settings.json"), {
      oauth: {
        clientId: "runtime-client",
        authorizeUrl: "https://issuer.example/oauth/authorize",
        tokenUrl: "https://issuer.example/oauth/token",
        scopes: ["mcp:read"]
      }
    });
    await writeJsonFile(path.join(workspace.root, ".clench", "settings.local.json"), {
      mcp: {
        remoteDemo: {
          type: "http",
          url: "https://vendor.example/mcp",
          headers: { "X-Test": "1" },
          oauth: { clientId: "client-1" }
        }
      }
    });

    const messageStart = {
      type: "message_start",
      message: {
        id: "lr1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-7-sonnet-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };

    const sseTool =
      sseData(messageStart) +
      sseData({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "list-1",
          name: "ListMcpResources",
          input: {}
        }
      }) +
      sseData({
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"server":"remoteDemo"}'
        }
      }) +
      sseData({ type: "content_block_stop", index: 1 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 4, output_tokens: 3 }
      }) +
      sseData({ type: "message_stop" });

    const sseText =
      sseData({
        ...messageStart,
        message: { ...messageStart.message, id: "lr2" }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "remote resource list completed." }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 6, output_tokens: 2 }
      }) +
      sseData({ type: "message_stop" });

    let providerCalls = 0;
    let resourceListCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://vendor.example/mcp") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { serverInfo: { name: "remote-echo", version: "1.0.0" } }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (body.method === "tools/list") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              result: { tools: [] }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (body.method === "resources/list") {
          resourceListCalls += 1;
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: resourceListCalls === 1 ? 3 : 6,
              result: {
                resources: resourceListCalls === 1
                  ? [{ uri: "resource://bootstrap", name: "Bootstrap", mimeType: "text/plain" }]
                  : [
                      { uri: "resource://fresh", name: "Fresh", mimeType: "text/plain" },
                      { uri: "resource://second", name: "Second", mimeType: "application/json" }
                    ]
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      }

      providerCalls += 1;
      return new Response(streamFromString(providerCalls === 1 ? sseTool : sseText), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await withEnv({ ANTHROPIC_API_KEY: "test-key", CLENCH_CONFIG_HOME: configHome }, async () => {
      const summary = await runPromptMode({
        prompt: "List remote resources",
        model: "claude-sonnet-4-6",
        permissionMode: "read-only",
        outputFormat: "text",
        allowedTools: ["ListMcpResources"]
      });

      expect(summary.iterations).toBe(2);
      expect(summary.toolResults).toHaveLength(1);
      expect(summary.toolResults[0]!.blocks[0]).toMatchObject({
        type: "tool_result",
        tool_name: "ListMcpResources",
        is_error: false
      });
      const output = String((summary.toolResults[0]!.blocks[0] as { output: string }).output);
      expect(output).toContain("resource://fresh");
      expect(output).toContain("resource://second");
      expect(output).not.toContain("resource://bootstrap");
      expect(summary.assistantMessages[1]!.blocks[0]).toMatchObject({
        type: "text",
        text: "remote resource list completed."
      });
      expect(summary.mcpTurnRuntime?.activities).toEqual([
        {
          serverName: "remoteDemo",
          toolCallCount: 0,
          resourceListCount: 1,
          resourceReadCount: 0,
          errorCount: 0,
          toolNames: [],
          resourceUris: []
        }
      ]);
      expect(summary.mcpTurnRuntime?.events).toEqual([
        {
          order: 1,
          serverName: "remoteDemo",
          kind: "resource_list",
          name: "resources/list",
          isError: false
        }
      ]);
    });

    expect(resourceListCalls).toBeGreaterThanOrEqual(2);
  });

  test("run_prompt_mode_loads_remote_sse_mcp_tools_with_event_stream_transport", async () => {
    const workspace = await createTempWorkspace("clench-remote-sse-mcp-prompt-");
    workspaces.push(workspace);
    previousCwd = process.cwd();
    process.chdir(workspace.root);

    const configHome = path.join(workspace.root, ".config-home");
    await writeJsonFile(path.join(configHome, "credentials.json"), {
      oauth: {
        accessToken: "saved-access-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scopes: ["mcp:read"]
      }
    });
    await writeJsonFile(path.join(configHome, "settings.json"), {
      oauth: {
        clientId: "runtime-client",
        authorizeUrl: "https://issuer.example/oauth/authorize",
        tokenUrl: "https://issuer.example/oauth/token",
        scopes: ["mcp:read"]
      }
    });
    await writeJsonFile(path.join(workspace.root, ".clench", "settings.local.json"), {
      mcp: {
        remoteSse: {
          type: "sse",
          url: "https://vendor.example/sse",
          headers: { "X-Test": "1" },
          oauth: { clientId: "client-1" }
        }
      }
    });

    const messageStart = {
      type: "message_start",
      message: {
        id: "se1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-7-sonnet-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };

    const sseTool =
      sseData(messageStart) +
      sseData({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "sse-1",
          name: "mcp__remoteSse__echo",
          input: {}
        }
      }) +
      sseData({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"text":"hello sse"}' }
      }) +
      sseData({ type: "content_block_stop", index: 1 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 4, output_tokens: 3 }
      }) +
      sseData({ type: "message_stop" });

    const sseText =
      sseData({
        ...messageStart,
        message: { ...messageStart.message, id: "se2" }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "remote sse MCP completed." }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 6, output_tokens: 2 }
      }) +
      sseData({ type: "message_stop" });

    let providerCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://vendor.example/sse") {
        if ((init?.method ?? "GET") === "GET") {
          return new Response(
            streamFromString(
              [
                'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"remote-sse","version":"1.0.0"}}}\n\n',
                'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","description":"SSE echo","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}]}}\n\n',
                'event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"resources":[]}}\n\n',
                'event: message\ndata: {"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"sse:hello sse"}],"structuredContent":{"server":"remote-sse","tool":"echo","echoed":"hello sse"},"isError":false}}\n\n'
              ].join("")
            ),
            { status: 200, headers: { "content-type": "text/event-stream" } }
          );
        }
        return new Response("", {
          status: 202,
          headers: { "content-type": "application/json" }
        });
      }

      providerCalls += 1;
      return new Response(streamFromString(providerCalls === 1 ? sseTool : sseText), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await withEnv({ ANTHROPIC_API_KEY: "test-key", CLENCH_CONFIG_HOME: configHome }, async () => {
      const summary = await runPromptMode({
        prompt: "Run remote sse mcp",
        model: "claude-sonnet-4-6",
        permissionMode: "read-only",
        outputFormat: "text",
        allowedTools: ["mcp__remoteSse__echo"]
      });

      expect(summary.iterations).toBe(2);
      expect(summary.toolResults).toHaveLength(1);
      expect(summary.toolResults[0]!.blocks[0]).toMatchObject({
        type: "tool_result",
        tool_name: "mcp__remoteSse__echo",
        is_error: false
      });
      const output = String((summary.toolResults[0]!.blocks[0] as { output: string }).output);
      expect(output).toContain("sse:hello sse");
      expect(summary.assistantMessages[1]!.blocks[0]).toMatchObject({
        type: "text",
        text: "remote sse MCP completed."
      });
      expect(summary.mcpTurnRuntime?.configuredServerCount).toBe(1);
      expect(summary.mcpTurnRuntime?.sseServerCount).toBe(1);
      expect(summary.mcpTurnRuntime?.before).toMatchObject({
        configuredServerCount: 1,
        sseServerCount: 1,
        activeSseSessions: 0,
        totalReconnects: 0
      });
      expect(summary.mcpTurnRuntime?.after?.configuredServerCount).toBe(1);
      expect(summary.mcpTurnRuntime?.after?.sseServerCount).toBe(1);
      expect(summary.mcpTurnRuntime?.changedServerCount).toBe(1);
      expect(summary.mcpTurnRuntime?.hadActivity).toBe(true);
      expect(summary.mcpTurnRuntime?.activities).toEqual([
        {
          serverName: "remoteSse",
          toolCallCount: 1,
          resourceListCount: 0,
          resourceReadCount: 0,
          errorCount: 0,
          toolNames: ["echo"],
          resourceUris: []
        }
      ]);
      expect(summary.mcpTurnRuntime?.events).toEqual([
        {
          order: 1,
          serverName: "remoteSse",
          kind: "tool",
          name: "echo",
          isError: false
        }
      ]);
      expect(summary.mcpTurnRuntime?.sessionChanges).toHaveLength(1);
      expect(summary.mcpTurnRuntime?.sessionChanges[0]).toMatchObject({
        serverName: "remoteSse",
        connectionBefore: "idle",
        reconnectsBefore: 0
      });
      expect(summary.mcpTurnRuntime?.sessionChanges[0]?.reconnectsAfter).toBeGreaterThan(0);
      expect(summary.mcpTurnRuntime?.totalReconnects).toBe(summary.mcpTurnRuntime?.sessionChanges[0]?.reconnectsAfter);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://vendor.example/sse",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          accept: "text/event-stream, application/json",
          Authorization: "Bearer saved-access-token"
        })
      })
    );
  });

  test("run_prompt_mode_loads_stdio_mcp_tools_from_workspace_config", async () => {
    const workspace = await createTempWorkspace("clench-stdio-mcp-prompt-");
    workspaces.push(workspace);
    previousCwd = process.cwd();
    process.chdir(workspace.root);

    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../fixtures/mcp-stdio-echo.mjs"
    );
    await writeJsonFile(path.join(workspace.root, ".clench", "settings.local.json"), {
      mcp: {
        stdioDemo: {
          type: "stdio",
          command: process.execPath,
          args: [fixture],
          env: {}
        }
      }
    });

    const messageStart = {
      type: "message_start",
      message: {
        id: "s1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-7-sonnet-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };

    const sseTool =
      sseData(messageStart) +
      sseData({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "stdio-1",
          name: "mcp__stdioDemo__echo",
          input: {}
        }
      }) +
      sseData({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"text":"hello stdio"}' }
      }) +
      sseData({ type: "content_block_stop", index: 1 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 4, output_tokens: 3 }
      }) +
      sseData({ type: "message_stop" });

    const sseText =
      sseData({
        ...messageStart,
        message: { ...messageStart.message, id: "s2" }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "stdio MCP completed." }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 6, output_tokens: 2 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(streamFromString(sseTool), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
        .mockResolvedValueOnce(
          new Response(streamFromString(sseText), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
    );

    await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
      const summary = await runPromptMode({
        prompt: "Run stdio mcp",
        model: "claude-sonnet-4-6",
        permissionMode: "read-only",
        outputFormat: "text",
        allowedTools: ["mcp__stdioDemo__echo"]
      });

      expect(summary.iterations).toBe(2);
      expect(summary.toolResults).toHaveLength(1);
      expect(summary.toolResults[0]!.blocks[0]).toMatchObject({
        type: "tool_result",
        tool_name: "mcp__stdioDemo__echo",
        is_error: false
      });
      const output = String((summary.toolResults[0]!.blocks[0] as { output: string }).output);
      expect(output).toContain("echo:hello stdio");
      expect(summary.assistantMessages[1]!.blocks[0]).toMatchObject({
        type: "text",
        text: "stdio MCP completed."
      });
    });
  });
});
