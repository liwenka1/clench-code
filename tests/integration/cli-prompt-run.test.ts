import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { runPromptMode } from "../../src/cli/prompt-run";
import { withEnv } from "../helpers/envGuards";

function streamFromString(body: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  });
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

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

function totalLength(chunks: Buffer[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

describe("cli prompt run integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("run_prompt_mode_streams_assistant_text", async () => {
    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "cli_msg",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 2, output_tokens: 2 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(streamFromString(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );

    await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
      const summary = await runPromptMode({
        prompt: "Say hello",
        model: "claude-sonnet-4-6",
        permissionMode: "read-only",
        outputFormat: "text"
      });
      expect(summary.assistantMessages[0]?.blocks[0]).toMatchObject({
        type: "text",
        text: "Hello"
      });
    });
  });

  test("run_prompt_mode_chunked_sse_body_matches_single_shot", async () => {
    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "chunk_cli",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ChunkOK" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    const streamWhole = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      }
    });
    const streamChunked = new ReadableStream<Uint8Array>({
      start(controller) {
        const mid = Math.floor(sse.length / 2);
        controller.enqueue(new TextEncoder().encode(sse.slice(0, mid)));
        controller.enqueue(new TextEncoder().encode(sse.slice(mid)));
        controller.close();
      }
    });

    async function runOnce(stream: ReadableStream<Uint8Array>) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
      );
      const summary = await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () =>
        runPromptMode({
          prompt: "x",
          model: "claude-sonnet-4-6",
          permissionMode: "read-only",
          outputFormat: "text"
        })
      );
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      return summary;
    }

    const a = await runOnce(streamWhole);
    const b = await runOnce(streamChunked);
    expect(b.assistantMessages[0]?.blocks[0]).toEqual(a.assistantMessages[0]?.blocks[0]);
    expect(b.usage).toEqual(a.usage);
  });

  test("run_prompt_mode_exposes_default_workspace_tools_when_allowed_tools_is_omitted", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "default_tools",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Default tools available." }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_input, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return Promise.resolve(
          new Response(streamFromString(sse), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        );
      })
    );

    await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
      await runPromptMode({
        prompt: "hello",
        model: "claude-sonnet-4-6",
        permissionMode: "read-only",
        outputFormat: "text"
      });
    });

    expect(Array.isArray(requestBody?.tools)).toBe(true);
    expect((requestBody?.tools as Array<{ name: string }>).some((tool) => tool.name === "read_file")).toBe(true);
    expect(requestBody?.tool_choice).toEqual({ type: "auto" });
  });

  test("run_prompt_mode_injects_extracted_pdf_text_into_system_prompt", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const dir = mkdtempSync(path.join(tmpdir(), "clench-prompt-pdf-"));
    const pdfPath = path.join(dir, "report.pdf");
    writeFileSync(pdfPath, buildSimplePdf("Quarterly Results"));

    const sse =
      sseData({
        type: "message_start",
        message: {
          id: "pdf_prompt",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-7-sonnet-latest",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }) +
      sseData({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }) +
      sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Done" }
      }) +
      sseData({ type: "content_block_stop", index: 0 }) +
      sseData({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 1 }
      }) +
      sseData({ type: "message_stop" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_input, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return Promise.resolve(
          new Response(streamFromString(sse), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        );
      })
    );

    try {
      await withEnv({ ANTHROPIC_API_KEY: "test-key" }, async () => {
        await runPromptMode({
          prompt: `Summarize ${pdfPath}`,
          model: "claude-sonnet-4-6",
          permissionMode: "read-only",
          outputFormat: "text"
        });
      });

      expect(typeof requestBody?.system).toBe("string");
      expect(String(requestBody?.system)).toContain(`The user's prompt references PDF file: ${pdfPath}`);
      expect(String(requestBody?.system)).toContain("Quarterly Results");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
