import { execFileSync } from "node:child_process";

export interface GitCommitEntry {
  hash: string;
  subject: string;
}

export interface GitContext {
  branch?: string;
  recentCommits: GitCommitEntry[];
  stagedFiles: string[];
}

const MAX_RECENT_COMMITS = 5;

export function detectGitContext(cwd: string): GitContext | undefined {
  try {
    const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (inside !== "true") {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return {
    branch: readBranch(cwd),
    recentCommits: readRecentCommits(cwd),
    stagedFiles: readStagedFiles(cwd)
  };
}

export function renderGitContext(context: GitContext): string {
  const lines: string[] = [];

  if (context.branch) {
    lines.push(`Git branch: ${context.branch}`);
  }

  if (context.recentCommits.length > 0) {
    lines.push("");
    lines.push("Recent commits:");
    for (const entry of context.recentCommits) {
      lines.push(`  ${entry.hash} ${entry.subject}`);
    }
  }

  if (context.stagedFiles.length > 0) {
    lines.push("");
    lines.push("Staged files:");
    for (const file of context.stagedFiles) {
      lines.push(`  ${file}`);
    }
  }

  return lines.join("\n");
}

function readBranch(cwd: string): string | undefined {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

function readRecentCommits(cwd: string): GitCommitEntry[] {
  try {
    const stdout = execFileSync(
      "git",
      ["--no-optional-locks", "log", "--oneline", "-n", String(MAX_RECENT_COMMITS), "--no-decorate"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }
    );

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const split = line.indexOf(" ");
        if (split === -1) {
          return [];
        }
        return [{ hash: line.slice(0, split), subject: line.slice(split + 1) }];
      });
  } catch {
    return [];
  }
}

function readStagedFiles(cwd: string): string[] {
  try {
    const stdout = execFileSync("git", ["--no-optional-locks", "diff", "--cached", "--name-only"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
