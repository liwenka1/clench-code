import {
  McpOAuthConfig,
  McpServerConfig,
  ScopedMcpServerConfig,
  mcpServerSignature,
  mcpToolPrefix,
  normalizeNameForMcp
} from "./mcp.js";

export const DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS = 60_000;

export type McpClientTransport =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; toolCallTimeoutMs?: number }
  | { type: "sse" | "http" | "websocket"; url: string; headers: Record<string, string>; headersHelper?: string; auth: McpClientAuth }
  | { type: "sdk"; name: string }
  | { type: "managed_proxy"; url: string; id: string };

export type McpClientAuth = { type: "none" } | { type: "oauth"; oauth: McpOAuthConfig };

export interface McpClientBootstrap {
  serverName: string;
  normalizedName: string;
  toolPrefix: string;
  signature?: string;
  transport: McpClientTransport;
}

export function mcpClientBootstrapFromScopedConfig(
  serverName: string,
  scoped: ScopedMcpServerConfig
): McpClientBootstrap {
  return {
    serverName,
    normalizedName: normalizeNameForMcp(serverName),
    toolPrefix: mcpToolPrefix(serverName),
    signature: mcpServerSignature(scoped.config),
    transport: mcpClientTransportFromConfig(scoped.config)
  };
}

export function mcpClientTransportFromConfig(config: McpServerConfig): McpClientTransport {
  switch (config.type) {
    case "stdio":
      return {
        type: "stdio",
        command: config.command,
        args: [...config.args],
        env: { ...config.env },
        toolCallTimeoutMs: config.toolCallTimeoutMs
      };
    case "sse":
    case "http":
      return {
        type: config.type,
        url: config.url,
        headers: { ...config.headers },
        headersHelper: config.headersHelper,
        auth: mcpClientAuthFromOauth(config.oauth)
      };
    case "ws":
      return {
        type: "websocket",
        url: config.url,
        headers: { ...config.headers },
        headersHelper: config.headersHelper,
        auth: { type: "none" }
      };
    case "sdk":
      return { type: "sdk", name: config.name };
    case "managed_proxy":
      return { type: "managed_proxy", url: config.url, id: config.id };
  }
}

export function resolvedMcpToolCallTimeoutMs(
  transport: Extract<McpClientTransport, { type: "stdio" }>
): number {
  return transport.toolCallTimeoutMs ?? DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS;
}

export function mcpClientAuthFromOauth(oauth?: McpOAuthConfig): McpClientAuth {
  return oauth ? { type: "oauth", oauth } : { type: "none" };
}

export function mcpClientAuthRequiresUserAuth(auth: McpClientAuth): boolean {
  return auth.type === "oauth";
}
