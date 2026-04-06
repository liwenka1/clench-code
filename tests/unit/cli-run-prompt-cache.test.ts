import { describe, expect, test } from "vitest";

import { promptCacheOptionsForSession } from "../../src/cli/run";

describe("cli run prompt cache helpers", () => {
  test("prompt_cache_options_for_session_maps_resumed_session_id", () => {
    expect(promptCacheOptionsForSession(undefined)).toEqual({});
    expect(promptCacheOptionsForSession({ path: "/a", sessionId: "", messages: [] })).toEqual({});
    expect(
      promptCacheOptionsForSession({ path: "/a", sessionId: "  my-session  ", messages: [] })
    ).toEqual({ promptCacheSessionId: "my-session" });
  });
});
