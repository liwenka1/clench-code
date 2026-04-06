import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  editFileText,
  globSearch,
  grepSearch,
  isSymlinkEscape,
  readFileInWorkspace,
  readFileText,
  writeFileText
} from "../../src/runtime/file-ops.js";

describe("runtime file ops", () => {
  test("ports file operation helper behavior", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-file-ops-"));
    const filePath = path.join(root, "nested", "demo.txt");
    const otherPath = path.join(root, "nested", "other.rs");
    const outsidePath = path.join(os.tmpdir(), `outside-${Date.now()}.txt`);

    const created = writeFileText(filePath, "one\ntwo\nthree");
    writeFileText(otherPath, "fn main() {\n println!(\"hello\");\n}\n");

    expect(created.type).toBe("create");
    expect(readFileText(filePath, 1, 1).content).toBe("two");
    expect(editFileText(filePath, "one", "omega", false).originalFile).toContain("one");
    expect(readFileText(filePath).content).toContain("omega");
    expect(globSearch("**/*.rs", root).numFiles).toBe(1);
    expect(grepSearch("hello", root, "content").content).toContain("hello");
    expect(grepSearch("hello", root, "count").numMatches).toBe(1);
    expect(readFileInWorkspace(filePath, root).content).toContain("omega");

    fs.writeFileSync(outsidePath, "unsafe", "utf8");
    expect(() => readFileInWorkspace(outsidePath, root)).toThrow("escapes workspace boundary");

    const linkPath = path.join(root, "escape-link.txt");
    if (process.platform !== "win32") {
      fs.symlinkSync(outsidePath, linkPath);
      expect(isSymlinkEscape(linkPath, root)).toBe(true);
    }

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsidePath, { force: true });
  });
});
