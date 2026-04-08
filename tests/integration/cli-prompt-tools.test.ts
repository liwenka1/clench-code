import { chmodSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

import { runPromptMode } from "../../src/cli/prompt-run";
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
