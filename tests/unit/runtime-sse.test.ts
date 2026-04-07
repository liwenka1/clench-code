import { describe, expect, test } from "vitest";

import { IncrementalSseParser } from "../../src/runtime/sse.js";

describe("runtime sse", () => {
  test("ports runtime SSE parsing and stream handling behavior", async () => {
    const parser = new IncrementalSseParser();

    expect(parser.pushChunk("event: message\ndata: hel")).toEqual([]);
    expect(parser.pushChunk("lo\n\nid: 1\ndata: world\n\n")).toEqual([
      {
        event: "message",
        data: "hello",
        id: undefined,
        retry: undefined
      },
      {
        event: undefined,
        data: "world",
        id: "1",
        retry: undefined
      }
    ]);

    const trailing = new IncrementalSseParser();
    trailing.pushChunk("event: message\ndata: trailing");
    expect(trailing.finish()).toEqual([
      {
        event: "message",
        data: "trailing",
        id: undefined,
        retry: undefined
      }
    ]);
  });

  test("parses_retry_field_and_joins_multiple_data_lines", () => {
    const parser = new IncrementalSseParser();
    expect(
      parser.pushChunk("retry: 3000\nevent: msg\ndata: line1\ndata: line2\n\n")
    ).toEqual([
      {
        event: "msg",
        data: "line1\nline2",
        id: undefined,
        retry: 3000
      }
    ]);
  });

  test("ignores_comment_lines_and_non_finite_retry", () => {
    const parser = new IncrementalSseParser();
    expect(
      parser.pushChunk(": keepalive\nevent: e\ndata: x\nretry: not-a-number\ndata: after\n\n")
    ).toEqual([
      {
        event: "e",
        data: "x\nafter",
        id: undefined,
        retry: undefined
      }
    ]);
  });
});
