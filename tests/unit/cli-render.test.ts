import { describe, expect, test } from "vitest";

import { finishSpinner, newSpinner, renderMarkdown, tickSpinner } from "../../src/cli";

describe("cli render", () => {
  test("ports terminal rendering and markdown formatting behavior", async () => {
    const rendered = renderMarkdown(
      "# Heading\n\nThis is **bold** and *italic*.\n\n- item\n1. first\n   - nested\n\n> quote\n>> deeper\n\n[docs](https://example.com)\n\n~~~ts\nconst x = 1;\n~~~\n\n```diff\n+ added\n- removed\n@@ chunk @@\n```\n\n| name | value |\n| :--- | ---: |\n| a | 1 |\n| beta | 22 |\n\n`code`"
    );
    expect(rendered).toContain("Heading");
    expect(rendered).toContain("This is bold and italic.");
    expect(rendered).toContain("• item");
    expect(rendered).toContain("1. first");
    expect(rendered).toContain("   • nested");
    expect(rendered).toContain("quote");
    expect(rendered).toContain("deeper");
    expect(rendered).toContain("docs (https://example.com)");
    expect(rendered).toContain("code ts");
    expect(rendered).toContain("const x = 1;");
    expect(rendered).toContain("+ added");
    expect(rendered).toContain("- removed");
    expect(rendered).toContain("│");
    expect(rendered).toContain("beta");
    expect(rendered).toContain("code");

    const spinner = newSpinner();
    expect(tickSpinner(spinner, "Working")).toContain("Working");
    expect(finishSpinner("Done")).toBe("OK Done");
  });
});
