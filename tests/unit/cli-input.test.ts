import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  beginMultiline,
  completeInteractiveSlashCommand,
  completeSlashCommand,
  consumeMultilineLine,
  loadReplHistory,
  MULTILINE_START_COMMAND,
  MULTILINE_SUBMIT_COMMAND,
  normalizeCompletions,
  parseReadResult,
  replHistoryPath,
  saveReplHistory,
  shouldEnterMultiline,
  slashCommandPrefix
} from "../../src/cli";

describe("cli input", () => {
  test("ports input parsing and REPL helper behavior", async () => {
    expect(slashCommandPrefix("/he", 3)).toBe("/he");
    expect(slashCommandPrefix("hello", 5)).toBeUndefined();

    expect(normalizeCompletions(["/help", "/help", "status", "/model"])).toEqual([
      "/help",
      "/model"
    ]);

    expect(
      completeSlashCommand("/he", 3, ["/help", "/hello", "/status"])
    ).toEqual({
      start: 0,
      matches: ["/help", "/hello"]
    });

    expect(parseReadResult(null)).toEqual({ type: "exit" });
    expect(parseReadResult("/help")).toEqual({ type: "submit", value: "/help" });
  });

  test("supports multiline compose helpers", () => {
    expect(shouldEnterMultiline(MULTILINE_START_COMMAND)).toBe(true);
    expect(shouldEnterMultiline("line one\\")).toBe(true);
    expect(shouldEnterMultiline("line one")).toBe(false);

    let state = beginMultiline(MULTILINE_START_COMMAND);
    state = consumeMultilineLine(state, "first line").state!;
    state = consumeMultilineLine(state, "second line\\").state!;
    const submitted = consumeMultilineLine(state, MULTILINE_SUBMIT_COMMAND);
    expect(submitted.submittedText).toBe("first line\nsecond line");
  });

  test("supports context-aware slash completions", () => {
    expect(
      completeInteractiveSlashCommand("/pl", "/pl".length, {
        slashCommands: ["/plugin", "/plugins", "/marketplace"],
        pluginNames: ["demo"]
      })
    ).toEqual({
      start: 0,
      matches: ["/plugin", "/plugins", "/plugin list", "/plugin install ", "/plugin enable ", "/plugin disable ", "/plugin uninstall ", "/plugins list"]
    });

    expect(
      completeInteractiveSlashCommand("/session sw", "/session sw".length, {
        slashCommands: ["/session", "/status"],
        sessionTargets: [".clench/sessions/a.jsonl"]
      })
    ).toEqual({
      start: 9,
      matches: ["switch"]
    });

    expect(
      completeInteractiveSlashCommand("/session switch .cl", "/session switch .cl".length, {
        slashCommands: ["/session"],
        sessionTargets: [".clench/sessions/a.jsonl", ".clench/sessions/b.jsonl"]
      })
    ).toEqual({
      start: 16,
      matches: [".clench/sessions/a.jsonl", ".clench/sessions/b.jsonl"]
    });

    expect(
      completeInteractiveSlashCommand("/session", "/session".length, {
        slashCommands: ["/session"],
        activeSessionTarget: ".clench/sessions/current.jsonl",
        sessionTargets: [".clench/sessions/a.jsonl"]
      })
    ).toEqual({
      start: 0,
      matches: [
        "/session",
        "/session list",
        "/session switch ",
        "/session switch latest",
        "/session fork ",
        "/session switch .clench/sessions/current.jsonl",
        "/session switch .clench/sessions/a.jsonl"
      ]
    });

    expect(
      completeInteractiveSlashCommand("/mcp show de", "/mcp show de".length, {
        slashCommands: ["/mcp"],
        mcpServers: ["demo", "remoteDemo"]
      })
    ).toEqual({
      start: 10,
      matches: ["demo"]
    });

    expect(
      completeInteractiveSlashCommand("/history ", "/history ".length, {
        slashCommands: ["/history"]
      })
    ).toEqual({
      start: 9,
      matches: ["10", "20", "50"]
    });
  });

  test("supports path-aware slash completions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clench-completion-"));
    fs.mkdirSync(path.join(root, "plugins"));
    fs.writeFileSync(path.join(root, "plugins", "local-plugin.ts"), "export default {};\n");
    fs.writeFileSync(path.join(root, "notes.md"), "# notes\n");
    try {
      expect(
        completeInteractiveSlashCommand("/plugin install pl", "/plugin install pl".length, {
          slashCommands: ["/plugin"],
          cwd: root
        })
      ).toEqual({
        start: 16,
        matches: ["plugins/"]
      });

      expect(
        completeInteractiveSlashCommand("/export no", "/export no".length, {
          slashCommands: ["/export"],
          cwd: root
        })
      ).toEqual({
        start: 8,
        matches: ["notes.md"]
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads and saves repl history", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clench-history-"));
    try {
      saveReplHistory(root, ["first", "second", "first"]);
      expect(fs.existsSync(replHistoryPath(root))).toBe(true);
      expect(loadReplHistory(root)).toEqual(["first", "second"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
