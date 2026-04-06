const CLAUDEAI_SERVER_PREFIX = "claude.ai ";
const CCR_PROXY_PATH_MARKERS = ["/v2/session_ingress/shttp/mcp/", "/v2/ccr-sessions/"];

export function normalizeNameForMcp(name: string): string {
  let normalized = [...name]
    .map((char) => (/^[a-zA-Z0-9_-]$/.test(char) ? char : "_"))
    .join("");

  if (name.startsWith(CLAUDEAI_SERVER_PREFIX)) {
    normalized = collapseUnderscores(normalized).replace(/^_+|_+$/g, "");
  }

  return normalized;
}

export function mcpToolPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMcp(serverName)}__`;
}

export function mcpToolName(serverName: string, toolName: string): string {
  return `${mcpToolPrefix(serverName)}${normalizeNameForMcp(toolName)}`;
}

export function unwrapCcrProxyUrl(url: string): string {
  if (!CCR_PROXY_PATH_MARKERS.some((marker) => url.includes(marker))) {
    return url;
  }

  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) {
    return url;
  }

  const search = new URLSearchParams(url.slice(queryIndex + 1));
  const mcpUrl = search.get("mcp_url");
  return mcpUrl ? decodeURIComponent(mcpUrl.replace(/\+/g, " ")) : url;
}

export type McpServerConfig =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; toolCallTimeoutMs?: number }
  | { type: "sse" | "http"; url: string; headers: Record<string, string>; headersHelper?: string; oauth?: McpOAuthConfig }
  | { type: "ws"; url: string; headers: Record<string, string>; headersHelper?: string }
  | { type: "sdk"; name: string }
  | { type: "managed_proxy"; url: string; id: string };

export interface McpOAuthConfig {
  clientId?: string;
  callbackPort?: number;
  authServerMetadataUrl?: string;
  xaa?: boolean;
}

export interface ScopedMcpServerConfig {
  scope: "user" | "project" | "local";
  config: McpServerConfig;
}

export function mcpServerSignature(config: McpServerConfig): string | undefined {
  switch (config.type) {
    case "stdio":
      return `stdio:${renderCommandSignature([config.command, ...config.args])}`;
    case "sse":
    case "http":
    case "ws":
    case "managed_proxy":
      return `url:${unwrapCcrProxyUrl(config.url)}`;
    case "sdk":
      return undefined;
  }
}

/** Renders args only (same bracket escaping as Rust `render_command_signature` on args). */
export function renderArgsOnlySignature(args: string[]): string {
  return renderCommandSignature(args);
}

export function renderEnvSignature(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${env[key]}`)
    .join(";");
}

export function renderOauthSignature(oauth?: McpOAuthConfig): string {
  if (!oauth) {
    return "";
  }
  return [
    oauth.clientId ?? "",
    oauth.callbackPort != null ? String(oauth.callbackPort) : "",
    oauth.authServerMetadataUrl ?? "",
    oauth.xaa != null ? String(oauth.xaa) : ""
  ].join("|");
}

export function renderScopedConfig(config: McpServerConfig): string {
  switch (config.type) {
    case "stdio":
      return [
        "stdio",
        config.command,
        renderArgsOnlySignature(config.args),
        renderEnvSignature(config.env),
        config.toolCallTimeoutMs != null ? String(config.toolCallTimeoutMs) : ""
      ].join("|");
    case "sse":
      return [
        "sse",
        config.url,
        renderEnvSignature(config.headers),
        config.headersHelper ?? "",
        renderOauthSignature(config.oauth)
      ].join("|");
    case "http":
      return [
        "http",
        config.url,
        renderEnvSignature(config.headers),
        config.headersHelper ?? "",
        renderOauthSignature(config.oauth)
      ].join("|");
    case "ws":
      return ["ws", config.url, renderEnvSignature(config.headers), config.headersHelper ?? ""].join("|");
    case "sdk":
      return `sdk|${config.name}`;
    case "managed_proxy":
      return `claudeai-proxy|${config.url}|${config.id}`;
  }
}

/** FNV-1a 64-bit, same as Rust `stable_hex_hash`: 16 lowercase hex chars. */
export function stableHexHash(value: string): string {
  let hash = BigInt("0xcbf29ce484222325");
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * BigInt("0x100000001b3"));
  }
  return hash.toString(16).padStart(16, "0");
}

export function scopedMcpConfigHash(scoped: ScopedMcpServerConfig): string {
  return stableHexHash(renderScopedConfig(scoped.config));
}

function renderCommandSignature(command: string[]): string {
  return `[${command.map((part) => part.replaceAll("\\", "\\\\").replaceAll("|", "\\|")).join("|")}]`;
}

function collapseUnderscores(value: string): string {
  return value.replace(/_+/g, "_");
}
