import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { runMcpServe } from "../../src/cli/mcp-serve";
import {
  MCP_SERVER_PROTOCOL_VERSION,
  McpStdioParser,
  encodeStdioMessage,
  type JsonRpcMessage,
  type McpToolDefinition
} from "../../src/runtime";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function collectFrames(stream: PassThrough): { messages: JsonRpcMessage[] } {
  const parser = new McpStdioParser();
  const collected: JsonRpcMessage[] = [];
  stream.on("data", (chunk: Buffer) => {
    for (const frame of parser.pushChunk(chunk.toString("utf8"))) {
      collected.push(frame);
    }
  });
  return { messages: collected };
}

describe("cli mcp serve", () => {
  it("answers initialize, advertises built-in tools, and dispatches tools/call through the registry", async () => {
    const cwd = makeTempDir("clench-mcp-serve-");
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const sink = collectFrames(output);

      const servePromise = runMcpServe({ cwd, stdin: input, stdout: output });

      input.write(
        encodeStdioMessage({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize"
        })
      );
      input.write(
        encodeStdioMessage({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list"
        })
      );
      input.write(
        encodeStdioMessage({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "write_file",
            arguments: { path: "hello.txt", content: "hi" }
          }
        })
      );
      input.end();

      await servePromise;

      const byId = new Map(sink.messages.map((msg) => [msg.id, msg]));
      expect(byId.size).toBe(3);

      const initResult = byId.get(1)?.result as {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
      };
      expect(initResult.protocolVersion).toBe(MCP_SERVER_PROTOCOL_VERSION);
      expect(initResult.serverInfo.name).toBe("clench");
      expect(typeof initResult.serverInfo.version).toBe("string");

      const listResult = byId.get(2)?.result as { tools: McpToolDefinition[] };
      const toolNames = new Set(listResult.tools.map((tool) => tool.name));
      expect(toolNames.has("read_file")).toBe(true);
      expect(toolNames.has("write_file")).toBe(true);
      expect(toolNames.has("bash")).toBe(true);
      for (const tool of listResult.tools) {
        expect(typeof tool.description === "string" || tool.description === undefined).toBe(true);
        expect(typeof tool.inputSchema === "object").toBe(true);
      }

      const callResult = byId.get(3)?.result as {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(callResult.isError).toBe(false);
      expect(callResult.content[0]!.type).toBe("text");
      expect(callResult.content[0]!.text).toBe("hello.txt");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("surfaces tool execution errors as isError=true blocks", async () => {
    const cwd = makeTempDir("clench-mcp-serve-err-");
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const sink = collectFrames(output);

      const servePromise = runMcpServe({ cwd, stdin: input, stdout: output });

      input.write(
        encodeStdioMessage({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "NotATool", arguments: {} }
        })
      );
      input.end();

      await servePromise;

      const response = sink.messages.find((msg) => msg.id === 7);
      const result = response?.result as {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("unknown tool");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
