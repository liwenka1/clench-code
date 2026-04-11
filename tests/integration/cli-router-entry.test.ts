import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ANTHROPIC_DEFAULT_MAX_RETRIES, ApiError } from "../../src/api";
import { runCliEntry } from "../../src/cli/router";
import { resolveSessionFilePath } from "../../src/cli/run";
import { withEnv } from "../helpers/envGuards";

function streamFromString(body: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  });
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe("cli router entry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("run_cli_entry_prompt_propagates_anthropic_401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { type: "authentication_error", message: "invalid key" }
          }),
          { status: 401, headers: { "content-type": "application/json" } }
        )
      )
    );

    await withEnv({ ANTHROPIC_API_KEY: "bad" }, async () => {
      await expect(runCliEntry(["hello"])).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof ApiError && err.code === "api_error" && err.status === 401
      );
    });
  });

  test("run_cli_entry_prompt_surfaces_429_retries_exhausted", async () => {
    const rateLimitBody = () =>
      JSON.stringify({
        error: { type: "rate_limit_error", message: "too many" }
      });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Response(rateLimitBody(), {
            status: 429,
            headers: { "content-type": "application/json" }
          })
      )
    );

    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      await expect(runCliEntry(["rate-limit"])).rejects.toMatchObject({ code: "retries_exhausted" });
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(ANTHROPIC_DEFAULT_MAX_RETRIES + 1);
  });

  test("run_cli_entry_unknown_slash_command_surfaces_error_on_stderr", async () => {
    const prevExit = process.exitCode;
    process.exitCode = 0;
    try {
      const errText = await captureStderr(async () => {
        await runCliEntry(["/unknown-slash"]);
      });
      expect(process.exitCode).toBe(1);
      expect(errText).toMatch(/unknown slash command/i);
    } finally {
      process.exitCode = prevExit;
    }
  });

  test("run_cli_entry_export_without_resume_surfaces_error_on_stderr", async () => {
    const prevExit = process.exitCode;
    process.exitCode = 0;
    try {
      const errText = await captureStderr(async () => {
        await runCliEntry(["/export", "/tmp/clench-export-out.md"]);
      });
      expect(process.exitCode).toBe(1);
      expect(errText).toMatch(/\/export requires a resumed session/i);
    } finally {
      process.exitCode = prevExit;
    }
  });

  test("run_cli_entry_clear_without_resume_surfaces_error_on_stderr", async () => {
    const prevExit = process.exitCode;
    process.exitCode = 0;
    try {
      const errText = await captureStderr(async () => {
        await runCliEntry(["/clear"]);
      });
      expect(process.exitCode).toBe(1);
      expect(errText).toMatch(/\/clear requires a resumed session/i);
    } finally {
      process.exitCode = prevExit;
    }
  });

  test("run_cli_entry_export_with_resume_but_no_destination_surfaces_error_on_stderr", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-export-dest-"));
    const sessionPath = path.join(cacheRoot, "s.jsonl");
    fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "meta", sessionId: "exp" })}\n`, "utf8");
    const prevExit = process.exitCode;
    process.exitCode = 0;
    try {
      const errText = await captureStderr(async () => {
        await runCliEntry(["--resume", sessionPath, "/export"]);
      });
      expect(process.exitCode).toBe(1);
      expect(errText).toMatch(/\/export requires a destination path/i);
    } finally {
      process.exitCode = prevExit;
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_config_slash_prints_loaded_files_and_string_section", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-config-"));
    fs.writeFileSync(
      path.join(cacheRoot, ".clench.json"),
      JSON.stringify({ mySection: "section_value" }),
      "utf8"
    );
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cacheRoot);
    try {
      const out = await captureStdout(async () => {
        await runCliEntry(["/config", "mySection"]);
      });
      expect(out).toContain("Config\n");
      expect(out).toContain(".clench.json");
      expect(out).toContain("Merged section: mySection");
      expect(out).toContain("section_value");
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_config_without_section_shows_zero_loaded_when_no_config_files", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-config-empty-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cacheRoot);
    try {
      const out = await captureStdout(async () => {
        await runCliEntry(["/config"]);
      });
      expect(out).toContain("Config\n");
      expect(out).toContain("Loaded files      0");
      expect(out).not.toContain("Merged section:");
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_config_loads_settings_json_from_clench_config_home", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-cwd-only-"));
    const cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "clench-cfg-home-"));
    const settingsPath = path.join(cfgHome, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ fromHome: "home_value" }), "utf8");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cacheRoot);
    try {
      await withEnv({ CLENCH_CONFIG_HOME: cfgHome }, async () => {
        const out = await captureStdout(async () => {
          await runCliEntry(["/config", "fromHome"]);
        });
        expect(out).toContain(settingsPath);
        expect(out).toContain("Merged section: fromHome");
        expect(out).toContain("home_value");
      });
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
      fs.rmSync(cfgHome, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_config_dot_clench_json_overrides_config_home_when_no_local", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-merge-json-"));
    const cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "clench-merge-json-home-"));
    fs.writeFileSync(
      path.join(cfgHome, "settings.json"),
      JSON.stringify({ overrideKey: "from_home" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(cacheRoot, ".clench.json"),
      JSON.stringify({ overrideKey: "from_json" }),
      "utf8"
    );
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cacheRoot);
    try {
      await withEnv({ CLENCH_CONFIG_HOME: cfgHome }, async () => {
        const out = await captureStdout(async () => {
          await runCliEntry(["/config", "overrideKey"]);
        });
        expect(out).toContain("from_json");
        expect(out).not.toContain("from_home");
      });
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
      fs.rmSync(cfgHome, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_config_settings_local_overrides_dot_clench_json", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-merge-local-"));
    fs.mkdirSync(path.join(cacheRoot, ".clench"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheRoot, ".clench.json"),
      JSON.stringify({ mergeKey: "from_dot_clench_json" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(cacheRoot, ".clench", "settings.local.json"),
      JSON.stringify({ mergeKey: "from_settings_local" }),
      "utf8"
    );
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cacheRoot);
    try {
      const out = await captureStdout(async () => {
        await runCliEntry(["/config", "mergeKey"]);
      });
      expect(out).toContain(".clench.json");
      expect(out).toContain("settings.local.json");
      expect(out).toContain("from_settings_local");
      expect(out).not.toContain("from_dot_clench_json");
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_config_full_merge_chain_last_file_wins", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-merge-chain-"));
    const cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), "clench-merge-chain-home-"));
    fs.writeFileSync(
      path.join(cfgHome, "settings.json"),
      JSON.stringify({ chainKey: "from_config_home" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(cacheRoot, ".clench.json"),
      JSON.stringify({ chainKey: "from_dot_clench_json" }),
      "utf8"
    );
    fs.mkdirSync(path.join(cacheRoot, ".clench"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheRoot, ".clench", "settings.local.json"),
      JSON.stringify({ chainKey: "from_settings_local" }),
      "utf8"
    );
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cacheRoot);
    try {
      await withEnv({ CLENCH_CONFIG_HOME: cfgHome }, async () => {
        const out = await captureStdout(async () => {
          await runCliEntry(["/config", "chainKey"]);
        });
        expect(out).toContain("from_settings_local");
        expect(out).not.toContain("from_dot_clench_json");
        expect(out).not.toContain("from_config_home");
      });
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
      fs.rmSync(cfgHome, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_slash_status_last_resume_or_session_wins_per_parse_args", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-slash-order-"));
    const pathA = path.join(cacheRoot, "order-a.jsonl");
    const pathB = path.join(cacheRoot, "order-b.jsonl");
    fs.writeFileSync(pathA, `${JSON.stringify({ type: "meta", sessionId: "oa" })}\n`, "utf8");
    fs.writeFileSync(pathB, `${JSON.stringify({ type: "meta", sessionId: "ob" })}\n`, "utf8");

    const outResumeFirst = await captureStdout(async () => {
      await runCliEntry(["--resume", pathA, "--session", pathB, "/status"]);
    });
    expect(outResumeFirst).toMatch(new RegExp(`Session\\s+${escapeRegExp(pathB)}`));

    const outSessionFirst = await captureStdout(async () => {
      await runCliEntry(["--session", pathB, "--resume", pathA, "/status"]);
    });
    expect(outSessionFirst).toMatch(new RegExp(`Session\\s+${escapeRegExp(pathA)}`));

    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  test("run_cli_entry_session_only_prompt_writes_that_session_file", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-sess-only-"));
    const pathA = path.join(cacheRoot, "only-a.jsonl");
    const pathB = path.join(cacheRoot, "only-b.jsonl");
    const initialA = `${JSON.stringify({ type: "meta", sessionId: "oa" })}\n`;
    const initialB = `${JSON.stringify({ type: "meta", sessionId: "ob" })}\n`;
    fs.writeFileSync(pathA, initialA, "utf8");
    fs.writeFileSync(pathB, initialB, "utf8");

    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "so1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "SessOnlyOK" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamFromString(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );

    try {
      await withEnv(
        { ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_HOME: cacheRoot },
        async () => {
          await captureStdout(async () => {
            await runCliEntry(["--session", pathB, "hello"]);
          });
          expect(fs.readFileSync(pathA, "utf8")).toBe(initialA);
          expect(fs.readFileSync(pathB, "utf8")).not.toBe(initialB);
          expect(fs.readFileSync(pathB, "utf8")).toContain("SessOnlyOK");
        }
      );
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_resume_wins_over_session_for_prompt_session_file", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-prec-"));
    const pathA = path.join(cacheRoot, "a.jsonl");
    const pathB = path.join(cacheRoot, "b.jsonl");
    const initialA = `${JSON.stringify({ type: "meta", sessionId: "a" })}\n`;
    const initialB = `${JSON.stringify({ type: "meta", sessionId: "b" })}\n`;
    fs.writeFileSync(pathA, initialA, "utf8");
    fs.writeFileSync(pathB, initialB, "utf8");

    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "prec1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "PrecOK" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamFromString(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );

    try {
      await withEnv(
        { ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_HOME: cacheRoot },
        async () => {
          await captureStdout(async () => {
            await runCliEntry(["--session", pathB, "--resume", pathA, "ping"]);
          });
          expect(fs.readFileSync(pathB, "utf8")).toBe(initialB);
          expect(fs.readFileSync(pathA, "utf8")).not.toBe(initialA);
          expect(fs.readFileSync(pathA, "utf8")).toContain("PrecOK");
        }
      );
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_help_prints_usage", async () => {
    const out = await captureStdout(async () => {
      await runCliEntry(["--help"]);
    });
    expect(out).toContain("Usage");
    expect(out).toContain("--resume");
  });

  test("run_cli_entry_resume_plus_prompt_runs_prompt_mode", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-"));
    const sessionPath = path.join(cacheRoot, "r.jsonl");
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({ type: "meta", sessionId: "router-s" })}\n`,
      "utf8"
    );

    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "r1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "RouterOK" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamFromString(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );

    try {
      await withEnv(
        { ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_HOME: cacheRoot },
        async () => {
          const out = await captureStdout(async () => {
            await runCliEntry(["--resume", sessionPath, "ping"]);
          });
          expect(out).toContain("RouterOK");
        }
      );
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_prompt_output_format_json_prints_turn_summary", async () => {
    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "jf1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "JsonFmtOK" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamFromString(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );

    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      const out = await captureStdout(async () => {
        await runCliEntry(["--output-format", "json", "ping"]);
      });
      const parsed = JSON.parse(out.trim()) as {
        assistantMessages: Array<{ blocks?: Array<{ text?: string }> }>;
        iterations: number;
        usage: unknown;
      };
      expect(parsed.iterations).toBeGreaterThanOrEqual(1);
      expect(parsed.usage).toBeDefined();
      expect(JSON.stringify(parsed)).toContain("JsonFmtOK");
    });
  });

  test("run_cli_entry_prompt_output_format_ndjson_prints_single_line", async () => {
    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "nf1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "NdjsonFmtOK" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamFromString(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );

    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      const out = await captureStdout(async () => {
        await runCliEntry(["--output-format", "ndjson", "ping"]);
      });
      const lines = out.trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!) as { assistantMessages: unknown[]; iterations: number };
      expect(parsed.iterations).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(parsed)).toContain("NdjsonFmtOK");
    });
  });

  test("run_cli_entry_prompt_output_format_json_accepts_inline_eq_form", async () => {
    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "eqf1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "EqFmtOK" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamFromString(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );

    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      const out = await captureStdout(async () => {
        await runCliEntry(["--output-format=json", "ping"]);
      });
      const parsed = JSON.parse(out.trim()) as { iterations: number };
      expect(parsed.iterations).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(parsed)).toContain("EqFmtOK");
    });
  });

  test("run_cli_entry_permission_mode_read_only_plain_prompt_runs", async () => {
    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "ro1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ReadOnlyPlainOK" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamFromString(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );

    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      const out = await captureStdout(async () => {
        await runCliEntry(["--permission-mode", "read-only", "hi"]);
      });
      expect(out).toContain("ReadOnlyPlainOK");
    });
  });

  test("run_cli_entry_read_only_denies_bash_when_allowed_tools_includes_bash", async () => {
    const messageStart = {
      type: "message_start",
      message: {
        id: "t1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-7-sonnet-latest",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };

    const sseTool =
      sseData(messageStart) +
      sseData({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "tb1",
          name: "bash",
          input: {}
        }
      }) +
      sseData({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"command":"echo hi"}' }
      }) +
      sseData({ type: "content_block_stop", index: 1 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 3, output_tokens: 3 }
      }) +
      sseData({ type: "message_stop" });

    const sseText =
      sseData({
        ...messageStart,
        message: { ...messageStart.message, id: "t2" }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "After deny." }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 6, output_tokens: 2 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(streamFromString(sseTool), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
        .mockResolvedValueOnce(
          new Response(streamFromString(sseText), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
    );

    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      const out = await captureStdout(async () => {
        await runCliEntry([
          "--permission-mode",
          "read-only",
          "--allowed-tools",
          "bash",
          "--output-format",
          "json",
          "run bash"
        ]);
      });
      const parsed = JSON.parse(out.trim()) as {
        toolResults: unknown[];
        assistantMessages: unknown[];
      };
      expect(parsed.toolResults.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(parsed)).toMatch(/read-only|danger-full-access/);
      expect(JSON.stringify(parsed)).toContain("After deny.");
    });
  });

  test("run_cli_entry_non_tty_repl_with_resume_delegates_to_status_with_session", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-notty-"));
    const sessionPath = path.join(cacheRoot, "resume.jsonl");
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({ type: "meta", sessionId: "notty-s" })}\n`,
      "utf8"
    );
    const prevStdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const prevStdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    try {
      await withEnv({ CLAUDE_CONFIG_HOME: cacheRoot }, async () => {
        const out = await captureStdout(async () => {
          await runCliEntry(["--resume", sessionPath]);
        });
        expect(out).toContain("Status\n");
        expect(out).toMatch(new RegExp(`Session\\s+${escapeRegExp(sessionPath)}`));
        expect(out).toMatch(/Messages\s+0/);
      });
    } finally {
      if (prevStdin) {
        Object.defineProperty(process.stdin, "isTTY", prevStdin);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
      if (prevStdout) {
        Object.defineProperty(process.stdout, "isTTY", prevStdout);
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_prompt_keyword_without_text_falls_through_to_status", async () => {
    const out = await captureStdout(async () => {
      await runCliEntry(["prompt"]);
    });
    expect(out).toContain("Status\n");
    expect(out).toContain("claude-opus-4-6");
  });

  test("run_cli_entry_status_token_prints_status", async () => {
    const out = await captureStdout(async () => {
      await runCliEntry(["status"]);
    });
    expect(out).toContain("Status\n");
    expect(out).toContain("claude-opus-4-6");
  });

  test("run_cli_entry_help_slash_prints_interactive_help", async () => {
    const out = await captureStdout(async () => {
      await runCliEntry(["/help"]);
    });
    expect(out).toContain("Interactive slash commands");
    expect(out).toContain("/status");
  });

  test("run_cli_entry_resume_eq_form_prompt_runs_prompt_mode", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-eq-"));
    const sessionPath = path.join(cacheRoot, "eq.jsonl");
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({ type: "meta", sessionId: "eq-s" })}\n`,
      "utf8"
    );
    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "eq1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "EqResumeOK" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamFromString(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );
    try {
      await withEnv(
        { ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_HOME: cacheRoot },
        async () => {
          const out = await captureStdout(async () => {
            await runCliEntry([`--resume=${sessionPath}`, "ping"]);
          });
          expect(out).toContain("EqResumeOK");
        }
      );
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_session_eq_form_prompt_runs_prompt_mode", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-sess-eq-"));
    const sessionPath = path.join(cacheRoot, "sess.jsonl");
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({ type: "meta", sessionId: "sess-eq" })}\n`,
      "utf8"
    );
    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "s1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "SessionEqOK" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamFromString(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );
    try {
      await withEnv(
        { ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_HOME: cacheRoot },
        async () => {
          const out = await captureStdout(async () => {
            await runCliEntry([`--session=${sessionPath}`, "hi"]);
          });
          expect(out).toContain("SessionEqOK");
        }
      );
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_persist_plus_prompt_writes_default_session_jsonl", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-persist-"));
    const defaultPath = path.join(cacheRoot, ".clench", "sessions", "default.jsonl");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cacheRoot);

    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "p1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "PersistOK" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamFromString(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );

    try {
      await withEnv(
        { ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_HOME: cacheRoot },
        async () => {
          const out = await captureStdout(async () => {
            await runCliEntry(["--persist", "one"]);
          });
          expect(out).toContain("PersistOK");
          expect(fs.existsSync(defaultPath)).toBe(true);
          const body = fs.readFileSync(defaultPath, "utf8");
          expect(body).toContain("one");
          expect(body).toContain("PersistOK");
        }
      );
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_persist_twice_accumulates_default_session_jsonl", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-persist-2-"));
    const defaultPath = path.join(cacheRoot, ".clench", "sessions", "default.jsonl");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cacheRoot);

    const buildSse = (text: string) =>
      sseData({
        type: "message_start",
        message: {
          id: `p-${text}`,
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(streamFromString(buildSse("PersistA")), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
        .mockResolvedValueOnce(
          new Response(streamFromString(buildSse("PersistB")), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
    );

    try {
      await withEnv(
        { ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_HOME: cacheRoot },
        async () => {
          await captureStdout(async () => {
            await runCliEntry(["--persist", "first"]);
          });
          await captureStdout(async () => {
            await runCliEntry(["--persist", "second"]);
          });
          expect(fs.existsSync(defaultPath)).toBe(true);
          const body = fs.readFileSync(defaultPath, "utf8");
          expect(body).toContain("first");
          expect(body).toContain("PersistA");
          expect(body).toContain("second");
          expect(body).toContain("PersistB");
          const msgLines = body.split(/\r?\n/).filter((line) => line.includes('"type":"message"'));
          expect(msgLines.length).toBeGreaterThanOrEqual(4);
        }
      );
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("run_cli_entry_resume_takes_precedence_over_persist_for_session_file", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clench-router-resume-vs-persist-"));
    const resumePath = path.join(cacheRoot, "named.jsonl");
    const defaultPath = path.join(cacheRoot, ".clench", "sessions", "default.jsonl");
    fs.writeFileSync(
      resumePath,
      `${JSON.stringify({ type: "meta", sessionId: "named-s" })}\n`,
      "utf8"
    );
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cacheRoot);

    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "rvp1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ResumeWinsOK" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamFromString(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );

    try {
      await withEnv(
        { ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_HOME: cacheRoot },
        async () => {
          await captureStdout(async () => {
            await runCliEntry(["--resume", resumePath, "--persist", "ping"]);
          });
          const named = fs.readFileSync(resumePath, "utf8");
          expect(named).toContain("ping");
          expect(named).toContain("ResumeWinsOK");
          expect(fs.existsSync(defaultPath)).toBe(false);
        }
      );
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((msg: string | Uint8Array) => {
    chunks.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

async function captureStderr(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((msg: string | Uint8Array) => {
    chunks.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("resolveSessionFilePath", () => {
  test("passes_through_absolute_reference_unchanged", () => {
    const abs = path.join(os.tmpdir(), `clench-abs-ref-${Date.now()}.jsonl`);
    expect(path.isAbsolute(abs)).toBe(true);
    expect(resolveSessionFilePath("/tmp/ws", abs)).toBe(abs);
  });

  test("resolves_relative_path_against_cwd", () => {
    const p = resolveSessionFilePath("/tmp/ws", "foo/bar.jsonl");
    expect(p).toBe(path.join("/tmp/ws", "foo/bar.jsonl"));
  });

  test("latest_picks_newest_session_by_mtime", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clench-latest-"));
    const sessionsDir = path.join(root, ".clench", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const older = path.join(sessionsDir, "older.jsonl");
    const newer = path.join(sessionsDir, "newer.jsonl");
    fs.writeFileSync(older, "{}\n", "utf8");
    fs.writeFileSync(newer, "{}\n", "utf8");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(older, past, past);
    try {
      expect(resolveSessionFilePath(root, "latest")).toBe(newer);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("latest_throws_when_no_managed_sessions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clench-latest-empty-"));
    const sessionsDir = path.join(root, ".clench", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    try {
      expect(() => resolveSessionFilePath(root, "latest")).toThrow(/no managed sessions/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
