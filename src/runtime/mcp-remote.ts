import type { McpClientBootstrap } from "./mcp-client.js";
import { loadOauthConfig, loadOauthCredentials, oauthTokenIsExpired, resolveSavedOAuthTokenSet } from "./oauth.js";
import { IncrementalSseParser } from "./sse.js";

import type { JsonRpcMessage, McpResourceDefinition, McpToolDefinition } from "./mcp-stdio.js";

export interface McpRemoteServerSnapshot {
  serverInfo?: string;
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
}

export async function discoverRemoteMcpServer(bootstrap: McpClientBootstrap): Promise<McpRemoteServerSnapshot> {
  const initialize = await callRemoteMcpTransportOnce(bootstrap, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" }
  });
  const toolList = await callOptionalRemoteRequest(bootstrap, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  const resourceList = await callOptionalRemoteRequest(bootstrap, {
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

export async function callRemoteMcpTool(
  bootstrap: McpClientBootstrap,
  toolName: string,
  argumentsValue?: unknown
): Promise<unknown> {
  const response = await callRemoteMcpTransportOnce(bootstrap, {
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

export async function readRemoteMcpResource(
  bootstrap: McpClientBootstrap,
  uri: string
): Promise<unknown> {
  const response = await callRemoteMcpTransportOnce(bootstrap, {
    jsonrpc: "2.0",
    id: 5,
    method: "resources/read",
    params: { uri }
  });
  return response.result;
}

export async function listRemoteMcpResources(
  bootstrap: McpClientBootstrap
): Promise<McpResourceDefinition[]> {
  const response = await callRemoteMcpTransportOnce(bootstrap, {
    jsonrpc: "2.0",
    id: 6,
    method: "resources/list",
    params: {}
  });
  const resources = (response.result as { resources?: unknown[] } | undefined)?.resources;
  return Array.isArray(resources) ? (resources as McpResourceDefinition[]) : [];
}

export async function callRemoteMcpTransportOnce(
  bootstrap: McpClientBootstrap,
  message: JsonRpcMessage
): Promise<JsonRpcMessage> {
  if (bootstrap.transport.type !== "http" && bootstrap.transport.type !== "sse") {
    throw new Error(`MCP bootstrap transport for ${bootstrap.serverName} is not remote HTTP/SSE`);
  }

  if (bootstrap.transport.type === "sse") {
    return await requestOverSseSession(bootstrap, message);
  }

  const headers = await remoteHeadersForBootstrap(bootstrap);
  const response = await postRemoteJsonRpc(bootstrap.transport.url, headers, message, "application/json");

  if (!response.ok) {
    throw new Error(`remote MCP request failed with status ${response.status}`);
  }

  return await decodeRemoteMcpResponse(response, "http");
}

async function remoteHeadersForBootstrap(bootstrap: McpClientBootstrap): Promise<Record<string, string>> {
  if (bootstrap.transport.type !== "http" && bootstrap.transport.type !== "sse") {
    return {};
  }
  const headers = { ...bootstrap.transport.headers };
  const bearer = await resolveMcpOauthAccessToken(bootstrap);
  if (bearer && !headers.Authorization) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  return headers;
}

async function resolveMcpOauthAccessToken(bootstrap: McpClientBootstrap): Promise<string | undefined> {
  if (
    bootstrap.transport.type !== "http" &&
    bootstrap.transport.type !== "sse"
  ) {
    return undefined;
  }
  if (bootstrap.transport.auth.type !== "oauth") {
    return undefined;
  }

  const saved = loadOauthCredentials();
  if (!saved) {
    return undefined;
  }
  if (!oauthTokenIsExpired(saved)) {
    return saved.accessToken;
  }
  if (!saved.refreshToken) {
    return undefined;
  }

  const config = loadOauthConfig();
  if (!config) {
    return undefined;
  }
  const resolved = await resolveSavedOAuthTokenSet(config, saved);
  return resolved.accessToken;
}

async function callOptionalRemoteRequest(
  bootstrap: McpClientBootstrap,
  message: JsonRpcMessage
): Promise<JsonRpcMessage | undefined> {
  try {
    return await callRemoteMcpTransportOnce(bootstrap, message);
  } catch {
    return undefined;
  }
}

async function decodeRemoteMcpResponse(
  response: Response,
  transportType: "http" | "sse"
): Promise<JsonRpcMessage> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (transportType === "sse" || contentType.includes("text/event-stream")) {
    return await decodeSseJsonRpcResponse(response);
  }
  const payload = await response.json();
  return payload as JsonRpcMessage;
}

async function decodeSseJsonRpcResponse(response: Response): Promise<JsonRpcMessage> {
  if (!response.body) {
    throw new Error("remote MCP SSE response body is missing");
  }

  const parser = new IncrementalSseParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      const messages = sseEventsToJsonRpc(parser.pushChunk(chunk));
      if (messages.length > 0) {
        return messages[0]!;
      }
    }
    const trailing = decoder.decode();
    const finalEvents = parser.pushChunk(trailing);
    const messages = sseEventsToJsonRpc([...finalEvents, ...parser.finish()]);
    if (messages.length > 0) {
      return messages[0]!;
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error("remote MCP SSE response produced no JSON-RPC message");
}

function sseEventsToJsonRpc(events: Array<{ data: string; event?: string }>): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const event of events) {
    const data = event.data.trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      messages.push(JSON.parse(data) as JsonRpcMessage);
    } catch {
      continue;
    }
  }
  return messages;
}

const remoteSseSessions = new Map<string, RemoteMcpSseSession>();

export async function clearRemoteMcpSseSessions(): Promise<void> {
  const sessions = [...remoteSseSessions.values()];
  remoteSseSessions.clear();
  await Promise.all(sessions.map((session) => session.close()));
}

async function getOrCreateSseSession(bootstrap: McpClientBootstrap): Promise<RemoteMcpSseSession> {
  if (bootstrap.transport.type !== "sse") {
    throw new Error(`MCP bootstrap transport for ${bootstrap.serverName} is not sse`);
  }
  const headers = await remoteHeadersForBootstrap(bootstrap);
  const key = sseSessionKey(bootstrap.serverName, bootstrap.transport.url, headers);
  const existing = remoteSseSessions.get(key);
  if (existing) {
    return existing;
  }
  const session = new RemoteMcpSseSession(bootstrap.transport.url, headers, () => {
    const current = remoteSseSessions.get(key);
    if (current === session) {
      remoteSseSessions.delete(key);
    }
  });
  remoteSseSessions.set(key, session);
  return session;
}

class RemoteMcpSseSession {
  private readonly parser = new IncrementalSseParser();
  private readonly buffered = new Map<string, JsonRpcMessage[]>();
  private readonly pending = new Map<string, Array<(message: JsonRpcMessage) => void>>();
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private readonly openPromise: Promise<void>;
  private closed = false;
  private closeError = new Error("remote MCP SSE session closed");
  private cleanupDone = false;
  private readonly closedSignal: Promise<Error>;
  private resolveClosedSignal!: (error: Error) => void;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly onClosed: () => void
  ) {
    this.closedSignal = new Promise<Error>((resolve) => {
      this.resolveClosedSignal = resolve;
    });
    this.openPromise = this.open();
  }

  async request(message: JsonRpcMessage): Promise<JsonRpcMessage> {
    const id = normalizeJsonRpcId(message.id);
    if (!id) {
      throw new Error("remote MCP SSE requests require a JSON-RPC id");
    }

    await this.openPromise;
    if (this.closed) {
      throw this.closeError;
    }
    const pending = new Promise<JsonRpcMessage>((resolve) => {
      const entries = this.pending.get(id) ?? [];
      entries.push(resolve);
      this.pending.set(id, entries);
    });

    const response = await postRemoteJsonRpc(
      this.url,
      this.headers,
      message,
      "text/event-stream, application/json"
    );
    if (!response.ok) {
      this.deletePending(id);
      throw new Error(`remote MCP request failed with status ${response.status}`);
    }

    const direct = await tryDecodeDirectRemoteMessage(response);
    if (direct) {
      this.dispatch(direct);
    }

    const buffered = this.shiftBuffered(id);
    if (buffered) {
      this.deletePending(id);
      return buffered;
    }
    return await Promise.race([
      pending,
      this.closedSignal.then((error) => Promise.reject(error))
    ]);
  }

  async close(): Promise<void> {
    this.markClosed(new Error("remote MCP SSE session closed"));
    try {
      await this.reader?.cancel();
    } catch {
      // Ignore teardown errors for cached SSE sessions.
    }
  }

  private async open(): Promise<void> {
    const response = await fetch(this.url, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        ...this.headers
      }
    });
    if (!response.ok) {
      throw new Error(`remote MCP SSE session failed with status ${response.status}`);
    }
    if (!response.body) {
      throw new Error("remote MCP SSE response body is missing");
    }

    this.reader = response.body.getReader();
    void this.pump().catch(() => undefined);
  }

  private async pump(): Promise<void> {
    if (!this.reader) {
      return;
    }
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) {
          break;
        }
        const chunk = decoder.decode(value, { stream: true });
        this.dispatchMany(sseEventsToJsonRpc(this.parser.pushChunk(chunk)));
      }
      const trailing = decoder.decode();
      this.dispatchMany(sseEventsToJsonRpc([...this.parser.pushChunk(trailing), ...this.parser.finish()]));
    } finally {
      this.reader?.releaseLock();
      this.markClosed(new Error("remote MCP SSE session closed"));
    }
  }

  private dispatchMany(messages: JsonRpcMessage[]): void {
    for (const message of messages) {
      this.dispatch(message);
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    const id = normalizeJsonRpcId(message.id);
    if (!id) {
      return;
    }
    const resolvers = this.pending.get(id);
    if (resolvers && resolvers.length > 0) {
      const resolve = resolvers.shift()!;
      if (resolvers.length === 0) {
        this.pending.delete(id);
      } else {
        this.pending.set(id, resolvers);
      }
      resolve(message);
      return;
    }
    const buffered = this.buffered.get(id) ?? [];
    buffered.push(message);
    this.buffered.set(id, buffered);
  }

  private shiftBuffered(id: string): JsonRpcMessage | undefined {
    const buffered = this.buffered.get(id);
    if (!buffered || buffered.length === 0) {
      return undefined;
    }
    const message = buffered.shift();
    if (buffered.length === 0) {
      this.buffered.delete(id);
    } else {
      this.buffered.set(id, buffered);
    }
    return message;
  }

  private deletePending(id: string): void {
    this.pending.delete(id);
  }

  private markClosed(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = error;
    this.pending.clear();
    this.resolveClosedSignal(error);
    if (!this.cleanupDone) {
      this.cleanupDone = true;
      this.onClosed();
    }
  }
}

async function postRemoteJsonRpc(
  url: string,
  headers: Record<string, string>,
  message: JsonRpcMessage,
  accept: string
): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept,
        ...headers
      },
      body: JSON.stringify(message)
    });
  } catch (error) {
    throw new Error(String(error));
  }
}

async function tryDecodeDirectRemoteMessage(response: Response): Promise<JsonRpcMessage | undefined> {
  if (!response.body || response.status === 202 || response.status === 204) {
    return undefined;
  }
  try {
    return await decodeRemoteMcpResponse(response, response.headers.get("content-type")?.includes("text/event-stream") ? "sse" : "http");
  } catch {
    return undefined;
  }
}

function normalizeJsonRpcId(id: string | number | undefined): string | undefined {
  return id === undefined ? undefined : String(id);
}

function sseSessionKey(serverName: string, url: string, headers: Record<string, string>): string {
  return `${serverName}|${url}|${JSON.stringify(headers)}`;
}

async function requestOverSseSession(
  bootstrap: McpClientBootstrap,
  message: JsonRpcMessage
): Promise<JsonRpcMessage> {
  let attempt = 0;
  while (true) {
    const session = await getOrCreateSseSession(bootstrap);
    try {
      return await session.request(message);
    } catch (error) {
      const reason = String(error);
      if (!reason.includes("remote MCP SSE session closed") || attempt > 0) {
        throw error;
      }
      attempt += 1;
    }
  }
}
