export interface SpinnerState {
  frameIndex: number;
}

export type RenderTone = "neutral" | "info" | "success" | "warning" | "error";

const SPINNER_FRAMES = ["-", "\\", "|", "/", "*"];
const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const TONE_CODES: Record<RenderTone, string> = {
  neutral: "\u001b[37m",
  info: "\u001b[36m",
  success: "\u001b[32m",
  warning: "\u001b[33m",
  error: "\u001b[31m"
};
const KEY_WIDTH = 17;

export function newSpinner(): SpinnerState {
  return { frameIndex: 0 };
}

export function tickSpinner(state: SpinnerState, label: string): string {
  const frame = SPINNER_FRAMES[state.frameIndex % SPINNER_FRAMES.length]!;
  state.frameIndex += 1;
  return `${colorize(frame, "info")} ${label}`;
}

export function finishSpinner(label: string, tone: Extract<RenderTone, "success" | "error"> = "success"): string {
  const icon = tone === "success" ? "OK" : "ERR";
  return `${colorize(icon, tone)} ${label}`;
}

export function colorize(text: string, tone: RenderTone, enabled = supportsAnsi()): string {
  if (!enabled || !text) {
    return text;
  }
  return `${TONE_CODES[tone]}${text}${RESET}`;
}

export function emphasize(text: string, enabled = supportsAnsi()): string {
  if (!enabled || !text) {
    return text;
  }
  return `${BOLD}${text}${RESET}`;
}

export function dim(text: string, enabled = supportsAnsi()): string {
  if (!enabled || !text) {
    return text;
  }
  return `${DIM}${text}${RESET}`;
}

export function supportsAnsi(stdout = process.stdout): boolean {
  return Boolean(stdout?.isTTY && process.env.NO_COLOR !== "1");
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function renderKeyValueRows(
  entries: Array<{ key: string; value: string | number | boolean | undefined }>
): string[] {
  return entries
    .filter((entry) => entry.value !== undefined && entry.value !== "")
    .map((entry) => `  ${entry.key.padEnd(KEY_WIDTH, " ")}${String(entry.value)}`);
}

export function renderSection(
  title: string,
  entries: Array<{ key: string; value: string | number | boolean | undefined }>
): string {
  return [emphasize(title), ...renderKeyValueRows(entries)].join("\n");
}

export function renderPanel(
  title: string,
  lines: string[],
  options: { tone?: RenderTone } = {}
): string {
  const tone = options.tone ?? "neutral";
  const visibleLines = lines.length > 0 ? lines : [""];
  const width = Math.max(
    title.length + 4,
    ...visibleLines.map((line) => stripAnsi(line).length + 2)
  );
  const top = `+- ${title} ${"-".repeat(Math.max(0, width - title.length - 4))}+`;
  const body = visibleLines.map((line) => `| ${line.padEnd(width - 2, " ")}|`);
  const bottom = `+${"-".repeat(width)}+`;
  return [colorize(top, tone), ...body, colorize(bottom, tone)].join("\n");
}

export function summarizeTextBlock(
  text: string,
  options: { maxLines?: number; maxCharsPerLine?: number } = {}
): string[] {
  const maxLines = options.maxLines ?? 8;
  const maxCharsPerLine = options.maxCharsPerLine ?? 100;
  const normalized = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  const lines = normalized.slice(0, maxLines).map((line) =>
    line.length > maxCharsPerLine ? `${line.slice(0, maxCharsPerLine - 1)}...` : line
  );
  if (normalized.length > maxLines) {
    lines.push(dim(`... ${normalized.length - maxLines} more line(s)`));
  }
  return lines;
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const rendered: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) {
      rendered.push(`    ${line}`);
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      rendered.push(emphasize(line.replace(/^#{1,6}\s+/, "")));
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      rendered.push(line.replace(/^\s*[-*]\s+/, "• "));
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      rendered.push(`${dim("|")} ${line.replace(/^\s*>\s?/, "")}`);
      continue;
    }

    rendered.push(
      line
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/`(.*?)`/g, "$1")
    );
  }

  return rendered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
