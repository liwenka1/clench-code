import fs from "node:fs";
import path from "node:path";

export type InitStatus = "created" | "updated" | "skipped";

export interface InitArtifact {
  name: string;
  status: InitStatus;
}

export interface InitReport {
  projectRoot: string;
  artifacts: InitArtifact[];
}

const STARTER_CLAUDE_JSON = `{
  "permissions": {
    "defaultMode": "dontAsk"
  }
}
`;

const GITIGNORE_COMMENT = "# Clench Code local artifacts";
const GITIGNORE_ENTRIES = [".claude/settings.local.json", ".claude/sessions/"];

export function initializeRepo(cwd: string): InitReport {
  const artifacts: InitArtifact[] = [];

  const claudeDir = path.join(cwd, ".claude");
  artifacts.push({ name: ".claude/", status: ensureDir(claudeDir) });

  const claudeJson = path.join(cwd, ".claude.json");
  artifacts.push({ name: ".claude.json", status: writeFileIfMissing(claudeJson, STARTER_CLAUDE_JSON) });

  const gitignore = path.join(cwd, ".gitignore");
  artifacts.push({ name: ".gitignore", status: ensureGitignoreEntries(gitignore) });

  const claudeMd = path.join(cwd, "CLAUDE.md");
  artifacts.push({ name: "CLAUDE.md", status: writeFileIfMissing(claudeMd, renderInitClaudeMd(cwd)) });

  return {
    projectRoot: cwd,
    artifacts
  };
}

export function renderInitClaudeMd(cwd: string): string {
  const hasPackageJson = fs.existsSync(path.join(cwd, "package.json"));
  const hasTsconfig = fs.existsSync(path.join(cwd, "tsconfig.json"));
  const hasPyproject = fs.existsSync(path.join(cwd, "pyproject.toml"));
  const hasRust = fs.existsSync(path.join(cwd, "Cargo.toml")) || fs.existsSync(path.join(cwd, "rust", "Cargo.toml"));

  const languages: string[] = [];
  if (hasRust) languages.push("Rust");
  if (hasPyproject) languages.push("Python");
  if (hasTsconfig) languages.push("TypeScript");
  else if (hasPackageJson) languages.push("JavaScript/Node.js");

  return [
    "# CLAUDE.md",
    "",
    "This file provides guidance to Clench Code when working with code in this repository.",
    "",
    "## Detected stack",
    languages.length > 0 ? `- Languages: ${languages.join(", ")}.` : "- Languages: none detected.",
    "",
    "## Working agreement",
    "- Prefer small, reviewable changes.",
    "- Keep generated bootstrap files aligned with actual repo workflows."
  ].join("\n");
}

function ensureDir(dirPath: string): InitStatus {
  if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
    return "skipped";
  }
  fs.mkdirSync(dirPath, { recursive: true });
  return "created";
}

function writeFileIfMissing(filePath: string, content: string): InitStatus {
  if (fs.existsSync(filePath)) {
    return "skipped";
  }
  fs.writeFileSync(filePath, content, "utf8");
  return "created";
}

function ensureGitignoreEntries(filePath: string): InitStatus {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${GITIGNORE_COMMENT}\n${GITIGNORE_ENTRIES.join("\n")}\n`, "utf8");
    return "created";
  }

  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  let changed = false;
  if (!lines.includes(GITIGNORE_COMMENT)) {
    lines.push(GITIGNORE_COMMENT);
    changed = true;
  }
  for (const entry of GITIGNORE_ENTRIES) {
    if (!lines.includes(entry)) {
      lines.push(entry);
      changed = true;
    }
  }

  if (!changed) {
    return "skipped";
  }

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return "updated";
}
