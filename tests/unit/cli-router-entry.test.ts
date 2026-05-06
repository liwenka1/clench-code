import { describe, expect, test } from "vitest";

import {
  extractSessionReference,
  hasPersistFlag,
  looksLikeSlashCommandToken,
  translateHeadlessCommandArgv
} from "../../src/cli/router-entry";

describe("router entry helpers", () => {
  test("detects slash command tokens without treating absolute paths as slash commands", () => {
    expect(looksLikeSlashCommandToken("/status")).toBe(true);
    expect(looksLikeSlashCommandToken("/var/tmp/session.jsonl")).toBe(false);
    expect(looksLikeSlashCommandToken("status")).toBe(false);
  });

  test("prefers resume over session references", () => {
    expect(extractSessionReference(["--session", "b.jsonl", "--resume", "a.jsonl"])).toBe("a.jsonl");
    expect(extractSessionReference(["--session=b.jsonl"])).toBe("b.jsonl");
  });

  test("translates top-level aliases while preserving preceding options", () => {
    expect(translateHeadlessCommandArgv(["--model", "opus", "config", "model"])).toEqual([
      "--model",
      "opus",
      "/config",
      "model"
    ]);
    expect(translateHeadlessCommandArgv(["hello"])).toBeUndefined();
  });

  test("detects persist flag", () => {
    expect(hasPersistFlag(["--persist", "hello"])).toBe(true);
    expect(hasPersistFlag(["hello"])).toBe(false);
  });
});
