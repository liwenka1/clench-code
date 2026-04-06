import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { MessageRequest, MessageResponse, Usage } from "./types";

const DEFAULT_COMPLETION_TTL_MS = 30_000;
const DEFAULT_PROMPT_TTL_MS = 5 * 60_000;
const DEFAULT_BREAK_MIN_DROP = 2_000;
const MAX_SANITIZED_LENGTH = 80;
const REQUEST_FINGERPRINT_PREFIX = "v1";

export interface PromptCacheConfig {
  sessionId: string;
  completionTtlMs: number;
  promptTtlMs: number;
  cacheBreakMinDrop: number;
}

export interface PromptCachePaths {
  root: string;
  sessionDir: string;
  completionDir: string;
  sessionStatePath: string;
  statsPath: string;
}

export interface PromptCacheStats {
  trackedRequests: number;
  completionCacheHits: number;
  completionCacheMisses: number;
  completionCacheWrites: number;
  expectedInvalidations: number;
  unexpectedCacheBreaks: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  lastCacheCreationInputTokens?: number;
  lastCacheReadInputTokens?: number;
  lastRequestHash?: string;
  lastCompletionCacheKey?: string;
  lastBreakReason?: string;
  lastCacheSource?: string;
}

export interface CacheBreakEvent {
  unexpected: boolean;
  reason: string;
  previousCacheReadInputTokens: number;
  currentCacheReadInputTokens: number;
  tokenDrop: number;
}

export interface PromptCacheRecord {
  cacheBreak?: CacheBreakEvent;
  stats: PromptCacheStats;
}

interface CompletionCacheEntry {
  cachedAtUnixMs: number;
  fingerprintVersion: string;
  response: MessageResponse;
}

interface TrackedPromptState {
  observedAtUnixMs: number;
  fingerprintVersion: string;
  modelHash: string;
  systemHash: string;
  toolsHash: string;
  messagesHash: string;
  cacheReadInputTokens: number;
}

export class PromptCache {
  private readonly config: PromptCacheConfig;
  private readonly cachePaths: PromptCachePaths;
  private statsState: PromptCacheStats;
  private previousState?: TrackedPromptState;

  constructor(sessionId: string) {
    this.config = defaultPromptCacheConfig(sessionId);
    this.cachePaths = promptCachePathsForSession(sessionId);
    this.statsState = readJson<PromptCacheStats>(this.cachePaths.statsPath) ?? defaultPromptCacheStats();
    this.previousState = readJson<TrackedPromptState>(this.cachePaths.sessionStatePath);
  }

  static withConfig(config: Partial<PromptCacheConfig> & Pick<PromptCacheConfig, "sessionId">): PromptCache {
    return new PromptCacheBuilder(config).build();
  }

  paths(): PromptCachePaths {
    return { ...this.cachePaths };
  }

  stats(): PromptCacheStats {
    return { ...this.statsState };
  }

  lookupCompletion(request: MessageRequest): MessageResponse | undefined {
    const requestHash = requestHashHex(request);
    const entryPath = completionEntryPath(this.cachePaths, requestHash);
    const entry = readJson<CompletionCacheEntry>(entryPath);

    this.statsState.lastCompletionCacheKey = requestHash;

    if (!entry || entry.fingerprintVersion !== REQUEST_FINGERPRINT_PREFIX) {
      this.statsState.completionCacheMisses += 1;
      if (entry && entry.fingerprintVersion !== REQUEST_FINGERPRINT_PREFIX) {
        safeUnlink(entryPath);
      }
      this.persist();
      return undefined;
    }

    const expired = Date.now() - entry.cachedAtUnixMs >= this.config.completionTtlMs;
    if (expired) {
      this.statsState.completionCacheMisses += 1;
      safeUnlink(entryPath);
      this.persist();
      return undefined;
    }

    this.statsState.completionCacheHits += 1;
    applyUsageToStats(this.statsState, entry.response.usage, requestHash, "completion-cache");
    this.previousState = trackedPromptStateFromUsage(request, entry.response.usage);
    this.persist();
    return entry.response;
  }

  recordResponse(request: MessageRequest, response: MessageResponse): PromptCacheRecord {
    return this.recordUsageInternal(request, response.usage, response);
  }

  recordUsage(request: MessageRequest, usage: Usage): PromptCacheRecord {
    return this.recordUsageInternal(request, usage);
  }

  private recordUsageInternal(
    request: MessageRequest,
    usage: Usage,
    response?: MessageResponse
  ): PromptCacheRecord {
    const requestHash = requestHashHex(request);
    const current = trackedPromptStateFromUsage(request, usage);
    const cacheBreak = detectCacheBreak(this.config, this.previousState, current);

    this.statsState.trackedRequests += 1;
    applyUsageToStats(this.statsState, usage, requestHash, "api-response");

    if (cacheBreak) {
      if (cacheBreak.unexpected) {
        this.statsState.unexpectedCacheBreaks += 1;
      } else {
        this.statsState.expectedInvalidations += 1;
      }
      this.statsState.lastBreakReason = cacheBreak.reason;
    }

    this.previousState = current;
    if (response) {
      ensureCacheDirs(this.cachePaths);
      writeJson(completionEntryPath(this.cachePaths, requestHash), {
        cachedAtUnixMs: Date.now(),
        fingerprintVersion: REQUEST_FINGERPRINT_PREFIX,
        response
      } satisfies CompletionCacheEntry);
      this.statsState.completionCacheWrites += 1;
    }

    this.persist();
    return {
      cacheBreak,
      stats: this.stats()
    };
  }

  private persist(): void {
    ensureCacheDirs(this.cachePaths);
    writeJson(this.cachePaths.statsPath, this.statsState);
    if (this.previousState) {
      writeJson(this.cachePaths.sessionStatePath, this.previousState);
    }
  }
}

class PromptCacheBuilder {
  constructor(private readonly config: Partial<PromptCacheConfig> & Pick<PromptCacheConfig, "sessionId">) {}

  build(): PromptCache {
    const cache = new PromptCache(this.config.sessionId);
    const fullConfig: PromptCacheConfig = {
      ...defaultPromptCacheConfig(this.config.sessionId),
      ...this.config
    };
    Reflect.set(cache, "config", fullConfig);
    Reflect.set(cache, "cachePaths", promptCachePathsForSession(fullConfig.sessionId));
    Reflect.set(cache, "statsState", readJson<PromptCacheStats>(cache.paths().statsPath) ?? defaultPromptCacheStats());
    Reflect.set(cache, "previousState", readJson<TrackedPromptState>(cache.paths().sessionStatePath));
    return cache;
  }
}

export function defaultPromptCacheConfig(sessionId: string): PromptCacheConfig {
  return {
    sessionId,
    completionTtlMs: DEFAULT_COMPLETION_TTL_MS,
    promptTtlMs: DEFAULT_PROMPT_TTL_MS,
    cacheBreakMinDrop: DEFAULT_BREAK_MIN_DROP
  };
}

export function defaultPromptCacheStats(): PromptCacheStats {
  return {
    trackedRequests: 0,
    completionCacheHits: 0,
    completionCacheMisses: 0,
    completionCacheWrites: 0,
    expectedInvalidations: 0,
    unexpectedCacheBreaks: 0,
    totalCacheCreationInputTokens: 0,
    totalCacheReadInputTokens: 0
  };
}

export function promptCachePathsForSession(sessionId: string): PromptCachePaths {
  const root = baseCacheRoot();
  const sessionDir = path.join(root, sanitizePathSegment(sessionId));
  const completionDir = path.join(sessionDir, "completions");
  return {
    root,
    sessionDir,
    completionDir,
    sessionStatePath: path.join(sessionDir, "session-state.json"),
    statsPath: path.join(sessionDir, "stats.json")
  };
}

export function completionEntryPath(paths: PromptCachePaths, requestHash: string): string {
  return path.join(paths.completionDir, `${requestHash}.json`);
}

export function sanitizePathSegment(value: string): string {
  const sanitized = [...value].map((ch) => (/[a-z0-9]/i.test(ch) ? ch : "-")).join("");
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized;
  }
  const suffix = `-${hashString(value).slice(0, 8)}`;
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH - suffix.length)}${suffix}`;
}

export function requestHashHex(request: MessageRequest): string {
  return `${REQUEST_FINGERPRINT_PREFIX}-${stableHashJson(request)}`;
}

export function detectCacheBreak(
  config: PromptCacheConfig,
  previous: TrackedPromptState | undefined,
  current: TrackedPromptState
): CacheBreakEvent | undefined {
  if (!previous) {
    return undefined;
  }

  const tokenDrop = Math.max(0, previous.cacheReadInputTokens - current.cacheReadInputTokens);
  if (tokenDrop < config.cacheBreakMinDrop) {
    return undefined;
  }

  const reasons: string[] = [];
  if (previous.modelHash !== current.modelHash) {
    reasons.push("model changed");
  }
  if (previous.systemHash !== current.systemHash) {
    reasons.push("system prompt changed");
  }
  if (previous.toolsHash !== current.toolsHash) {
    reasons.push("tool definitions changed");
  }
  if (previous.messagesHash !== current.messagesHash) {
    reasons.push("message payload changed");
  }

  const elapsedMs = current.observedAtUnixMs - previous.observedAtUnixMs;
  const unexpected = reasons.length === 0 && elapsedMs <= config.promptTtlMs;
  const reason =
    reasons.length > 0
      ? reasons.join(", ")
      : unexpected
        ? "cache read tokens dropped while prompt fingerprint remained stable"
        : `possible prompt cache TTL expiry after ${Math.floor(elapsedMs / 1000)}s`;

  return {
    unexpected,
    reason,
    previousCacheReadInputTokens: previous.cacheReadInputTokens,
    currentCacheReadInputTokens: current.cacheReadInputTokens,
    tokenDrop
  };
}

export function trackedPromptStateFromUsage(request: MessageRequest, usage: Usage): TrackedPromptState {
  return {
    observedAtUnixMs: Date.now(),
    fingerprintVersion: REQUEST_FINGERPRINT_PREFIX,
    modelHash: stableHashJson(request.model),
    systemHash: stableHashJson(request.system ?? null),
    toolsHash: stableHashJson(request.tools ?? null),
    messagesHash: stableHashJson(request.messages),
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0
  };
}

export function applyUsageToStats(
  stats: PromptCacheStats,
  usage: Usage,
  requestHash: string,
  source: string
): void {
  stats.totalCacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
  stats.totalCacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
  stats.lastCacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
  stats.lastCacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
  stats.lastRequestHash = requestHash;
  stats.lastCacheSource = source;
}

export function baseCacheRoot(): string {
  if (process.env.CLAUDE_CONFIG_HOME) {
    return path.join(process.env.CLAUDE_CONFIG_HOME, "cache", "prompt-cache");
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, ".claude", "cache", "prompt-cache");
  }
  return path.join(process.cwd(), ".tmp", "claude-prompt-cache");
}

function stableHashJson(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

function hashString(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function ensureCacheDirs(paths: PromptCachePaths): void {
  fs.mkdirSync(paths.completionDir, { recursive: true });
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore missing file cleanup errors.
  }
}
