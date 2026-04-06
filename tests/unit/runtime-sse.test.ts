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
});
