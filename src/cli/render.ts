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
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = line.trim().match(/^(`{3,}|~{3,})([\w-]*)\s*$/);
    if (fence) {
      const marker = fence[1]!;
      const language = fence[2]?.trim();
      const codeLines: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !new RegExp(`^\\s*${escapeRegex(marker[0]!)}{${marker.length},}\\s*$`).test(lines[index]!.trim())
      ) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      rendered.push(renderCodeBlock(language, codeLines));
      continue;
    }
    if (isTableStart(lines, index)) {
      const { output, consumed } = renderTable(lines, index);
      rendered.push(output);
      index += consumed - 1;
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      rendered.push(emphasize(line.replace(/^#{1,6}\s+/, "")));
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      rendered.push(renderListItem(line, "ordered"));
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      rendered.push(renderListItem(line, "unordered"));
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      rendered.push(renderBlockQuote(line));
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      rendered.push(dim("-".repeat(24)));
      continue;
    }

    rendered.push(normalizeInlineMarkdown(line));
  }

  return rendered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function normalizeInlineMarkdown(line: string): string {
  return line
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`(.*?)`/g, (_match, code) => colorize(code, "success"));
}

function renderCodeBlock(language: string | undefined, codeLines: string[]): string {
  return renderPanel(
    language ? `code ${language}` : "code",
    codeLines.length > 0 ? codeLines.map((line) => highlightCodeLine(line || " ", language)) : [dim("empty")],
    { tone: "neutral" }
  );
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  const separator = lines[index + 1];
  return Boolean(
    header &&
    separator &&
    header.includes("|") &&
    separator.includes("|") &&
    splitTableRow(separator).every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

function renderTable(lines: string[], startIndex: number): { output: string; consumed: number } {
  const rows: string[][] = [];
  let index = startIndex;
  while (index < lines.length && lines[index]!.includes("|")) {
    rows.push(splitTableRow(lines[index]!));
    index += 1;
    if (rows.length > 1 && rows.at(-1)?.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      continue;
    }
    if (index < lines.length && !lines[index]!.includes("|")) {
      break;
    }
  }
  const header = rows[0] ?? [];
  const separator = rows[1] ?? [];
  const body = rows.slice(2);
  const columnCount = Math.max(header.length, ...body.map((row) => row.length), 0);
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(visibleWidth(header[column] ?? ""), ...body.map((row) => visibleWidth(row[column] ?? "")), 3)
  );
  const alignments = separator.map(parseTableAlignment);
  const border = dim(`│${widths.map((width) => "─".repeat(width + 2)).join("┼")}│`);
  const formatRow = (row: string[], isHeader = false) =>
    `│${widths.map((width, column) => ` ${alignTableCell(row[column] ?? "", width, alignments[column], isHeader)} `).join("│")}│`;
  return {
    output: [
      formatRow(header, true),
      border,
      ...body.map((row) => formatRow(row))
    ].join("\n"),
    consumed: rows.length
  };
}

function splitTableRow(line: string): string[] {
  const normalized = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return normalized.split("|").map((cell) => cell.trim());
}

function highlightCodeLine(line: string, language: string | undefined): string {
  const lang = language?.toLowerCase() ?? "";
  if (lang === "diff" || lang === "patch") {
    if (/^\+\+\+|^---/.test(line)) {
      return colorize(line, "info");
    }
    if (/^@@/.test(line)) {
      return colorize(line, "warning");
    }
    if (line.startsWith("+")) {
      return colorize(line, "success");
    }
    if (line.startsWith("-")) {
      return colorize(line, "error");
    }
    return line;
  }
  if (lang === "json") {
    return line
      .replace(/"([^"]+)"(?=\s*:)/g, (_match, key) => colorize(`"${key}"`, "info"))
      .replace(/:\s*"([^"]*)"/g, (_match, value) => `: ${colorize(`"${value}"`, "success")}`)
      .replace(/\b(true|false|null)\b/g, (keyword) => colorize(keyword, "warning"))
      .replace(/\b-?\d+(\.\d+)?\b/g, (num) => colorize(num, "warning"));
  }
  if (lang === "ts" || lang === "tsx" || lang === "js" || lang === "jsx") {
    return line
      .replace(/\b(import|from|export|const|let|var|function|return|if|else|await|async|class|new|throw|try|catch)\b/g, (keyword) =>
        colorize(keyword, "info")
      )
      .replace(/\b(true|false|null|undefined)\b/g, (keyword) => colorize(keyword, "warning"))
      .replace(/"([^"]*)"|'([^']*)'/g, (literal) => colorize(literal, "success"))
      .replace(/\b\d+(\.\d+)?\b/g, (num) => colorize(num, "warning"));
  }
  if (lang === "sh" || lang === "bash" || lang === "shell" || lang === "zsh") {
    return line
      .replace(/\b(if|then|else|fi|for|do|done|case|esac|while|in|function)\b/g, (keyword) =>
        colorize(keyword, "info")
      )
      .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, (variable) => colorize(variable, "warning"))
      .replace(/"([^"]*)"|'([^']*)'/g, (literal) => colorize(literal, "success"))
      .replace(/(^|\s)(#[^#].*)$/g, (_match, prefix, comment) => `${prefix}${dim(comment)}`);
  }
  return line;
}

function renderListItem(line: string, kind: "ordered" | "unordered"): string {
  const leadingSpaces = line.match(/^\s*/)?.[0].length ?? 0;
  const indent = " ".repeat(leadingSpaces);
  if (kind === "ordered") {
    return `${indent}${normalizeInlineMarkdown(line.trimStart())}`;
  }
  return `${indent}${normalizeInlineMarkdown(line.trimStart().replace(/^[-*]\s+/, "• "))}`;
}

function renderBlockQuote(line: string): string {
  const matches = line.match(/^\s*(>\s*)+/)?.[0] ?? ">";
  const depth = (matches.match(/>/g) ?? []).length;
  const content = normalizeInlineMarkdown(line.replace(/^\s*(>\s*)+/, ""));
  return `${dim("│ ".repeat(depth))}${content}`;
}

function parseTableAlignment(cell: string | undefined): "left" | "center" | "right" {
  const value = cell?.trim() ?? "";
  if (value.startsWith(":") && value.endsWith(":")) {
    return "center";
  }
  if (value.endsWith(":")) {
    return "right";
  }
  return "left";
}

function alignTableCell(
  cell: string,
  width: number,
  alignment: "left" | "center" | "right" = "left",
  isHeader = false
): string {
  const visible = visibleWidth(cell);
  const plain = isHeader ? emphasize(normalizeInlineMarkdown(cell)) : normalizeInlineMarkdown(cell);
  const padding = Math.max(0, width - visible);
  if (alignment === "right") {
    return `${" ".repeat(padding)}${plain}`;
  }
  if (alignment === "center") {
    const left = Math.floor(padding / 2);
    const right = padding - left;
    return `${" ".repeat(left)}${plain}${" ".repeat(right)}`;
  }
  return `${plain}${" ".repeat(padding)}`;
}

function visibleWidth(text: string): number {
  return stripAnsi(normalizeInlineMarkdown(text)).length;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
