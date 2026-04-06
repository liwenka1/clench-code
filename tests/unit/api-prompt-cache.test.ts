import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  PromptCache,
  completionEntryPath,
  defaultPromptCacheConfig,
  detectCacheBreak,
  promptCachePathsForSession,
  requestHashHex,
  sanitizePathSegment,
  trackedPromptStateFromUsage
} from "../../src/api";
import { withEnv } from "../helpers/envGuards";

describe("api prompt cache", () => {
  test("path_builder_sanitizes_session_identifier", async () => {
    const paths = promptCachePathsForSession("session:/with spaces");
    expect(path.basename(paths.sessionDir)).toBe("session--with-spaces");
    expect(paths.completionDir.endsWith("completions")).toBe(true);
    expect(paths.statsPath.endsWith("stats.json")).toBe(true);
    expect(paths.sessionStatePath.endsWith("session-state.json")).toBe(true);
  });

  test("request_fingerprint_drives_unexpected_break_detection", async () => {
    const request = sampleRequest("same");
    const previous = trackedPromptStateFromUsage(request, {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 6000,
      output_tokens: 0
    });
    const current = trackedPromptStateFromUsage(request, {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1000,
      output_tokens: 0
    });
    const event = detectCacheBreak(defaultPromptCacheConfig("default"), previous, current);

    expect(event?.unexpected).toBe(true);
    expect(event?.reason).toContain("stable");
  });

  test("changed_prompt_marks_break_as_expected", async () => {
    const previous = trackedPromptStateFromUsage(sampleRequest("first"), {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 6000,
      output_tokens: 0
    });
    const current = trackedPromptStateFromUsage(sampleRequest("second"), {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1000,
      output_tokens: 0
    });
    const event = detectCacheBreak(defaultPromptCacheConfig("default"), previous, current);

    expect(event?.unexpected).toBe(false);
    expect(event?.reason).toContain("message payload changed");
  });

  test("completion_cache_round_trip_persists_recent_response", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withEnv({ CLAUDE_CONFIG_HOME: cacheRoot }, async () => {
        const cache = new PromptCache("unit-test-session");
        const request = sampleRequest("cache me");
        const response = sampleResponse(42, 12, "cached");

        expect(cache.lookupCompletion(request)).toBeUndefined();
        const record = cache.recordResponse(request, response);
        expect(record.cacheBreak).toBeUndefined();

        const cached = cache.lookupCompletion(request);
        expect(cached?.content).toEqual(response.content);

        const stats = cache.stats();
        expect(stats.completionCacheHits).toBe(1);
        expect(stats.completionCacheMisses).toBe(1);
        expect(stats.completionCacheWrites).toBe(1);

        const entryPath = completionEntryPath(cache.paths(), requestHashHex(request));
        expect(fs.existsSync(entryPath)).toBe(true);
      });
    });
  });

  test("distinct_requests_do_not_collide_in_completion_cache", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withEnv({ CLAUDE_CONFIG_HOME: cacheRoot }, async () => {
        const cache = new PromptCache("distinct-request-session");
        cache.recordResponse(sampleRequest("first"), sampleResponse(42, 12, "cached"));

        expect(cache.lookupCompletion(sampleRequest("second"))).toBeUndefined();
      });
    });
  });

  test("expired_completion_entries_are_not_reused", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      await withEnv({ CLAUDE_CONFIG_HOME: cacheRoot }, async () => {
        const cache = PromptCache.withConfig({
          sessionId: "expired-session",
          completionTtlMs: 0
        });
        const request = sampleRequest("expire me");
        cache.recordResponse(request, sampleResponse(7, 3, "stale"));

        expect(cache.lookupCompletion(request)).toBeUndefined();
        expect(cache.stats().completionCacheHits).toBe(0);
        expect(cache.stats().completionCacheMisses).toBe(1);
      });
    });
  });
});

function sampleRequest(text: string) {
  return {
    model: "claude-3-7-sonnet-latest",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [{ type: "text" as const, text }]
      }
    ],
    system: "system"
  };
}

function sampleResponse(cacheReadInputTokens: number, outputTokens: number, text: string) {
  return {
    id: "msg_test",
    type: "message" as const,
    role: "assistant",
    content: [{ type: "text" as const, text }],
    model: "claude-3-7-sonnet-latest",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: cacheReadInputTokens,
      output_tokens: outputTokens
    },
    request_id: "req_test"
  };
}

async function withTempCacheRoot<T>(run: (cacheRoot: string) => Promise<T>): Promise<T> {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-cache-test-"));
  try {
    return await run(cacheRoot);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
}
