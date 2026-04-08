import type { McpClientBootstrap } from "./mcp-client.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { resolvedMcpToolCallTimeoutMs } from "./mcp-client.js";

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpServerDescription {
  serverName: string;
  tools?: McpToolDefinition[];
  resources?: McpResourceDefinition[];
  handlers?: Record<string, (params?: unknown) => unknown>;
}

export interface McpStdioServerSnapshot {
  serverInfo?: string;
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
}

export function encodeStdioMessage(message: JsonRpcMessage): string {
  const payload = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
}

export function decodeStdioMessage(frame: string): JsonRpcMessage {
  const separator = "\r\n\r\n";
  const index = frame.indexOf(separator);
  if (index === -1) {
    throw new Error("invalid MCP stdio frame");
  }
  return JSON.parse(frame.slice(index + separator.length)) as JsonRpcMessage;
}

export class McpStdioParser {
  private buffer = "";

  pushChunk(chunk: string): JsonRpcMessage[] {
    this.buffer += chunk;
    const messages: JsonRpcMessage[] = [];

    while (true) {
      const separatorIndex = this.buffer.indexOf("\r\n\r\n");
      if (separatorIndex === -1) {
        break;
      }

      const header = this.buffer.slice(0, separatorIndex);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        throw new Error("missing content length");
      }
      const length = Number(match[1]);
      const bodyStart = separatorIndex + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) {
        break;
      }
      const payload = this.buffer.slice(bodyStart, bodyEnd);
      messages.push(JSON.parse(payload) as JsonRpcMessage);
      this.buffer = this.buffer.slice(bodyEnd);
    }

    return messages;
  }
}

export class McpServerManager {
  private readonly servers = new Map<string, McpServerDescription>();

  constructor(servers: McpServerDescription[] = []) {
    servers.forEach((server) => this.register(server));
  }

  register(server: McpServerDescription): void {
    this.servers.set(server.serverName, {
      ...server,
      tools: [...(server.tools ?? [])],
      resources: [...(server.resources ?? [])],
      handlers: { ...(server.handlers ?? {}) }
    });
  }

  listServers(): string[] {
    return [...this.servers.keys()];
  }

  discoverTools(serverName?: string): Record<string, McpToolDefinition[]> {
    if (serverName) {
      const server = this.mustGet(serverName);
      return { [serverName]: [...(server.tools ?? [])] };
    }
    return Object.fromEntries(
      [...this.servers.entries()].map(([name, server]) => [name, [...(server.tools ?? [])]])
    );
  }

  discoverResources(serverName?: string): Record<string, McpResourceDefinition[]> {
    if (serverName) {
      const server = this.mustGet(serverName);
      return { [serverName]: [...(server.resources ?? [])] };
    }
    return Object.fromEntries(
      [...this.servers.entries()].map(([name, server]) => [name, [...(server.resources ?? [])]])
    );
  }

  callTool(qualifiedToolName: string, argumentsValue?: unknown): unknown {
    const match = qualifiedToolName.match(/^mcp__(.+?)__(.+)$/);
    if (!match) {
      throw new Error(`invalid qualified tool name: ${qualifiedToolName}`);
    }
    const [, serverName, toolName] = match;
    const server = this.mustGet(serverName);
    const handler = server.handlers?.[toolName];
    if (!handler) {
      throw new Error(`tool '${toolName}' not found on server '${serverName}'`);
    }
    return handler(argumentsValue);
  }

  shutdown(): void {}

  private mustGet(serverName: string): McpServerDescription {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`server '${serverName}' not found`);
    }
    return server;
  }
}

/** Child process with piped stdin/stdout for MCP stdio transport (Rust `McpStdioProcess`). */
export class McpStdioProcess {
  readonly child: ChildProcess;

  constructor(child: ChildProcess) {
    this.child = child;
  }

  static spawnFromStdioTransport(transport: {
    command: string;
    args: string[];
    env: Record<string, string>;
  }): McpStdioProcess {
    const child = spawn(transport.command, transport.args, {
      env: { ...process.env, ...transport.env },
      stdio: ["pipe", "pipe", "inherit"]
    });
    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new Error("stdio MCP process missing stdin or stdout pipe");
    }
    return new McpStdioProcess(child);
  }
}

export function spawnMcpStdioProcess(bootstrap: McpClientBootstrap): McpStdioProcess {
  if (bootstrap.transport.type !== "stdio") {
    throw new Error(
      `MCP bootstrap transport for ${bootstrap.serverName} is not stdio: ${JSON.stringify(bootstrap.transport)}`
    );
  }
  return McpStdioProcess.spawnFromStdioTransport(bootstrap.transport);
}

export function callMcpStdioTransportOnce(
  transport: Extract<McpClientBootstrap["transport"], { type: "stdio" }>,
  message: JsonRpcMessage
): JsonRpcMessage {
  const result = spawnSync(transport.command, transport.args, {
    input: encodeStdioMessage(message),
    encoding: "utf8",
    env: { ...process.env, ...transport.env },
    timeout: resolvedMcpToolCallTimeoutMs(transport)
  });

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 0) !== 0) {
    throw new Error((result.stderr || result.stdout || "MCP stdio command failed").trim());
  }

  const parser = new McpStdioParser();
  const messages = parser.pushChunk(result.stdout);
  if (messages.length === 0) {
    throw new Error("MCP stdio command produced no JSON-RPC response");
  }
  return messages[0]!;
}

export function discoverMcpStdioServer(bootstrap: McpClientBootstrap): McpStdioServerSnapshot {
  if (bootstrap.transport.type !== "stdio") {
    throw new Error(`MCP bootstrap transport for ${bootstrap.serverName} is not stdio`);
  }

  const initialize = callMcpStdioTransportOnce(bootstrap.transport, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" }
  });
  const toolList = callOptionalRequest(bootstrap.transport, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  const resourceList = callOptionalRequest(bootstrap.transport, {
    jsonrpc: "2.0",
    id: 3,
    method: "resources/list",
    params: {}
  });

  const initResult = (initialize.result ?? {}) as {
    serverInfo?: { name?: string; version?: string };
  };
  const serverInfo = initResult.serverInfo?.name
    ? `${initResult.serverInfo.name}${initResult.serverInfo.version ? `@${initResult.serverInfo.version}` : ""}`
    : undefined;

  return {
    serverInfo,
    tools: Array.isArray((toolList?.result as { tools?: unknown[] } | undefined)?.tools)
      ? (((toolList!.result as { tools: McpToolDefinition[] }).tools) ?? [])
      : [],
    resources: Array.isArray((resourceList?.result as { resources?: unknown[] } | undefined)?.resources)
      ? (((resourceList!.result as { resources: McpResourceDefinition[] }).resources) ?? [])
      : []
  };
}

export function callMcpStdioTool(
  bootstrap: McpClientBootstrap,
  toolName: string,
  argumentsValue?: unknown
): unknown {
  if (bootstrap.transport.type !== "stdio") {
    throw new Error(`MCP bootstrap transport for ${bootstrap.serverName} is not stdio`);
  }
  const response = callMcpStdioTransportOnce(bootstrap.transport, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: argumentsValue ?? {}
    }
  });
  return response.result;
}

function callOptionalRequest(
  transport: Extract<McpClientBootstrap["transport"], { type: "stdio" }>,
  message: JsonRpcMessage
): JsonRpcMessage | undefined {
  try {
    return callMcpStdioTransportOnce(transport, message);
  } catch {
    return undefined;
  }
}
