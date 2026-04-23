import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  normalizeAllowedTools,
  parseMainArgs,
  resolveModelAlias,
  resolvePermissionMode,
  unknownOptionMessage,
  unknownSlashCommandMessage
} from "../../src/cli";

describe("cli main", () => {
  test("ports parse_args prompt and repl routing behavior", async () => {
    expect(parseMainArgs([])).toEqual({
      type: "repl",
      model: "claude-opus-4-6",
      permissionMode: "danger-full-access",
      outputFormat: "text",
      allowedTools: undefined,
      compact: false
    });
    expect(parseMainArgs(["--help"])).toEqual({ type: "help" });
    expect(parseMainArgs(["prompt", "hello", "world"])).toEqual({
      type: "prompt",
      prompt: "hello world",
      model: "claude-opus-4-6",
      permissionMode: "danger-full-access",
      outputFormat: "text",
      allowedTools: undefined,
      compact: false
    });
    expect(parseMainArgs(["/help"])).toEqual({
      type: "slash",
      command: "/help",
      model: "claude-opus-4-6",
      permissionMode: "danger-full-access"
    });
    expect(parseMainArgs(["/var/tmp/foo.jsonl", "ping"])).toMatchObject({
      type: "prompt",
      prompt: "/var/tmp/foo.jsonl ping"
    });
    expect(parseMainArgs(["--persist", "hello"])).toEqual({
      type: "prompt",
      prompt: "hello",
      model: "claude-opus-4-6",
      permissionMode: "danger-full-access",
      outputFormat: "text",
      allowedTools: undefined,
      compact: false
    });
    expect(parseMainArgs(["--session", "s.jsonl", "hi"])).toMatchObject({
      type: "prompt",
      prompt: "hi"
    });
  });

  test("ports unknown option and slash command guidance behavior", async () => {
    expect(unknownOptionMessage("--wat")).toContain("--help");
    expect(unknownSlashCommandMessage("/wat")).toContain("/help");
    expect(() => parseMainArgs(["--wat"])).toThrow(/unknown option/i);
    expect(() => parseMainArgs(["/wat"])).toThrow(/unknown slash command/i);
  });

  test("ports model alias and permission mode resolution behavior", async () => {
    expect(resolveModelAlias("sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveModelAlias("opus")).toBe("claude-opus-4-6");
    expect(resolveModelAlias("haiku")).toBe("claude-haiku-4-5-20251213");
    expect(resolveModelAlias("grok-2")).toBe("grok-2");
    expect(resolvePermissionMode("read-only")).toBe("read-only");
    expect(resolvePermissionMode("workspace-write")).toBe("workspace-write");
  });

  test("ports allowed-tools normalization behavior", async () => {
    expect(normalizeAllowedTools(["bash", "BASH", "read_file"])).toEqual([
      "bash",
      "read_file"
    ]);
    expect(normalizeAllowedTools(["grep", "glob"])).toEqual([
      "grep_search",
      "glob_search"
    ]);
    expect(() => normalizeAllowedTools(["unknown_tool"])).toThrow(/unsupported tool/i);
  });

  test("parses compact flag for prompt and repl", () => {
    expect(parseMainArgs(["--compact"])).toMatchObject({ type: "repl", compact: true });
    expect(parseMainArgs(["--compact", "hello"])).toMatchObject({
      type: "prompt",
      prompt: "hello",
      compact: true
    });
  });

  test("reads default model from workspace config when model flag is absent", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clench-cli-main-config-"));
    try {
      fs.writeFileSync(path.join(cwd, ".clench.json"), JSON.stringify({ model: "openai/gpt-4.1-mini" }));

      expect(parseMainArgs([], cwd)).toMatchObject({
        type: "repl",
        model: "openai/gpt-4.1-mini"
      });
      expect(parseMainArgs(["hello"], cwd)).toMatchObject({
        type: "prompt",
        model: "openai/gpt-4.1-mini"
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
