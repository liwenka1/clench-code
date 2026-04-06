import type { McpClientBootstrap } from "./mcp-client.js";
import { spawn, type ChildProcess } from "node:child_process";

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
