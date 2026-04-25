import { AnthropicClient, readAnthropicBaseUrl, type AuthSource } from "./client";
import { ApiError } from "./error";
import {
  OpenAiCompatClient,
  OpenAiCompatConfig,
  hasOpenAiCompatApiKey,
  readBaseUrl as readOpenAiCompatProviderBaseUrl
} from "./openai-compat";
import {
  loadOauthConfig,
  loadOauthCredentials,
  oauthTokenIsExpired,
  resolveSavedOAuthTokenSet
} from "../runtime/oauth.js";
import type { ModelProviderConfig, RuntimeConfig } from "../runtime/config.js";
import { PromptCache, type PromptCacheRecord, type PromptCacheStats } from "./prompt-cache";
import type { MessageRequest, MessageResponse, StreamEvent, Usage } from "./types";

export { DEFAULT_XAI_BASE_URL } from "./openai-compat";

export type ProviderKind = "anthropic" | "xai" | "openai";

export const DEFAULT_MODEL = "claude-opus-4-6";

const EXPLICIT_PROVIDER_PREFIXES: Record<string, { provider: ProviderKind; providerId: string }> = {
  anthropic: { provider: "anthropic", providerId: "anthropic" },
  claude: { provider: "anthropic", providerId: "anthropic" },
  openai: { provider: "openai", providerId: "openai" },
  "openai-compatible": { provider: "openai", providerId: "openai" },
  xai: { provider: "xai", providerId: "xai" }
};

export interface ResolvedModelSelection {
  providerId?: string;
  provider?: ProviderKind;
  configuredModel: string;
  apiModel: string;
}

export interface ResolvedProviderConnection {
  providerId: string;
  provider: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
}

function configuredProviderForToken(
  token: string,
  runtimeConfig?: RuntimeConfig
): { provider: ProviderKind; providerId: string; config?: ModelProviderConfig } | undefined {
  const explicit = EXPLICIT_PROVIDER_PREFIXES[token.toLowerCase()];
  if (explicit) {
    const override = runtimeConfig?.providers?.[explicit.providerId];
    return {
      provider: (override?.kind ?? explicit.provider) as ProviderKind,
      providerId: explicit.providerId,
      config: override
    };
  }

  const configured = runtimeConfig?.providers?.[token];
  if (!configured) {
    return undefined;
  }

  return {
    provider: configured.kind,
    providerId: token,
    config: configured
  };
}

function splitExplicitProvider(
  model: string,
  runtimeConfig?: RuntimeConfig
): { providerId?: string; provider?: ProviderKind; modelPart: string } {
  const trimmed = model.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0) {
    return { modelPart: trimmed };
  }

  const providerToken = trimmed.slice(0, separator).trim().toLowerCase();
  const configuredProvider = configuredProviderForToken(providerToken, runtimeConfig);
  if (!configuredProvider) {
    return { modelPart: trimmed };
  }

  return {
    providerId: configuredProvider.providerId,
    provider: configuredProvider.provider,
    modelPart: trimmed.slice(separator + 1).trim()
  };
}

export function resolveModelSelection(
  model: string,
  runtimeConfig?: RuntimeConfig
): ResolvedModelSelection {
  const trimmed = model.trim();
  if (!trimmed) {
    return {
      configuredModel: "",
      apiModel: ""
    };
  }

  const { providerId, provider, modelPart } = splitExplicitProvider(trimmed, runtimeConfig);
  const target = provider ? modelPart : trimmed;
  if (!target) {
    return {
      providerId,
      provider,
      configuredModel: trimmed,
      apiModel: ""
    };
  }

  const apiModel = resolveModelAlias(target);
  return {
    providerId,
    provider,
    configuredModel: providerId ? `${providerId}/${apiModel}` : apiModel,
    apiModel
  };
}

export function normalizeModelSelection(model: string, runtimeConfig?: RuntimeConfig): string {
  return resolveModelSelection(model, runtimeConfig).configuredModel;
}

export function apiModelIdForSelection(model: string, runtimeConfig?: RuntimeConfig): string {
  return resolveModelSelection(model, runtimeConfig).apiModel;
}

export function resolveProviderConnection(
  model: string,
  runtimeConfig?: RuntimeConfig
): ResolvedProviderConnection | undefined {
  const selection = resolveModelSelection(model, runtimeConfig);
  if (!selection.provider) {
    return undefined;
  }

  const config = selection.providerId
    ? runtimeConfig?.providers?.[selection.providerId]
    : undefined;

  return {
    providerId: selection.providerId ?? selection.provider,
    provider: selection.provider,
    baseUrl: config?.baseUrl,
    apiKey: config?.apiKey
  };
}

export function resolveModelAlias(model: string): string {
  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "opus") {
    return "claude-opus-4-6";
  }
  if (lower === "sonnet") {
    return "claude-sonnet-4-6";
  }
  if (lower === "haiku") {
    return "claude-haiku-4-5-20251213";
  }
  if (lower === "grok" || lower === "grok-3") {
    return "grok-3";
  }
  if (lower === "grok-mini" || lower === "grok-3-mini") {
    return "grok-3-mini";
  }
  if (lower === "grok-2") {
    return "grok-2";
  }

  return trimmed;
}

function hasAnthropicAuthFromEnv(): boolean {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  return (
    (typeof apiKey === "string" && apiKey.trim().length > 0) ||
    (typeof authToken === "string" && authToken.trim().length > 0)
  );
}

/** Aligns with Rust `has_auth_from_env_or_saved`: env vars or a credentials file with `oauth`. */
function hasAnthropicAuthFromEnvOrSaved(): boolean {
  if (hasAnthropicAuthFromEnv()) {
    return true;
  }
  return loadOauthCredentials() !== undefined;
}

/**
 * Mirrors `upstream` `providers::detect_provider_kind`: model family first, then
 * Anthropic env → OpenAI env → xAI env → default Anthropic.
 */
export function detectProviderKind(model: string, runtimeConfig?: RuntimeConfig): ProviderKind {
  const selection = resolveModelSelection(model, runtimeConfig);
  if (selection.provider) {
    return selection.provider;
  }

  const resolved = selection.apiModel;
  if (resolved.startsWith("grok")) {
    return "xai";
  }
  if (resolved.startsWith("claude")) {
    return "anthropic";
  }
  if (hasAnthropicAuthFromEnvOrSaved()) {
    return "anthropic";
  }
  if (hasOpenAiCompatApiKey("OPENAI_API_KEY")) {
    return "openai";
  }
  if (hasOpenAiCompatApiKey("XAI_API_KEY")) {
    return "xai";
  }
  return "anthropic";
}

export function maxTokensForModel(model: string, runtimeConfig?: RuntimeConfig): number {
  const resolved = apiModelIdForSelection(model, runtimeConfig);
  return resolved.includes("opus") ? 32_000 : 64_000;
}

export function readXaiBaseUrl(): string {
  return readOpenAiCompatProviderBaseUrl(OpenAiCompatConfig.xai());
}

/** Matches Rust `read_xai_base_url` / `client::read_xai_base_url` naming for OpenAI default host. */
export function readOpenAiBaseUrl(): string {
  return readOpenAiCompatProviderBaseUrl(OpenAiCompatConfig.openai());
}

/**
 * Same order as Rust `AuthSource::from_env_or_saved`: API key (+ optional bearer token),
 * then bearer-only env, then saved OAuth bearer. Expired saved tokens with a refresh token
 * throw (use `resolveAnthropicAuthFromEnvOrSavedAsync` for refresh).
 */
export function resolveAnthropicAuthFromEnvOrSaved(): AuthSource {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (apiKey) {
    if (authToken) {
      return { type: "api_key_and_bearer", apiKey, bearerToken: authToken };
    }
    return { type: "api_key", apiKey };
  }
  if (authToken) {
    return { type: "bearer", bearerToken: authToken };
  }

  const saved = loadOauthCredentials();
  if (!saved) {
    throw ApiError.missingCredentials("Anthropic", ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  }
  if (oauthTokenIsExpired(saved)) {
    if (saved.refreshToken) {
      throw new ApiError(
        "saved OAuth token is expired; load runtime OAuth config to refresh it",
        { code: "http_error" }
      );
    }
    throw new ApiError("saved OAuth token is expired", { code: "http_error" });
  }
  return { type: "bearer", bearerToken: saved.accessToken };
}

/** Rust `resolve_startup_auth_source`: env first, then saved OAuth with optional refresh. */
export async function resolveAnthropicAuthFromEnvOrSavedAsync(): Promise<AuthSource> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (apiKey) {
    if (authToken) {
      return { type: "api_key_and_bearer", apiKey, bearerToken: authToken };
    }
    return { type: "api_key", apiKey };
  }
  if (authToken) {
    return { type: "bearer", bearerToken: authToken };
  }

  const saved = loadOauthCredentials();
  if (!saved) {
    throw ApiError.missingCredentials("Anthropic", ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  }
  if (!oauthTokenIsExpired(saved)) {
    return { type: "bearer", bearerToken: saved.accessToken };
  }
  if (!saved.refreshToken) {
    throw new ApiError("saved OAuth token is expired", { code: "http_error" });
  }
  const config = loadOauthConfig();
  if (!config) {
    throw new ApiError(
      "saved OAuth token is expired; runtime OAuth config is missing",
      { code: "http_error" }
    );
  }
  const resolved = await resolveSavedOAuthTokenSet(config, saved);
  return { type: "bearer", bearerToken: resolved.accessToken };
}

/**
 * Optional wiring when constructing a provider (Rust CLI passes `PromptCache::new(session_id)` via
 * `with_prompt_cache` after `from_model`).
 */
export interface ProviderClientConnectOptions {
  /** Enables Anthropic completion cache for this session id (`PromptCache::new` in Rust). No-op for OpenAI / xAI. */
  promptCacheSessionId?: string;
  runtimeConfig?: RuntimeConfig;
}

export class ProviderClient {
  private constructor(
    private readonly provider: ProviderKind,
    private readonly inner: AnthropicClient | OpenAiCompatClient
  ) {}

  static async fromModel(
    model: string,
    options?: ProviderClientConnectOptions
  ): Promise<ProviderClient> {
    return ProviderClient.fromModelWithAnthropicAuth(model, undefined, options);
  }

  static async fromModelWithAnthropicAuth(
    model: string,
    anthropicAuth?: AuthSource,
    options?: ProviderClientConnectOptions
  ): Promise<ProviderClient> {
    const connection = resolveProviderConnection(model, options?.runtimeConfig);
    const kind = connection?.provider ?? detectProviderKind(model, options?.runtimeConfig);

    let client: ProviderClient;
    if (kind === "xai") {
      client = new ProviderClient(
        "xai",
        OpenAiCompatClient.fromResolved(OpenAiCompatConfig.xai(), {
          apiKey: connection?.apiKey,
          baseUrl: connection?.baseUrl
        })
      );
    } else if (kind === "openai") {
      client = new ProviderClient(
        "openai",
        OpenAiCompatClient.fromResolved(OpenAiCompatConfig.openai(), {
          apiKey: connection?.apiKey,
          baseUrl: connection?.baseUrl
        })
      );
    } else if (anthropicAuth) {
      client = new ProviderClient(
        "anthropic",
        AnthropicClient.fromAuth(anthropicAuth).withBaseUrl(connection?.baseUrl ?? readAnthropicBaseUrl())
      );
    } else if (connection?.apiKey) {
      client = new ProviderClient(
        "anthropic",
        AnthropicClient.fromAuth({ type: "api_key", apiKey: connection.apiKey }).withBaseUrl(
          connection.baseUrl ?? readAnthropicBaseUrl()
        )
      );
    } else {
      client = new ProviderClient(
        "anthropic",
        AnthropicClient.fromAuth(await resolveAnthropicAuthFromEnvOrSavedAsync()).withBaseUrl(
          connection?.baseUrl ?? readAnthropicBaseUrl()
        )
      );
    }

    if (options?.promptCacheSessionId && client.providerKind() === "anthropic") {
      return client.withPromptCache(new PromptCache(options.promptCacheSessionId));
    }
    return client;
  }

  providerKind(): ProviderKind {
    return this.provider;
  }

  anthropicClient(): AnthropicClient | undefined {
    return this.inner instanceof AnthropicClient ? this.inner : undefined;
  }

  xaiClient(): OpenAiCompatClient | undefined {
    return this.provider === "xai" ? (this.inner as OpenAiCompatClient) : undefined;
  }

  openaiClient(): OpenAiCompatClient | undefined {
    return this.provider === "openai" ? (this.inner as OpenAiCompatClient) : undefined;
  }

  /** Rust `ProviderClient::with_prompt_cache` — no-op for OpenAI / xAI. */
  withPromptCache(promptCache: PromptCache): ProviderClient {
    if (this.inner instanceof AnthropicClient) {
      return new ProviderClient("anthropic", this.inner.withPromptCache(promptCache));
    }
    return this;
  }

  /** Rust `ProviderClient::prompt_cache_stats`. */
  promptCacheStats(): PromptCacheStats | undefined {
    return this.inner instanceof AnthropicClient ? this.inner.promptCacheStats() : undefined;
  }

  /** Rust `ProviderClient::take_last_prompt_cache_record`. */
  takeLastPromptCacheRecord(): PromptCacheRecord | undefined {
    return this.inner instanceof AnthropicClient
      ? this.inner.takeLastPromptCacheRecord()
      : undefined;
  }

  recordPromptCacheStreamUsage(request: MessageRequest, usage: Usage): void {
    if (this.inner instanceof AnthropicClient) {
      this.inner.recordPromptCacheStreamUsage(request, usage);
    }
  }

  async sendMessage(request: MessageRequest): Promise<MessageResponse> {
    if (this.inner instanceof AnthropicClient) {
      return this.inner.sendMessage(request);
    }
    return this.inner.sendMessage(request);
  }

  async streamMessage(
    request: MessageRequest
  ): Promise<{ requestId(): string | undefined; nextEvent(): Promise<StreamEvent | undefined> }> {
    return this.inner.streamMessage(request);
  }
}
