import { describe, expect, test } from "vitest";

import { parseJson, prettyJson, renderJson } from "../../src/runtime";

describe("runtime json", () => {
  test("ports runtime JSON helper behavior", async () => {
    const rendered = renderJson({
      flag: true,
      items: [4, "ok"]
    });
    const parsed = parseJson(rendered);

    expect(parsed).toEqual({
      flag: true,
      items: [4, "ok"]
    });
    expect(prettyJson(parsed)).toContain('\n  "flag": true');
  });
});
