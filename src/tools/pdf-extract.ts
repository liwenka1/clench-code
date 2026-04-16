import fs from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";

export function extractPdfText(pdfPath: string): string {
  const data = fs.readFileSync(pdfPath);
  return extractPdfTextFromBytes(data);
}

export function extractPdfTextFromBytes(data: Uint8Array): string {
  let allText = "";
  let offset = 0;

  while (offset < data.length) {
    const streamStart = findSubsequence(data.subarray(offset), bytes("stream"));
    if (streamStart === -1) {
      break;
    }
    const absoluteStart = offset + streamStart;
    const contentStart = skipStreamEol(data, absoluteStart + "stream".length);
    const endRelative = findSubsequence(data.subarray(contentStart), bytes("endstream"));
    if (endRelative === -1) {
      break;
    }
    const contentEnd = contentStart + endRelative;

    const dictWindowStart = Math.max(0, absoluteStart - 512);
    const dictWindow = data.subarray(dictWindowStart, absoluteStart);
    const isFlate = findSubsequence(dictWindow, bytes("FlateDecode")) !== -1;

    const raw = data.subarray(contentStart, contentEnd);
    let streamBytes = raw;
    if (isFlate) {
      try {
        streamBytes = inflateSync(raw);
      } catch {
        offset = contentEnd;
        continue;
      }
    }

    const text = extractBtEtText(streamBytes);
    if (text) {
      allText += allText ? `\n${text}` : text;
    }

    offset = contentEnd;
  }

  return allText;
}

export function looksLikePdfPath(text: string): string | undefined {
  for (const token of text.split(/\s+/)) {
    const cleaned = token.trim().replace(/^['"`]+|['"`]+$/g, "");
    const dot = cleaned.lastIndexOf(".");
    if (dot > 0 && cleaned.slice(dot + 1).toLowerCase() === "pdf") {
      return cleaned;
    }
  }
  return undefined;
}

export function maybeExtractPdfFromPrompt(prompt: string): { path: string; text: string } | undefined {
  const pdfPath = looksLikePdfPath(prompt);
  if (!pdfPath) {
    return undefined;
  }
  const resolved = path.resolve(pdfPath);
  if (!fs.existsSync(resolved)) {
    return undefined;
  }
  const text = extractPdfText(resolved);
  if (!text) {
    return undefined;
  }
  return { path: pdfPath, text };
}

function extractBtEtText(stream: Uint8Array): string {
  const text = Buffer.from(stream).toString("utf8");
  let result = "";
  let inBt = false;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "BT") {
      inBt = true;
      continue;
    }
    if (trimmed === "ET") {
      inBt = false;
      continue;
    }
    if (!inBt) {
      continue;
    }

    if (trimmed.endsWith("Tj")) {
      const extracted = extractParenthesizedString(trimmed);
      if (extracted) {
        result += result && !result.endsWith("\n") ? ` ${extracted}` : extracted;
      }
      continue;
    }

    if (trimmed.endsWith("TJ")) {
      const extracted = extractTjArray(trimmed);
      if (extracted) {
        result += result && !result.endsWith("\n") ? ` ${extracted}` : extracted;
      }
      continue;
    }

    if (isNewlineShowOperator(trimmed)) {
      const extracted = extractParenthesizedString(trimmed);
      if (extracted) {
        result += result ? `\n${extracted}` : extracted;
      }
    }
  }

  return result;
}

function isNewlineShowOperator(trimmed: string): boolean {
  return (trimmed.endsWith("'") && trimmed.length > 1) || (trimmed.endsWith('"') && trimmed.includes("("));
}

function extractParenthesizedString(input: string): string | undefined {
  const open = input.indexOf("(");
  if (open === -1) {
    return undefined;
  }

  const chars = [...input];
  let depth = 0;
  let result = "";

  for (let index = open; index < chars.length; index += 1) {
    const ch = chars[index];
    if (ch === "(") {
      if (depth > 0) {
        result += "(";
      }
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return result;
      }
      result += ")";
      continue;
    }
    if (ch === "\\" && index + 1 < chars.length) {
      index += 1;
      const escaped = chars[index];
      if (escaped === "n") {
        result += "\n";
      } else if (escaped === "r") {
        result += "\r";
      } else if (escaped === "t") {
        result += "\t";
      } else if (escaped === "\\" || escaped === "(" || escaped === ")") {
        result += escaped;
      } else if (/[0-7]/.test(escaped)) {
        let octal = escaped;
        for (let count = 0; count < 2 && index + 1 < chars.length && /[0-7]/.test(chars[index + 1]!); count += 1) {
          index += 1;
          octal += chars[index];
        }
        result += String.fromCharCode(parseInt(octal, 8));
      } else {
        result += escaped;
      }
      continue;
    }
    result += ch;
  }

  return undefined;
}

function extractTjArray(input: string): string {
  const start = input.indexOf("[");
  const end = input.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return "";
  }

  const inner = input.slice(start + 1, end);
  let result = "";

  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] !== "(") {
      continue;
    }
    const extracted = extractParenthesizedString(inner.slice(index));
    if (!extracted) {
      continue;
    }
    result += extracted;

    let depth = 0;
    for (; index < inner.length; index += 1) {
      if (inner[index] === "(") {
        depth += 1;
      } else if (inner[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
  }

  return result;
}

function skipStreamEol(data: Uint8Array, position: number): number {
  if (position < data.length && data[position] === 13) {
    if (position + 1 < data.length && data[position + 1] === 10) {
      return position + 2;
    }
    return position + 1;
  }
  if (position < data.length && data[position] === 10) {
    return position + 1;
  }
  return position;
}

function findSubsequence(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || needle.length > haystack.length) {
    return -1;
  }
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) {
        continue outer;
      }
    }
    return start;
  }
  return -1;
}

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}
