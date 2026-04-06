import fs from "node:fs";
import path from "node:path";

import { CommandRegistry, type CommandManifestEntry } from "../commands/index.js";
import { ToolRegistry, type ToolManifestEntry } from "../tools/index.js";

export interface UpstreamPaths {
  repoRoot: string;
}

export interface BootstrapPlan {
  phases: string[];
}

export interface ExtractedManifest {
  commands: CommandRegistry;
  tools: ToolRegistry;
  bootstrap: BootstrapPlan;
}

export function extractManifest(paths: UpstreamPaths): ExtractedManifest {
  const commandsSource = fs.readFileSync(path.join(paths.repoRoot, "src/commands.ts"), "utf8");
  const toolsSource = fs.readFileSync(path.join(paths.repoRoot, "src/tools.ts"), "utf8");
  const cliSource = fs.readFileSync(path.join(paths.repoRoot, "src/entrypoints/cli.tsx"), "utf8");

  return {
    commands: extractCommands(commandsSource),
    tools: extractTools(toolsSource),
    bootstrap: extractBootstrapPlan(cliSource)
  };
}

export function extractCommands(source: string): CommandRegistry {
  const entries: CommandManifestEntry[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("import ")) {
      continue;
    }
    for (const symbol of importedSymbols(trimmed)) {
      entries.push({ name: symbol, source: "builtin" });
    }
  }
  return new CommandRegistry(dedupe(entries));
}

export function extractTools(source: string): ToolRegistry {
  const entries: ToolManifestEntry[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("import ") || !trimmed.includes("Tool")) {
      continue;
    }
    for (const symbol of importedSymbols(trimmed).filter((item) => item.endsWith("Tool"))) {
      entries.push({ name: symbol, source: "base", requiredPermission: "read-only" });
    }
  }
  return new ToolRegistry(dedupe(entries));
}

export function extractBootstrapPlan(source: string): BootstrapPlan {
  const phases = ["cli-entry"];
  if (source.includes("--version")) phases.push("fast-path-version");
  if (source.includes("--dump-system-prompt")) phases.push("system-prompt-fast-path");
  if (source.includes("--daemon-worker")) phases.push("daemon-worker-fast-path");
  phases.push("main-runtime");
  return { phases };
}

function importedSymbols(line: string): string[] {
  const afterImport = line.slice("import ".length);
  const beforeFrom = afterImport.split(" from ")[0]?.trim() ?? "";
  if (beforeFrom.startsWith("{")) {
    return beforeFrom
      .replace(/[{}]/g, "")
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }
  const first = beforeFrom.split(",")[0]?.trim();
  return first ? [first] : [];
}

function dedupe<T extends { name: string; source: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.name}:${entry.source}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
