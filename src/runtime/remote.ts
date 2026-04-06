import fs from "node:fs";
import path from "node:path";

export const DEFAULT_REMOTE_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_SESSION_TOKEN_PATH = "/run/ccr/session_token";
export const DEFAULT_SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

export const UPSTREAM_PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE"
] as const;

const NO_PROXY_HOSTS_BASE = [
  "localhost",
  "127.0.0.1",
  "::1",
  "169.254.0.0/16",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "anthropic.com",
  ".anthropic.com",
  "*.anthropic.com",
  "github.com",
  "api.github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "index.crates.io"
] as const;

export interface RemoteSessionContext {
  enabled: boolean;
  sessionId?: string;
  baseUrl: string;
}

export interface UpstreamProxyBootstrap {
  remote: RemoteSessionContext;
  upstreamProxyEnabled: boolean;
  tokenPath: string;
  caBundlePath: string;
  systemCaPath: string;
  token?: string;
}

export interface UpstreamProxyState {
  enabled: boolean;
  proxyUrl?: string;
  caBundlePath?: string;
  noProxy: string;
}

export function remoteSessionContextFromEnvMap(envMap: Record<string, string>): RemoteSessionContext {
  const truthy = (v: string | undefined) =>
    v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());

  const baseUrl = envMap.ANTHROPIC_BASE_URL?.trim();
  return {
    enabled: truthy(envMap.CLAUDE_CODE_REMOTE),
    sessionId: envMap.CLAUDE_CODE_REMOTE_SESSION_ID?.trim() || undefined,
    baseUrl: baseUrl && baseUrl.length > 0 ? baseUrl : DEFAULT_REMOTE_BASE_URL
  };
}

export function readSessionToken(pathToFile: string): string | undefined {
  try {
    const contents = fs.readFileSync(pathToFile, "utf8").trim();
    return contents.length > 0 ? contents : undefined;
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw e;
  }
}

function defaultCaBundlePath(): string {
  const home = process.env.HOME ?? ".";
  return path.join(home, ".ccr", "ca-bundle.crt");
}

export function upstreamProxyBootstrapFromEnvMap(envMap: Record<string, string>): UpstreamProxyBootstrap {
  const remote = remoteSessionContextFromEnvMap(envMap);
  const tokenPath =
    envMap.CCR_SESSION_TOKEN_PATH?.trim() || DEFAULT_SESSION_TOKEN_PATH;
  const systemCaPath =
    envMap.CCR_SYSTEM_CA_BUNDLE?.trim() || DEFAULT_SYSTEM_CA_BUNDLE;
  const caBundlePath =
    envMap.CCR_CA_BUNDLE_PATH?.trim() || defaultCaBundlePath();

  const truthy = (v: string | undefined) =>
    v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());

  let token: string | undefined;
  try {
    token = readSessionToken(tokenPath);
  } catch {
    token = undefined;
  }

  return {
    remote,
    upstreamProxyEnabled: truthy(envMap.CCR_UPSTREAM_PROXY_ENABLED),
    tokenPath,
    caBundlePath,
    systemCaPath,
    token
  };
}

export function upstreamProxyShouldEnable(bootstrap: UpstreamProxyBootstrap): boolean {
  return (
    bootstrap.remote.enabled &&
    bootstrap.upstreamProxyEnabled &&
    bootstrap.remote.sessionId !== undefined &&
    bootstrap.token !== undefined
  );
}

export function upstreamProxyWsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  let wsBase: string;
  if (base.startsWith("https://")) {
    wsBase = `wss://${base.slice("https://".length)}`;
  } else if (base.startsWith("http://")) {
    wsBase = `ws://${base.slice("http://".length)}`;
  } else {
    wsBase = `wss://${base}`;
  }
  return `${wsBase}/v1/code/upstreamproxy/ws`;
}

export function noProxyList(): string {
  return [...NO_PROXY_HOSTS_BASE, "pypi.org", "files.pythonhosted.org", "proxy.golang.org"].join(",");
}

export function upstreamProxyStateForPort(bootstrap: UpstreamProxyBootstrap, port: number): UpstreamProxyState {
  if (!upstreamProxyShouldEnable(bootstrap)) {
    return upstreamProxyStateDisabled();
  }
  return {
    enabled: true,
    proxyUrl: `http://127.0.0.1:${port}`,
    caBundlePath: bootstrap.caBundlePath,
    noProxy: noProxyList()
  };
}

export function upstreamProxyStateDisabled(): UpstreamProxyState {
  return {
    enabled: false,
    proxyUrl: undefined,
    caBundlePath: undefined,
    noProxy: noProxyList()
  };
}

export function upstreamProxySubprocessEnv(state: UpstreamProxyState): Record<string, string> {
  if (!state.enabled || !state.proxyUrl || !state.caBundlePath) {
    return {};
  }
  const ca = state.caBundlePath;
  const proxy = state.proxyUrl;
  const entries: [string, string][] = [
    ["HTTPS_PROXY", proxy],
    ["https_proxy", proxy],
    ["NO_PROXY", state.noProxy],
    ["no_proxy", state.noProxy],
    ["SSL_CERT_FILE", ca],
    ["NODE_EXTRA_CA_CERTS", ca],
    ["REQUESTS_CA_BUNDLE", ca],
    ["CURL_CA_BUNDLE", ca]
  ];
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

export function inheritedUpstreamProxyEnv(envMap: Record<string, string>): Record<string, string> {
  if (!envMap.HTTPS_PROXY || !envMap.SSL_CERT_FILE) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const key of UPSTREAM_PROXY_ENV_KEYS) {
    const v = envMap[key];
    if (v !== undefined) {
      out[key] = v;
    }
  }
  return out;
}
