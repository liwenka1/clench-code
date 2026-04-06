import { describe, expect, test } from "vitest";

import { messageTotalTokens, totalTokens } from "../../src/api";

describe("api types", () => {
  test("ports API type normalization behavior", async () => {
    const usage = {
      input_tokens: 10,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 4
    };

    expect(totalTokens(usage)).toBe(19);
    expect(
      messageTotalTokens({
        id: "msg_cost",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage
      })
    ).toBe(19);

    expect(
      JSON.stringify({
        type: "input_json_delta",
        partial_json: "{\"city\":\"Paris\"}"
      })
    ).toBe('{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Paris\\"}"}');
  });
});
