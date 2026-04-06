import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  SystemPromptBuilder,
  collapseBlankLines,
  discoverProjectContext,
  displayContextPath,
  normalizeInstructionContent,
  renderInstructionFiles,
  truncateInstructionContent
} from "../../src/runtime/prompt.js";

describe("runtime prompt", () => {
  test("ports prompt assembly behavior", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".runtime-prompt-"));
    const nested = path.join(root, "apps", "api");
    fs.mkdirSync(path.join(nested, ".clench"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "root instructions", "utf8");
    fs.writeFileSync(path.join(root, "CLAUDE.local.md"), "local instructions", "utf8");
    fs.writeFileSync(path.join(root, "apps", "CLAUDE.md"), "apps instructions", "utf8");
    fs.mkdirSync(path.join(root, "apps", ".clench"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps", ".clench", "instructions.md"), "apps dot claude instructions", "utf8");
    fs.writeFileSync(path.join(nested, ".clench", "CLAUDE.md"), "nested rules", "utf8");
    fs.writeFileSync(path.join(nested, ".clench", "instructions.md"), "nested instructions", "utf8");

    const context = discoverProjectContext(nested, "2026-03-31");
    expect(context.instructionFiles.map((file) => file.content.trim())).toEqual([
      "root instructions",
      "local instructions",
      "apps instructions",
      "apps dot claude instructions",
      "nested rules",
      "nested instructions"
    ]);

    const prompt = new SystemPromptBuilder()
      .withOutputStyle("Concise", "Prefer short answers.")
      .withOs("linux", "6.8")
      .withProjectContext(context)
      .withRuntimeConfig({ model: "sonnet", sandbox: { enabled: true } })
      .render();

    expect(prompt).toContain("# System");
    expect(prompt).toContain("# Project context");
    expect(prompt).toContain("# Claude instructions");
    expect(prompt).toContain("root instructions");
    expect(prompt).toContain("sandbox");
    expect(prompt).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

    expect(normalizeInstructionContent("line one\n\n\nline two\n")).toBe("line one\n\nline two");
    expect(collapseBlankLines("a\n\n\n\nb\n")).toBe("a\n\nb\n");
    expect(displayContextPath("/tmp/project/.clench/CLAUDE.md")).toBe("CLAUDE.md");
    expect(truncateInstructionContent("x".repeat(5000), 4000)).toContain("[truncated]");
    expect(renderInstructionFiles([{ path: "/tmp/project/CLAUDE.md", content: "Project rules" }])).toContain("scope: /tmp/project");

    fs.rmSync(root, { recursive: true, force: true });
  });
});
