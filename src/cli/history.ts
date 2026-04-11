import fs from "node:fs";
import path from "node:path";

import { Session } from "../runtime";

const MAX_HISTORY_ENTRIES = 500;
const DEFAULT_PROMPT_HISTORY_LIMIT = 20;

export function loadReplHistory(cwd: string): string[] {
  const filePath = replHistoryPath(cwd);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-MAX_HISTORY_ENTRIES);
}

export function saveReplHistory(cwd: string, entries: string[]): void {
  const filePath = replHistoryPath(cwd);
  const deduped = [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))].slice(-MAX_HISTORY_ENTRIES);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${deduped.join("\n")}\n`, "utf8");
}

export function replHistoryPath(cwd: string): string {
  return path.join(cwd, ".clench", "repl-history.txt");
}

export function parsePromptHistoryLimit(raw: number | undefined): number {
  return raw && raw > 0 ? raw : DEFAULT_PROMPT_HISTORY_LIMIT;
}

export function loadPromptHistory(cwd: string, sessionPath?: string): string[] {
  const merged = dedupeNewest([
    ...loadReplHistory(cwd),
    ...loadSessionPromptHistory(sessionPath)
  ]);
  return merged.slice(-MAX_HISTORY_ENTRIES);
}

function loadSessionPromptHistory(sessionPath?: string): string[] {
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return [];
  }
  return Session.loadFromPath(sessionPath).messages
    .filter((message) => message.role === "user")
    .map((message) =>
      message.blocks
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join("\n")
    )
    .filter(Boolean);
}

function dedupeNewest(entries: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!.trim();
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    deduped.push(entry);
  }
  return deduped.reverse();
}
