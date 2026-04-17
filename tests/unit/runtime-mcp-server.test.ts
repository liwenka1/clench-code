import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  MCP_SERVER_ERROR_CODES,
  MCP_SERVER_PROTOCOL_VERSION,
  McpServer,
  McpStdioParser,
  encodeStdioMessage,
  type JsonRpcMessage,
  type McpServerSpec,
  type McpToolDefinition
} from "../../src/runtime";

function echoTool(): McpToolDefinition {
  return {
    name: "echo",
    description: "Echo text back to the caller.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } }
  };
}

function makeSpec(overrides: Partial<McpServerSpec> = {}): McpServerSpec {
  return {
    serverName: "clench-test",
    serverVersion: "0.0.1",
    tools: [echoTool()],
    toolHandler: (name, args) => {
      if (name === "echo") {
        const text = (args as { text?: unknown }).text;
        return typeof text === "string" ? text : JSON.stringify(args);
      }
      throw new Error(`unknown tool: ${name}`);
    },
    ...overrides
  };
}

describe("McpServer.dispatchMessage", () => {
  it("answers initialize with protocol version and serverInfo", async () => {
    const server = new McpServer(makeSpec());
    const response = await server.dispatchMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" }
    });
    expect(response).toBeDefined();
    expect(response?.id).toBe(1);
    expect(response?.error).toBeUndefined();
    const result = response?.result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
      serverInfo: { name: string; version: string };
    };
    expect(result.protocolVersion).toBe(MCP_SERVER_PROTOCOL_VERSION);
    expect(result.capabilities.tools).toEqual({});
    expect(result.serverInfo).toEqual({ name: "clench-test", version: "0.0.1" });
  });

  it("answers tools/list with the registered tool descriptors", async () => {
    const server = new McpServer(makeSpec());
    const response = await server.dispatchMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    });
    const result = response?.result as { tools: McpToolDefinition[] };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe("echo");
  });

  it("wraps handler output as a single text content block", async () => {
    const server = new McpServer(makeSpec());
    const response = await server.dispatchMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } }
    });
    const result = response?.result as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("surfaces thrown handler errors as isError=true blocks", async () => {
    const server = new McpServer(makeSpec());
    const response = await server.dispatchMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "broken" }
    });
    const result = response?.result as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("unknown tool: broken");
  });

  it("supports McpToolCallOutcome returned from the handler", async () => {
    const server = new McpServer(
      makeSpec({
        toolHandler: () => ({ text: "soft failure", isError: true })
      })
    );
    const response = await server.dispatchMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "echo" }
    });
    const result = response?.result as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("soft failure");
  });

  it("returns method_not_found for unknown methods", async () => {
    const server = new McpServer(makeSpec());
    const response = await server.dispatchMessage({
      jsonrpc: "2.0",
      id: 6,
      method: "nope"
    });
    expect(response?.error?.code).toBe(MCP_SERVER_ERROR_CODES.methodNotFound);
    expect(response?.error?.message).toContain("nope");
  });

  it("returns invalid_params when tools/call is missing params", async () => {
    const server = new McpServer(makeSpec());
    const response = await server.dispatchMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call"
    });
    expect(response?.error?.code).toBe(MCP_SERVER_ERROR_CODES.invalidParams);
  });

  it("returns invalid_params when tools/call is missing a tool name", async () => {
    const server = new McpServer(makeSpec());
    const response = await server.dispatchMessage({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { arguments: {} }
    });
    expect(response?.error?.code).toBe(MCP_SERVER_ERROR_CODES.invalidParams);
  });

  it("drops notifications (messages without id) without responding", async () => {
    const server = new McpServer(makeSpec());
    const response = await server.dispatchMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });
    expect(response).toBeUndefined();
  });
});

describe("McpServer.run (stream-driven)", () => {
  it("reads framed requests and writes framed responses", async () => {
    const server = new McpServer(makeSpec());
    const input = new PassThrough();
    const output = new PassThrough();

    const runPromise = server.run(input, output);

    const initializeFrame = encodeStdioMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize"
    });
    const toolsCallFrame = encodeStdioMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "streamed" } }
    });

    input.write(initializeFrame);
    input.write(toolsCallFrame);
    input.end();

    const messages: JsonRpcMessage[] = [];
    const parser = new McpStdioParser();
    output.on("data", (chunk: Buffer) => {
      for (const frame of parser.pushChunk(chunk.toString("utf8"))) {
        messages.push(frame);
      }
    });

    await runPromise;

    const messagesById = new Map(messages.map((msg) => [msg.id, msg]));
    expect(messagesById.size).toBe(2);
    const initResult = messagesById.get(1)?.result as { protocolVersion: string };
    expect(initResult.protocolVersion).toBe(MCP_SERVER_PROTOCOL_VERSION);
    const callResult = messagesById.get(2)?.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(callResult.isError).toBe(false);
    expect(callResult.content[0]!.text).toBe("streamed");
  });
});
