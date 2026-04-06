import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { extractManifest } from "../../src/compat-harness/index.js";

describe("compat harness library", () => {
  test("ports compatibility manifest extraction behavior", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "compat-harness-"));
    mkdirSync(path.join(root, "src/entrypoints"), { recursive: true });
    writeFileSync(
      path.join(root, "src/commands.ts"),
      "import addDir from './commands/addDir'\nimport review from './commands/review'\n",
      "utf8"
    );
    writeFileSync(
      path.join(root, "src/tools.ts"),
      "import { AgentTool, BashTool } from './tools/runtime'\nimport { ReadFileTool } from './tools/file'\n",
      "utf8"
    );
    writeFileSync(
      path.join(root, "src/entrypoints/cli.tsx"),
      "const args = ['--version', '--dump-system-prompt', '--daemon-worker']\n",
      "utf8"
    );

    const manifest = extractManifest({ repoRoot: root });
    expect(manifest.commands.entries().map((entry) => entry.name)).toEqual(["addDir", "review"]);
    expect(manifest.tools.entries().map((entry) => entry.name)).toEqual([
      "AgentTool",
      "BashTool",
      "ReadFileTool"
    ]);
    expect(manifest.bootstrap.phases).toEqual([
      "cli-entry",
      "fast-path-version",
      "system-prompt-fast-path",
      "daemon-worker-fast-path",
      "main-runtime"
    ]);

    rmSync(root, { recursive: true, force: true });
  });
});
