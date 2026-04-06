export interface SummaryCompressionBudget {
  maxChars: number;
  maxLines: number;
  maxLineChars: number;
}

export interface SummaryCompressionResult {
  summary: string;
  originalChars: number;
  compressedChars: number;
  originalLines: number;
  compressedLines: number;
  removedDuplicateLines: number;
  omittedLines: number;
  truncated: boolean;
}

export const defaultSummaryCompressionBudget: SummaryCompressionBudget = {
  maxChars: 1200,
  maxLines: 24,
  maxLineChars: 160
};

export function compressSummary(
  summary: string,
  budget: SummaryCompressionBudget = defaultSummaryCompressionBudget
): SummaryCompressionResult {
  const originalChars = summary.length;
  const originalLines = summary.split("\n").length;
  const normalized = normalizeLines(summary, budget.maxLineChars);

  if (normalized.lines.length === 0 || budget.maxChars === 0 || budget.maxLines === 0) {
    return {
      summary: "",
      originalChars,
      compressedChars: 0,
      originalLines,
      compressedLines: 0,
      removedDuplicateLines: normalized.removedDuplicateLines,
      omittedLines: normalized.lines.length,
      truncated: originalChars > 0
    };
  }

  const selectedIndexes = selectLineIndexes(normalized.lines, budget);
  let compressedLines = selectedIndexes.map((index) => normalized.lines[index]);
  if (compressedLines.length === 0) {
    compressedLines = [truncateLine(normalized.lines[0], budget.maxChars)];
  }

  const omittedLines = Math.max(0, normalized.lines.length - compressedLines.length);
  if (omittedLines > 0) {
    const notice = `- … ${omittedLines} additional line(s) omitted.`;
    const candidate = [...compressedLines, notice];
    if (candidate.length <= budget.maxLines && joinedCharCount(candidate) <= budget.maxChars) {
      compressedLines = candidate;
    }
  }

  const compressed = compressedLines.join("\n");
  return {
    summary: compressed,
    originalChars,
    compressedChars: compressed.length,
    originalLines,
    compressedLines: compressedLines.length,
    removedDuplicateLines: normalized.removedDuplicateLines,
    omittedLines,
    truncated: compressed !== summary.trim()
  };
}

export function compressSummaryText(summary: string): string {
  return compressSummary(summary, defaultSummaryCompressionBudget).summary;
}

function normalizeLines(summary: string, maxLineChars: number): {
  lines: string[];
  removedDuplicateLines: number;
} {
  const seen = new Set<string>();
  const lines: string[] = [];
  let removedDuplicateLines = 0;

  for (const rawLine of summary.split("\n")) {
    const collapsed = rawLine.split(/\s+/).filter(Boolean).join(" ");
    if (!collapsed) {
      continue;
    }
    const truncated = truncateLine(collapsed, maxLineChars);
    const key = truncated.toLowerCase();
    if (seen.has(key)) {
      removedDuplicateLines += 1;
      continue;
    }
    seen.add(key);
    lines.push(truncated);
  }

  return { lines, removedDuplicateLines };
}

function selectLineIndexes(lines: string[], budget: SummaryCompressionBudget): number[] {
  const selected = new Set<number>();

  for (let priority = 0; priority <= 3; priority += 1) {
    for (const [index, line] of lines.entries()) {
      if (selected.has(index) || linePriority(line) !== priority) {
        continue;
      }
      const candidate = [...[...selected].map((selectedIndex) => lines[selectedIndex]), line];
      if (candidate.length > budget.maxLines || joinedCharCount(candidate) > budget.maxChars) {
        continue;
      }
      selected.add(index);
    }
  }

  return [...selected].sort((a, b) => a - b);
}

function linePriority(line: string): number {
  if (
    line === "Summary:" ||
    line === "Conversation summary:" ||
    [
      "- Scope:",
      "- Current work:",
      "- Pending work:",
      "- Key files referenced:",
      "- Tools mentioned:",
      "- Recent user requests:",
      "- Previously compacted context:",
      "- Newly compacted context:"
    ].some((prefix) => line.startsWith(prefix))
  ) {
    return 0;
  }
  if (line.endsWith(":")) {
    return 1;
  }
  if (line.startsWith("- ") || line.startsWith("  - ")) {
    return 2;
  }
  return 3;
}

function truncateLine(line: string, maxChars: number): string {
  if (maxChars === 0 || line.length <= maxChars) {
    return line;
  }
  if (maxChars === 1) {
    return "…";
  }
  return `${line.slice(0, maxChars - 1)}…`;
}

function joinedCharCount(lines: string[]): number {
  return lines.join("\n").length;
}
