import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, test } from "vitest";

import { detectGitContext, renderGitContext, type GitContext } from "../../src/runtime/git-context.js";

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(tmpdir(), `.runtime-git-context-${label}-`));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(cwd: string): void {
  git(cwd, ["init", "--quiet"]);
  git(cwd, ["checkout", "-b", "main"]);
  git(cwd, ["config", "user.email", "tests@example.com"]);
  git(cwd, ["config", "user.name", "Git Context Tests"]);
}

describe("runtime git context", () => {
  test("returns undefined for non git directory", () => {
    const root = tempDir("non-git");
    try {
      expect(detectGitContext(root)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects branch name and commits", () => {
    const root = tempDir("branch-commits");
    try {
      initRepo(root);
      fs.writeFileSync(path.join(root, "a.txt"), "a\n");
      git(root, ["add", "a.txt"]);
      git(root, ["commit", "-m", "first commit", "--quiet"]);
      fs.writeFileSync(path.join(root, "b.txt"), "b\n");
      git(root, ["add", "b.txt"]);
      git(root, ["commit", "-m", "second commit", "--quiet"]);

      const context = detectGitContext(root);
      expect(context?.branch).toBe("main");
      expect(context?.recentCommits).toHaveLength(2);
      expect(context?.recentCommits[0]?.subject).toBe("second commit");
      expect(context?.recentCommits[1]?.subject).toBe("first commit");
      expect(context?.stagedFiles).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects staged files", () => {
    const root = tempDir("staged");
    try {
      initRepo(root);
      fs.writeFileSync(path.join(root, "init.txt"), "init\n");
      git(root, ["add", "init.txt"]);
      git(root, ["commit", "-m", "initial", "--quiet"]);
      fs.writeFileSync(path.join(root, "staged.txt"), "staged\n");
      git(root, ["add", "staged.txt"]);

      expect(detectGitContext(root)?.stagedFiles).toEqual(["staged.txt"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("render formats all sections", () => {
    const context: GitContext = {
      branch: "feat/test",
      recentCommits: [
        { hash: "abc1234", subject: "add feature" },
        { hash: "def5678", subject: "fix bug" }
      ],
      stagedFiles: ["src/main.ts"]
    };

    const rendered = renderGitContext(context);
    expect(rendered).toContain("Git branch: feat/test");
    expect(rendered).toContain("abc1234 add feature");
    expect(rendered).toContain("def5678 fix bug");
    expect(rendered).toContain("src/main.ts");
  });

  test("render omits empty sections", () => {
    const rendered = renderGitContext({
      branch: "main",
      recentCommits: [],
      stagedFiles: []
    });
    expect(rendered).toContain("Git branch: main");
    expect(rendered).not.toContain("Recent commits:");
    expect(rendered).not.toContain("Staged files:");
  });

  test("limits to five recent commits", () => {
    const root = tempDir("five-commits");
    try {
      initRepo(root);
      for (let index = 1; index <= 8; index += 1) {
        const name = `file${index}.txt`;
        fs.writeFileSync(path.join(root, name), `${index}\n`);
        git(root, ["add", name]);
        git(root, ["commit", "-m", `commit ${index}`, "--quiet"]);
      }

      const context = detectGitContext(root);
      expect(context?.recentCommits).toHaveLength(5);
      expect(context?.recentCommits[0]?.subject).toBe("commit 8");
      expect(context?.recentCommits[4]?.subject).toBe("commit 4");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
