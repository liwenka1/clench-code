import path from "node:path";

import {
  DEFAULT_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_XAI_BASE_URL,
  detectProviderKind,
  readAnthropicBaseUrl,
  readOpenAiBaseUrl,
  readXaiBaseUrl
} from "../api/index.js";
import {
  DEFAULT_MODEL,
  normalizeModelSelection,
  resolveModelSelection,
  resolveProviderConnection
} from "../api/providers";
import { loadRuntimeConfig, type ModelProviderKind, type RuntimeConfig } from "../runtime/index.js";
import { readLocalConfig, writeLocalConfig } from "./local-config";
import { renderConfigView, renderModelListView, renderModelView } from "./views";

export interface ModelCliState {
  cwd: string;
  model: string;
}

export interface InteractivePrompter {
  question(prompt: string): Promise<string>;
  close(): void;
}

interface ModelProviderAnswers {
  providerId: string;
  kind: ModelProviderKind;
  baseUrl?: string;
  apiKey?: string;
  modelId: string;
  setCurrentModel: boolean;
}

const BUILTIN_BARE_MODEL_SELECTIONS = new Set([
  "opus",
  "sonnet",
  "haiku",
  "grok",
  "grok-2",
  "grok-3",
  "grok-mini",
  "grok-3-mini"
]);

const LOCAL_OPENAI_COMPAT_PROVIDER_IDS = new Set(["local", "ollama", "lmstudio", "vllm", "llamacpp"]);
const OPENAI_COMPAT_PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = {
  openai: DEFAULT_OPENAI_BASE_URL,
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com/v1"
};

export function applyModelSlash(cli: ModelCliState, nextModel: string | undefined): void {
  if (!nextModel) {
    process.stdout.write(renderModelView({ current: cli.model }));
    return;
  }
  const previous = cli.model;
  const merged = loadRuntimeConfig(cli.cwd).merged;
  assertKnownModelSelection(nextModel, merged);
  const selection = resolveModelSelection(nextModel, merged);
  cli.model = selection.configuredModel;
  const localPath = path.join(cli.cwd, ".clench", "settings.local.json");
  const existing = readLocalConfig(localPath);
  const providerDefaults = selection.providerId && selection.apiModel && existing.providers?.[selection.providerId]
    ? {
        ...(existing.providers ?? {}),
        [selection.providerId]: {
          ...existing.providers[selection.providerId],
          defaultModel: selection.apiModel
        }
      }
    : existing.providers;
  writeLocalConfig(localPath, {
    ...existing,
    ...(providerDefaults ? { providers: providerDefaults } : {}),
    model: cli.model
  });
  process.stdout.write(renderModelView({ current: cli.model, previous }));
}

export function applyModelListSlash(cli: ModelCliState): void {
  const merged = loadRuntimeConfig(cli.cwd).merged;
  const currentSelection = resolveModelSelection(cli.model, merged);
  const currentConnection = resolveProviderConnection(cli.model, merged);
  const defaultModel = normalizeModelSelection(merged.model ?? DEFAULT_MODEL, merged);
  const defaultSelection = resolveModelSelection(defaultModel, merged);

  const providers = Object.entries(merged.providers ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([providerId, provider]) => ({
      id: providerId,
      kind: provider.kind,
      baseUrl: effectiveProviderBaseUrl(provider.kind, provider.baseUrl),
      defaultModel: provider.defaultModel ?? (defaultSelection.providerId === providerId ? defaultSelection.apiModel : undefined),
      current: currentSelection.providerId === providerId
    }));

  process.stdout.write(
    renderModelListView({
      current: cli.model,
      defaultModel,
      currentProvider: currentSelection.providerId ?? detectProviderKind(cli.model, merged),
      currentBaseUrl: currentConnection
        ? effectiveProviderBaseUrl(currentConnection.provider, currentConnection.baseUrl)
        : undefined,
      providers
    })
  );
}

export async function applyModelAddSlash(
  cli: ModelCliState,
  providerIdHint: string | undefined,
  prompter?: InteractivePrompter
): Promise<void> {
  const localPath = path.join(cli.cwd, ".clench", "settings.local.json");
  const existing = readLocalConfig(localPath);
  const answers = prompter
    ? await promptForModelProviderConfig(existing, providerIdHint, prompter)
    : await promptForModelProviderConfig(existing, providerIdHint);
  const providers = {
    ...(existing.providers ?? {}),
    [answers.providerId]: {
      kind: answers.kind,
      ...(answers.baseUrl ? { baseUrl: answers.baseUrl } : {}),
      ...(answers.apiKey ? { apiKey: answers.apiKey } : {}),
      defaultModel: answers.modelId
    }
  };
  const defaultModel = resolveModelSelection(`${answers.providerId}/${answers.modelId}`, { ...existing, providers }).apiModel;
  providers[answers.providerId] = {
    ...providers[answers.providerId],
    defaultModel
  };
  const nextConfig: RuntimeConfig = {
    ...existing,
    providers,
    ...(answers.setCurrentModel
      ? { model: normalizeModelSelection(`${answers.providerId}/${defaultModel}`, { ...existing, providers }) }
      : {})
  };
  writeLocalConfig(localPath, nextConfig);
  if (answers.setCurrentModel && nextConfig.model) {
    cli.model = nextConfig.model;
  }
  process.stdout.write(renderConfigView([localPath], "providers", providers));
  process.stdout.write(renderModelView({ current: cli.model }));
}

function buildModelSelectionGuidance(
  summary: string,
  actions: string[],
  runtimeConfig?: RuntimeConfig,
  showConfiguredProviders = false
): string {
  const lines = [summary];
  if (showConfiguredProviders) {
    const providerIds = Object.keys(runtimeConfig?.providers ?? {}).sort();
    if (providerIds.length > 0) {
      lines.push(`Configured providers: ${providerIds.join(", ")}`);
    }
  }
  lines.push("Try:");
  lines.push(...actions.map((action) => `  ${action}`));
  return lines.join("\n");
}

function assertKnownModelSelection(selection: string, runtimeConfig: RuntimeConfig): void {
  const trimmed = selection.trim();
  if (!trimmed) {
    throw new Error("model selection is required");
  }

  const resolved = resolveModelSelection(trimmed, runtimeConfig);
  if (resolved.providerId) {
    return;
  }

  const configuredProvider = runtimeConfig.providers?.[trimmed];
  if (configuredProvider) {
    throw new Error(
      buildModelSelectionGuidance(
        `provider '${trimmed}' is configured, but it has no default model yet.`,
        [
          `/model ${trimmed}/<model-id> to switch with an explicit model`,
          `/model add ${trimmed} to set its default model`,
          "/model list to inspect configured providers"
        ]
      )
    );
  }

  const lower = trimmed.toLowerCase();
  if (BUILTIN_BARE_MODEL_SELECTIONS.has(lower) || lower.startsWith("claude") || lower.startsWith("grok")) {
    return;
  }

  if (trimmed.includes("/")) {
    const providerToken = trimmed.slice(0, trimmed.indexOf("/")).trim() || trimmed;
    throw new Error(
      buildModelSelectionGuidance(
        `unknown provider '${providerToken}'.`,
        [
          `/model add ${providerToken} to configure it`,
          "/model <provider-id>/<model-id> to select an explicit model",
          "/model list to inspect configured providers"
        ],
        runtimeConfig,
        true
      )
    );
  }

  throw new Error(
    buildModelSelectionGuidance(
      `unknown model selection '${trimmed}'.`,
      [
        "/model sonnet to use a built-in alias",
        "/model <provider-id> to use a provider default model",
        "/model <provider-id>/<model-id> to select an explicit model",
        "/model list to inspect configured providers"
      ],
      runtimeConfig,
      true
    )
  );
}

function effectiveProviderBaseUrl(kind: ModelProviderKind, configuredBaseUrl?: string): string {
  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }
  if (kind === "anthropic") {
    return readAnthropicBaseUrl();
  }
  if (kind === "xai") {
    return readXaiBaseUrl();
  }
  return readOpenAiBaseUrl();
}

function defaultKindForProvider(providerId: string): ModelProviderKind {
  if (providerId === "anthropic") {
    return "anthropic";
  }
  if (providerId === "xai") {
    return "xai";
  }
  return "openai";
}

function defaultBaseUrlForProvider(providerId: string, kind: ModelProviderKind): string | undefined {
  if (kind === "anthropic") {
    return providerId === "anthropic" ? DEFAULT_BASE_URL : undefined;
  }
  if (kind === "xai") {
    return providerId === "xai" ? DEFAULT_XAI_BASE_URL : undefined;
  }
  if (LOCAL_OPENAI_COMPAT_PROVIDER_IDS.has(providerId)) {
    return "http://127.0.0.1:11434/v1";
  }
  return OPENAI_COMPAT_PROVIDER_DEFAULT_BASE_URLS[providerId];
}

function isLikelyLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    const url = new URL(baseUrl);
    return ["127.0.0.1", "localhost", "0.0.0.0"].includes(url.hostname);
  } catch {
    return false;
  }
}

function defaultApiKeyForProvider(providerId: string, kind: ModelProviderKind, baseUrl: string | undefined): string | undefined {
  if (kind === "openai" && (LOCAL_OPENAI_COMPAT_PROVIDER_IDS.has(providerId) || isLikelyLocalBaseUrl(baseUrl))) {
    return "dummy";
  }
  return undefined;
}

function parseYesNo(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["y", "yes"].includes(normalized)) {
    return true;
  }
  if (["n", "no"].includes(normalized)) {
    return false;
  }
  throw new Error(`expected yes or no, received '${value}'`);
}

async function promptQuestion(
  prompter: InteractivePrompter,
  message: string,
  defaultValue?: string,
  allowEmpty = false
): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await prompter.question(`${message}${suffix}: `)).trim();
  if (!answer) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    if (allowEmpty) {
      return "";
    }
    throw new Error(`${message} is required`);
  }
  return answer;
}

function createInteractivePrompter(): InteractivePrompter {
  const queuedLines: string[] = [];
  const pendingResolvers: Array<(line: string) => void> = [];
  let buffer = "";

  const flushBufferedLines = () => {
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      const resolve = pendingResolvers.shift();
      if (resolve) {
        resolve(line);
      } else {
        queuedLines.push(line);
      }
    }
  };

  const onData = (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    flushBufferedLines();
  };

  process.stdin.on("data", onData);
  process.stdin.resume();

  return {
    async question(prompt: string) {
      process.stdout.write(prompt);
      if (queuedLines.length > 0) {
        return queuedLines.shift() ?? "";
      }
      return await new Promise((resolve) => {
        pendingResolvers.push(resolve);
      });
    },
    close() {
      process.stdin.off("data", onData);
      process.stdin.pause();
      if (buffer.length > 0) {
        let line = buffer;
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }
        const resolve = pendingResolvers.shift();
        if (resolve) {
          resolve(line);
        }
        buffer = "";
      }
      while (pendingResolvers.length > 0) {
        pendingResolvers.shift()!("");
      }
    }
  };
}

async function promptForModelProviderConfig(
  existing: RuntimeConfig,
  providerIdHint?: string,
  prompter?: InteractivePrompter
): Promise<ModelProviderAnswers> {
  const activePrompter = prompter ?? createInteractivePrompter();
  const ownsPrompter = prompter === undefined;
  try {
    const providerId = await promptQuestion(activePrompter, "Provider ID", providerIdHint?.trim() || "local");
    if (!/^[a-zA-Z0-9._-]+$/.test(providerId)) {
      throw new Error("provider id must contain only letters, numbers, dot, underscore, or dash");
    }

    const existingProvider = existing.providers?.[providerId];
    const kind = (await promptQuestion(
      activePrompter,
      "Provider kind (openai/anthropic/xai)",
      existingProvider?.kind ?? defaultKindForProvider(providerId)
    )) as ModelProviderKind;
    if (!["openai", "anthropic", "xai"].includes(kind)) {
      throw new Error(`unsupported provider kind '${kind}'`);
    }

    const baseUrl = await promptQuestion(
      activePrompter,
      "Base URL",
      existingProvider?.baseUrl ?? defaultBaseUrlForProvider(providerId, kind),
      true
    );
    const apiKey = await promptQuestion(
      activePrompter,
      "API key",
      existingProvider?.apiKey ?? defaultApiKeyForProvider(providerId, kind, baseUrl),
      true
    );
    const modelId = await promptQuestion(activePrompter, "Default model ID", existingProvider?.defaultModel);
    const setCurrentModel = parseYesNo(
      await promptQuestion(activePrompter, "Set as current model? (y/n)", "y"),
      true
    );

    return {
      providerId,
      kind,
      baseUrl: baseUrl || undefined,
      apiKey: apiKey || undefined,
      modelId,
      setCurrentModel
    };
  } finally {
    if (ownsPrompter) {
      activePrompter.close();
    }
  }
}
