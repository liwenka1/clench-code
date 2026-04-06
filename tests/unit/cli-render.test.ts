import { describe, expect, test } from "vitest";

import { finishSpinner, newSpinner, renderMarkdown, tickSpinner } from "../../src/cli";

describe("cli render", () => {
  test("ports terminal rendering and markdown formatting behavior", async () => {
    const rendered = renderMarkdown("# Heading\n\nThis is **bold** and *italic*.\n\n- item\n\n`code`");
    expect(rendered).toContain("Heading");
    expect(rendered).toContain("This is bold and italic.");
    expect(rendered).toContain("• item");
    expect(rendered).toContain("code");

    const spinner = newSpinner();
    expect(tickSpinner(spinner, "Working")).toContain("Working");
    expect(finishSpinner("Done")).toBe("OK Done");
  });
});
