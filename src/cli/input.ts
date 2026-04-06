export type ReadOutcome =
  | { type: "submit"; value: string }
  | { type: "cancel" }
  | { type: "exit" };

export function slashCommandPrefix(line: string, pos: number): string | undefined {
  if (pos !== line.length) {
    return undefined;
  }
  const prefix = line.slice(0, pos);
  if (!prefix.startsWith("/")) {
    return undefined;
  }
  return prefix;
}

export function normalizeCompletions(completions: string[]): string[] {
  return [...new Set(completions.filter((candidate) => candidate.startsWith("/")))];
}

export function completeSlashCommand(
  line: string,
  pos: number,
  completions: string[]
): { start: number; matches: string[] } {
  const prefix = slashCommandPrefix(line, pos);
  if (!prefix) {
    return { start: 0, matches: [] };
  }
  return {
    start: 0,
    matches: normalizeCompletions(completions).filter((candidate) => candidate.startsWith(prefix))
  };
}

export function parseReadResult(value: string | null | undefined): ReadOutcome {
  if (value == null) {
    return { type: "exit" };
  }
  return { type: "submit", value };
}
