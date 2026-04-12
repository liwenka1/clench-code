import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ApiError } from "../api/error.js";

export interface OAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  callbackPort?: number;
  manualRedirectUrl?: string;
  scopes: string[];
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes: string[];
}

/** Unix seconds; matches Rust `oauth_token_is_expired` when `expiresAt` is set. */
export function oauthTokenIsExpired(tokenSet: OAuthTokenSet): boolean {
  if (tokenSet.expiresAt === undefined) {
    return false;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  return tokenSet.expiresAt <= nowSec;
}

export interface PkceCodePair {
  verifier: string;
  challenge: string;
  challengeMethod: "S256";
}

export interface OAuthAuthorizationRequest {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  extraParams: Record<string, string>;
}

export interface OAuthTokenExchangeRequest {
  grantType: "authorization_code";
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string;
  state: string;
}

export interface OAuthRefreshRequest {
  grantType: "refresh_token";
  refreshToken: string;
  clientId: string;
  scopes: string[];
}

export interface OAuthCallbackParams {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

export function generatePkcePair(): PkceCodePair {
  const verifier = base64url(crypto.randomBytes(32));
  return {
    verifier,
    challenge: codeChallengeS256(verifier),
    challengeMethod: "S256"
  };
}

export function generateState(): string {
  return base64url(crypto.randomBytes(32));
}

export function codeChallengeS256(verifier: string): string {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

export function loopbackRedirectUri(port: number): string {
  return `http://localhost:${port}/callback`;
}

export function authorizationRequestFromConfig(
  config: OAuthConfig,
  redirectUri: string,
  state: string,
  pkce: PkceCodePair
): OAuthAuthorizationRequest {
  return {
    authorizeUrl: config.authorizeUrl,
    clientId: config.clientId,
    redirectUri,
    scopes: [...config.scopes],
    state,
    codeChallenge: pkce.challenge,
    codeChallengeMethod: pkce.challengeMethod,
    extraParams: {}
  };
}

export function withAuthorizationExtraParam(
  request: OAuthAuthorizationRequest,
  key: string,
  value: string
): OAuthAuthorizationRequest {
  return {
    ...request,
    extraParams: {
      ...request.extraParams,
      [key]: value
    }
  };
}

export function buildAuthorizationUrl(request: OAuthAuthorizationRequest): string {
  const search = new URLSearchParams({
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: request.scopes.join(" "),
    state: request.state,
    code_challenge: request.codeChallenge,
    code_challenge_method: request.codeChallengeMethod,
    ...request.extraParams
  });
  return `${request.authorizeUrl}?${search.toString()}`;
}

export function tokenExchangeRequestFromConfig(
  config: OAuthConfig,
  code: string,
  state: string,
  verifier: string,
  redirectUri: string
): OAuthTokenExchangeRequest {
  return {
    grantType: "authorization_code",
    code,
    redirectUri,
    clientId: config.clientId,
    codeVerifier: verifier,
    state
  };
}

export function tokenExchangeFormParams(request: OAuthTokenExchangeRequest): Record<string, string> {
  return {
    grant_type: request.grantType,
    code: request.code,
    redirect_uri: request.redirectUri,
    client_id: request.clientId,
    code_verifier: request.codeVerifier,
    state: request.state
  };
}

export function refreshRequestFromConfig(
  config: OAuthConfig,
  refreshToken: string,
  scopes?: string[]
): OAuthRefreshRequest {
  return {
    grantType: "refresh_token",
    refreshToken,
    clientId: config.clientId,
    scopes: scopes ?? [...config.scopes]
  };
}

export function refreshFormParams(request: OAuthRefreshRequest): Record<string, string> {
  return {
    grant_type: request.grantType,
    refresh_token: request.refreshToken,
    client_id: request.clientId,
    scope: request.scopes.join(" ")
  };
}

export function credentialsPath(): string {
  if (process.env.CLENCH_CONFIG_HOME) {
    return path.join(process.env.CLENCH_CONFIG_HOME, "credentials.json");
  }
  if (!process.env.HOME) {
    throw new Error("HOME is not set");
  }
  return path.join(process.env.HOME, ".clench", "credentials.json");
}

/** Merged runtime `settings.json` path (Rust `ConfigLoader` user settings). */
export function runtimeSettingsPath(): string {
  if (process.env.CLENCH_CONFIG_HOME) {
    return path.join(process.env.CLENCH_CONFIG_HOME, "settings.json");
  }
  if (!process.env.HOME) {
    throw new Error("HOME is not set");
  }
  return path.join(process.env.HOME, ".clench", "settings.json");
}

/**
 * Loads top-level `oauth` from runtime settings (Anthropic OAuth client metadata).
 * Mirrors Rust `parse_optional_oauth_config` on merged settings.
 */
export function loadOauthConfig(): OAuthConfig | undefined {
  const filePath = runtimeSettingsPath();
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const oauth = (parsed as Record<string, unknown>).oauth;
  if (typeof oauth !== "object" || oauth === null) {
    return undefined;
  }
  const o = oauth as Record<string, unknown>;
  const clientId = o.clientId;
  const authorizeUrl = o.authorizeUrl;
  const tokenUrl = o.tokenUrl;
  if (typeof clientId !== "string" || typeof authorizeUrl !== "string" || typeof tokenUrl !== "string") {
    return undefined;
  }
  const scopes = Array.isArray(o.scopes)
    ? o.scopes.filter((s): s is string => typeof s === "string")
    : [];
  const callbackPort =
    typeof o.callbackPort === "number" && Number.isInteger(o.callbackPort)
      ? o.callbackPort
      : undefined;
  const manualRedirectUrl =
    typeof o.manualRedirectUrl === "string" ? o.manualRedirectUrl : undefined;
  return {
    clientId,
    authorizeUrl,
    tokenUrl,
    callbackPort,
    manualRedirectUrl,
    scopes
  };
}

function normalizeOAuthTokenResponse(raw: unknown): OAuthTokenSet {
  if (typeof raw !== "object" || raw === null) {
    throw new ApiError("oauth token response: expected JSON object", { code: "json_error" });
  }
  const o = raw as Record<string, unknown>;
  const accessToken =
    typeof o.access_token === "string"
      ? o.access_token
      : typeof o.accessToken === "string"
        ? o.accessToken
        : undefined;
  if (!accessToken) {
    throw new ApiError("oauth token response: missing access_token", { code: "json_error" });
  }
  const refreshToken =
    typeof o.refresh_token === "string"
      ? o.refresh_token
      : typeof o.refreshToken === "string"
        ? o.refreshToken
        : undefined;
  let expiresAt: number | undefined;
  if (typeof o.expires_at === "number") {
    expiresAt = o.expires_at;
  } else if (typeof o.expiresAt === "number") {
    expiresAt = o.expiresAt;
  } else if (typeof o.expires_in === "number" && Number.isFinite(o.expires_in)) {
    expiresAt = Math.floor(Date.now() / 1000) + Math.floor(o.expires_in);
  }
  let scopes: string[] = [];
  if (typeof o.scope === "string" && o.scope.trim().length > 0) {
    scopes = o.scope.split(/\s+/);
  } else if (Array.isArray(o.scopes)) {
    scopes = o.scopes.filter((s): s is string => typeof s === "string");
  }
  return {
    accessToken,
    refreshToken,
    expiresAt,
    scopes
  };
}

/**
 * POST `refresh_token` grant to `config.tokenUrl` (Rust `AnthropicClient::refresh_oauth_token`).
 */
export async function refreshOAuthTokenSet(
  config: OAuthConfig,
  tokenSet: OAuthTokenSet
): Promise<OAuthTokenSet> {
  if (!tokenSet.refreshToken) {
    throw new ApiError("OAuth refresh requires refresh_token", { code: "http_error" });
  }
  const request = refreshRequestFromConfig(config, tokenSet.refreshToken, tokenSet.scopes);
  const body = new URLSearchParams(refreshFormParams(request)).toString();
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
  } catch (error) {
    throw ApiError.fromHttpError(error);
  }
  if (!response.ok) {
    const text = await response.text();
    throw ApiError.apiResponse({
      status: response.status,
      body: text,
      retryable: false
    });
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    throw ApiError.fromJsonError(error);
  }
  return normalizeOAuthTokenResponse(raw);
}

export async function exchangeOAuthCode(
  config: OAuthConfig,
  request: OAuthTokenExchangeRequest
): Promise<OAuthTokenSet> {
  const body = new URLSearchParams(tokenExchangeFormParams(request)).toString();
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
  } catch (error) {
    throw ApiError.fromHttpError(error);
  }
  if (!response.ok) {
    const text = await response.text();
    throw ApiError.apiResponse({
      status: response.status,
      body: text,
      retryable: false
    });
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    throw ApiError.fromJsonError(error);
  }
  return normalizeOAuthTokenResponse(raw);
}

/**
 * If `tokenSet` is expired, refreshes via `config`, persists with `saveOauthCredentials`,
 * and returns the resolved set (Rust `resolve_saved_oauth_token_set`).
 */
export async function resolveSavedOAuthTokenSet(
  config: OAuthConfig,
  tokenSet: OAuthTokenSet
): Promise<OAuthTokenSet> {
  if (!oauthTokenIsExpired(tokenSet)) {
    return tokenSet;
  }
  if (!tokenSet.refreshToken) {
    throw new ApiError("saved OAuth token is expired", { code: "http_error" });
  }
  const refreshed = await refreshOAuthTokenSet(config, tokenSet);
  const resolved: OAuthTokenSet = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? tokenSet.refreshToken,
    expiresAt: refreshed.expiresAt,
    scopes: refreshed.scopes.length > 0 ? refreshed.scopes : tokenSet.scopes
  };
  saveOauthCredentials(resolved);
  return resolved;
}

export function loadOauthCredentials(): OAuthTokenSet | undefined {
  const filePath = credentialsPath();
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { oauth?: OAuthTokenSet };
  return parsed.oauth;
}

export function saveOauthCredentials(tokenSet: OAuthTokenSet): void {
  const filePath = credentialsPath();
  const root = readCredentialsRoot(filePath);
  root.oauth = tokenSet;
  writeCredentialsRoot(filePath, root);
}

export function clearOauthCredentials(): void {
  const filePath = credentialsPath();
  const root = readCredentialsRoot(filePath);
  delete root.oauth;
  writeCredentialsRoot(filePath, root);
}

export function parseOauthCallbackQuery(query: string): OAuthCallbackParams {
  const search = new URLSearchParams(query);
  return {
    code: search.get("code") ?? undefined,
    state: search.get("state") ?? undefined,
    error: search.get("error") ?? undefined,
    errorDescription: search.get("error_description") ?? undefined
  };
}

export function parseOauthCallbackRequestTarget(target: string): OAuthCallbackParams {
  const [callbackPath, query = ""] = target.split("?");
  if (callbackPath !== "/callback") {
    throw new Error(`unexpected callback path: ${callbackPath}`);
  }
  return parseOauthCallbackQuery(query);
}

function readCredentialsRoot(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  return typeof parsed === "object" && parsed !== null ? parsed : {};
}

function writeCredentialsRoot(filePath: string, root: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
}

function base64url(input: crypto.BinaryLike): string {
  return Buffer.from(input as never).toString("base64url");
}
