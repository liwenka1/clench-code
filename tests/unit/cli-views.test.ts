import { describe, expect, test } from "vitest";

import { stripAnsi } from "../../src/cli/render.js";
import { renderToolResultPanel } from "../../src/cli/views.js";

describe("cli views", () => {
  test("render_tool_result_panel_shows_bash_stdout_for_alias_name", () => {
    const rendered = stripAnsi(
      renderToolResultPanel(
        "Bash",
        JSON.stringify({
          command: "printf hello",
          exitCode: 0,
          stdout: "hello from tool",
          stderr: ""
        }),
        false
      )
    );

    expect(rendered).toContain("tool Bash completed");
    expect(rendered).toContain("stdout");
    expect(rendered).toContain("hello from tool");
  });

  test("render_tool_result_panel_shows_file_content_for_read_alias_name", () => {
    const rendered = stripAnsi(
      renderToolResultPanel(
        "Read",
        JSON.stringify({
          path: "package.json",
          content: "{\n  \"name\": \"clench-code\"\n}",
          total_lines: 3
        }),
        false
      )
    );

    expect(rendered).toContain("path");
    expect(rendered).toContain("package.json");
    expect(rendered).toContain("clench-code");
  });

  test("render_tool_result_panel_shows_grep_and_glob_matches", () => {
    const grep = stripAnsi(
      renderToolResultPanel(
        "grep",
        JSON.stringify({
          pattern: "foo",
          total_matches: 1,
          matches: [{ path: "src/a.ts", line_number: 7, line: "export const foo = 1;" }]
        }),
        false
      )
    );
    const glob = stripAnsi(
      renderToolResultPanel(
        "Glob",
        JSON.stringify({
          glob_pattern: "*.ts",
          total_matches: 1,
          matches: ["src/a.ts"]
        }),
        false
      )
    );

    expect(grep).toContain("matches");
    expect(grep).toContain("matched lines");
    expect(grep).toContain("src/a.ts:7: export const foo = 1;");
    expect(glob).toContain("matched paths");
    expect(glob).toContain("src/a.ts");
  });
});
