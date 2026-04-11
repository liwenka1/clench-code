import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadPromptHistory, parsePromptHistoryLimit, saveReplHistory } from "../../src/cli";

describe("cli history", () => {
  test("loads prompt history from repl history and session prompts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clench-prompt-history-"));
    const sessionPath = path.join(root, ".clench", "sessions", "demo.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    saveReplHistory(root, ["older draft", "shared prompt"]);
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({ type: "meta", sessionId: "demo" }),
        JSON.stringify({
          type: "message",
          message: { role: "user", blocks: [{ type: "text", text: "shared prompt" }] }
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", blocks: [{ type: "text", text: "latest prompt" }] }
        })
      ].join("\n"),
      "utf8"
    );

    try {
      expect(loadPromptHistory(root, sessionPath)).toEqual([
        "older draft",
        "shared prompt",
        "latest prompt"
      ]);
      expect(parsePromptHistoryLimit(undefined)).toBe(20);
      expect(parsePromptHistoryLimit(5)).toBe(5);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
