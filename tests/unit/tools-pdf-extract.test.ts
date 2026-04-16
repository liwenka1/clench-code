import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";

import { expect, test } from "vitest";

import {
  extractPdfText,
  extractPdfTextFromBytes,
  looksLikePdfPath,
  maybeExtractPdfFromPrompt
} from "../../src/tools/pdf-extract.js";

function buildSimplePdf(text: string): Buffer {
  const contentStream = `BT\n/F1 12 Tf\n(${text}) Tj\nET`;
  const streamBytes = Buffer.from(contentStream, "utf8");
  const chunks: Buffer[] = [];

  chunks.push(Buffer.from("%PDF-1.4\n", "utf8"));
  const obj1Offset = totalLength(chunks);
  chunks.push(Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "utf8"));
  const obj2Offset = totalLength(chunks);
  chunks.push(Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n", "utf8"));
  const obj3Offset = totalLength(chunks);
  chunks.push(Buffer.from("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n", "utf8"));
  const obj4Offset = totalLength(chunks);
  chunks.push(Buffer.from(`4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n`, "utf8"));
  chunks.push(streamBytes);
  chunks.push(Buffer.from("\nendstream\nendobj\n", "utf8"));
  const xrefOffset = totalLength(chunks);
  chunks.push(Buffer.from("xref\n0 5\n", "utf8"));
  chunks.push(Buffer.from("0000000000 65535 f \n", "utf8"));
  chunks.push(Buffer.from(`${String(obj1Offset).padStart(10, "0")} 00000 n \n`, "utf8"));
  chunks.push(Buffer.from(`${String(obj2Offset).padStart(10, "0")} 00000 n \n`, "utf8"));
  chunks.push(Buffer.from(`${String(obj3Offset).padStart(10, "0")} 00000 n \n`, "utf8"));
  chunks.push(Buffer.from(`${String(obj4Offset).padStart(10, "0")} 00000 n \n`, "utf8"));
  chunks.push(Buffer.from("trailer\n<< /Size 5 /Root 1 0 R >>\n", "utf8"));
  chunks.push(Buffer.from(`startxref\n${xrefOffset}\n%%EOF\n`, "utf8"));
  return Buffer.concat(chunks);
}

function buildFlatePdf(text: string): Buffer {
  const compressed = deflateSync(Buffer.from(`BT\n/F1 12 Tf\n(${text}) Tj\nET`, "utf8"));
  const chunks: Buffer[] = [];

  chunks.push(Buffer.from("%PDF-1.4\n", "utf8"));
  const obj1Offset = totalLength(chunks);
  chunks.push(Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "utf8"));
  const obj2Offset = totalLength(chunks);
  chunks.push(Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n", "utf8"));
  const obj3Offset = totalLength(chunks);
  chunks.push(Buffer.from("3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n", "utf8"));
  const obj4Offset = totalLength(chunks);
  chunks.push(Buffer.from(`4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, "utf8"));
  chunks.push(compressed);
  chunks.push(Buffer.from("\nendstream\nendobj\n", "utf8"));
  const xrefOffset = totalLength(chunks);
  chunks.push(Buffer.from("xref\n0 5\n", "utf8"));
  chunks.push(Buffer.from("0000000000 65535 f \n", "utf8"));
  chunks.push(Buffer.from(`${String(obj1Offset).padStart(10, "0")} 00000 n \n`, "utf8"));
  chunks.push(Buffer.from(`${String(obj2Offset).padStart(10, "0")} 00000 n \n`, "utf8"));
  chunks.push(Buffer.from(`${String(obj3Offset).padStart(10, "0")} 00000 n \n`, "utf8"));
  chunks.push(Buffer.from(`${String(obj4Offset).padStart(10, "0")} 00000 n \n`, "utf8"));
  chunks.push(Buffer.from("trailer\n<< /Size 5 /Root 1 0 R >>\n", "utf8"));
  chunks.push(Buffer.from(`startxref\n${xrefOffset}\n%%EOF\n`, "utf8"));
  return Buffer.concat(chunks);
}

function totalLength(chunks: Buffer[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

test("extracts uncompressed text from minimal pdf", () => {
  expect(extractPdfTextFromBytes(buildSimplePdf("Hello World"))).toBe("Hello World");
});

test("extracts text from flate compressed stream", () => {
  expect(extractPdfTextFromBytes(buildFlatePdf("Compressed PDF Text"))).toBe("Compressed PDF Text");
});

test("handles tj array operator", () => {
  const raw = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n2 0 obj\n<< /Length 38 >>\nstream\nBT\n/F1 12 Tf\n[ (Hello) -120 ( World) ] TJ\nET\nendstream\nendobj\n%%EOF\n",
    "utf8"
  );
  expect(extractPdfTextFromBytes(raw)).toBe("Hello World");
});

test("handles escaped parentheses", () => {
  const raw = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Length 27 >>\nstream\nBT\n(Hello \\(World\\)) Tj\nET\nendstream\nendobj\n%%EOF\n",
    "utf8"
  );
  expect(extractPdfTextFromBytes(raw)).toBe("Hello (World)");
});

test("returns empty for non pdf data", () => {
  expect(extractPdfTextFromBytes(Buffer.from("This is not a PDF file at all", "utf8"))).toBe("");
});

test("extracts text from file on disk", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "clench-pdf-extract-"));
  const pdfPath = path.join(dir, "test.pdf");
  fs.writeFileSync(pdfPath, buildSimplePdf("Disk Test"));

  try {
    expect(extractPdfText(pdfPath)).toBe("Disk Test");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("looks like pdf path detects pdf references", () => {
  expect(looksLikePdfPath("Please read /tmp/report.pdf")).toBe("/tmp/report.pdf");
  expect(looksLikePdfPath("Check file.PDF now")).toBe("file.PDF");
  expect(looksLikePdfPath("no pdf here")).toBeUndefined();
});

test("maybe extract pdf from prompt returns none for missing file", () => {
  expect(maybeExtractPdfFromPrompt("Read /tmp/nonexistent-abc123.pdf please")).toBeUndefined();
});

test("maybe extract pdf from prompt extracts existing file", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "clench-pdf-auto-extract-"));
  const pdfPath = path.join(dir, "auto.pdf");
  fs.writeFileSync(pdfPath, buildSimplePdf("Auto Extracted"));

  try {
    expect(maybeExtractPdfFromPrompt(`Summarize ${pdfPath}`)).toEqual({
      path: pdfPath,
      text: "Auto Extracted"
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
