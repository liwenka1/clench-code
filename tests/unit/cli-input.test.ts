import { describe, expect, test } from "vitest";

import {
  completeSlashCommand,
  normalizeCompletions,
  parseReadResult,
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
});
