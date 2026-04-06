import { describe, expect, test } from "vitest";

import { cliToolDefinitionsForNames } from "../../src/cli/cli-tool-definitions";

describe("cli tool definitions", () => {
  test("maps_cli_aliases_to_api_tool_names", () => {
    const defs = cliToolDefinitionsForNames(["grep", "glob", "read_file"]);
    expect(defs.map((d) => d.name)).toEqual(["grep_search", "glob_search", "read_file"]);
  });

  test("dedupes_duplicate_cli_names_and_keeps_first_seen_order", () => {
    const defs = cliToolDefinitionsForNames(["grep", "Grep", "glob", "grep"]);
    expect(defs.map((d) => d.name)).toEqual(["grep_search", "glob_search"]);
  });

  test("includes_bash_and_write_file_with_schemas", () => {
    const defs = cliToolDefinitionsForNames(["bash", "write_file"]);
    expect(defs.map((d) => d.name)).toEqual(["bash", "write_file"]);
    expect(defs[0]!.input_schema).toMatchObject({ type: "object", required: ["command"] });
    expect(defs[1]!.input_schema).toMatchObject({ type: "object", required: ["path"] });
  });
});
