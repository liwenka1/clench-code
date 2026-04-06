import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { initializeRepo, renderInitClaudeMd } from "../../src/cli";

describe("cli init", () => {
  test("ports init helper behavior", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-init-"));
    fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");

    const report = initializeRepo(root);
    expect(report.artifacts.map((artifact) => artifact.name)).toEqual([
      ".claude/",
      ".claude.json",
      ".gitignore",
      "CLAUDE.md"
    ]);
    expect(fs.existsSync(path.join(root, ".claude"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".claude.json"))).toBe(true);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain(".claude/sessions/");
    expect(renderInitClaudeMd(root)).toContain("Languages: TypeScript.");

    fs.rmSync(root, { recursive: true, force: true });
  });
});
