import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { mcpClientBootstrapFromScopedConfig } from "../../src/runtime/mcp-client.js";
import { mcpToolName } from "../../src/runtime/mcp.js";
import {
  McpServerManager,
  McpStdioParser,
  callMcpStdioTool,
  decodeStdioMessage,
  discoverMcpStdioServer,
  encodeStdioMessage,
  spawnMcpStdioProcess
} from "../../src/runtime/mcp-stdio.js";

describe("runtime mcp stdio", () => {
  test("ports MCP stdio protocol behavior", async () => {
    const message = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" }
    };

    const frame = encodeStdioMessage(message);
    expect(frame).toContain("Content-Length:");
    expect(decodeStdioMessage(frame)).toEqual(message);

    const parser = new McpStdioParser();
    const parsedFirst = parser.pushChunk(frame.slice(0, 12));
    expect(parsedFirst).toEqual([]);
    const parsedSecond = parser.pushChunk(frame.slice(12));
    expect(parsedSecond).toEqual([message]);

    const manager = new McpServerManager([
      {
        serverName: "alpha",
        tools: [{ name: "echo", description: "Echo tool" }],
        resources: [{ uri: "res://alpha", name: "Alpha" }],
        handlers: {
          echo: (params) => {
            const text = (params as { text?: string } | undefined)?.text ?? "";
            return {
              content: [{ type: "text", text: `alpha:${text}` }],
              structuredContent: { server: "alpha", echoed: text },
              isError: false
            };
          }
        }
      }
    ]);

    expect(manager.listServers()).toEqual(["alpha"]);
    expect(manager.discoverTools("alpha").alpha[0]?.name).toBe("echo");
    expect(manager.discoverResources("alpha").alpha[0]?.uri).toBe("res://alpha");
    expect(manager.callTool("mcp__alpha__echo", { text: "hello" })).toEqual({
      content: [{ type: "text", text: "alpha:hello" }],
      structuredContent: { server: "alpha", echoed: "hello" },
      isError: false
    });
    expect(() => manager.callTool("invalid", {})).toThrow("invalid qualified tool name");

    const underscore = new McpServerManager([
      {
        serverName: "__leading",
        tools: [{ name: "echo" }],
        handlers: {
          echo: () => ({ ok: true })
        }
      }
    ]);
    expect(underscore.callTool(mcpToolName("__leading", "echo"), {})).toEqual({ ok: true });

    expect(() =>
      spawnMcpStdioProcess(
        mcpClientBootstrapFromScopedConfig("remote", {
          scope: "user",
          config: { type: "http", url: "https://example.com", headers: {} }
        })
      )
    ).toThrow(/MCP bootstrap transport for remote is not stdio/);

    const stdioBoot = mcpClientBootstrapFromScopedConfig("stdio-child", {
      scope: "local",
      config: {
        type: "stdio",
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1 << 30);"],
        env: {}
      }
    });
    const spawned = spawnMcpStdioProcess(stdioBoot);
    expect(spawned.child.stdin).toBeTruthy();
    expect(spawned.child.stdout).toBeTruthy();
    spawned.child.kill("SIGKILL");
  });

  test("stdio_parser_reassembles_frame_split_into_many_small_chunks", () => {
    const a = {
      jsonrpc: "2.0" as const,
      id: 2,
      method: "ping",
      params: {}
    };
    const b = {
      jsonrpc: "2.0" as const,
      id: 3,
      method: "shutdown",
      params: null
    };
    const wire = encodeStdioMessage(a) + encodeStdioMessage(b);
    const parser = new McpStdioParser();
    const out: ReturnType<McpStdioParser["pushChunk"]> = [];
    for (let i = 0; i < wire.length; i += 3) {
      out.push(...parser.pushChunk(wire.slice(i, i + 3)));
    }
    expect(out).toEqual([a, b]);
  });

  test("stdio_echo_child_round_trips_one_jsonrpc_frame_over_pipes", async () => {
    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../fixtures/mcp-stdio-echo.mjs"
    );
    const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
    const stdin = child.stdin!;
    const stdout = child.stdout!;
    const req = {
      jsonrpc: "2.0" as const,
      id: 42,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" }
    };
    const frame = encodeStdioMessage(req);
    const wirePromise = new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stdout.on("data", (c) => chunks.push(c));
      stdout.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      stdout.on("error", reject);
    });
    const exitPromise = new Promise<number>((resolve) => child.once("exit", resolve));
    stdin.write(frame);
    stdin.end();
    const [wire, code] = await Promise.all([wirePromise, exitPromise]);
    expect(code).toBe(0);
    const parser = new McpStdioParser();
    const msgs = parser.pushChunk(wire);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 42,
      result: { ok: true, method: "initialize" }
    });
  });

  test("decodeStdioMessage_throws_when_frame_has_no_header_separator", () => {
    expect(() => decodeStdioMessage("not a frame")).toThrow(/invalid MCP stdio frame/);
  });

  test("discoverMcpStdioServer_and_callMcpStdioTool_bootstrap_a_stdio_fixture", () => {
    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../fixtures/mcp-stdio-echo.mjs"
    );
    const bootstrap = mcpClientBootstrapFromScopedConfig("echo-child", {
      scope: "local",
      config: {
        type: "stdio",
        command: process.execPath,
        args: [fixture],
        env: {}
      }
    });

    const snapshot = discoverMcpStdioServer(bootstrap);
    expect(snapshot.serverInfo).toBe("echo-stdio@1.0.0");
    expect(snapshot.tools).toEqual([
      {
        name: "echo",
        description: "Echo input text",
        inputSchema: { type: "object", properties: { text: { type: "string" } } }
      }
    ]);
    expect(snapshot.resources).toEqual([
      {
        uri: "resource://echo",
        name: "Echo Resource",
        mimeType: "application/json"
      }
    ]);
    expect(callMcpStdioTool(bootstrap, "echo", { text: "hello" })).toEqual({
      content: [{ type: "text", text: "echo:hello" }],
      structuredContent: { server: "echo-stdio", tool: "echo", echoed: "hello" },
      isError: false
    });
  });

  test("McpStdioParser_throws_when_header_missing_content_length", () => {
    const parser = new McpStdioParser();
    expect(() => parser.pushChunk("X: 1\r\n\r\n{}")).toThrow(/missing content length/);
  });

  test("McpStdioParser_throws_on_invalid_json_payload", () => {
    const parser = new McpStdioParser();
    const frame = "Content-Length: 5\r\n\r\n{not}";
    expect(() => parser.pushChunk(frame)).toThrow(SyntaxError);
  });
});
