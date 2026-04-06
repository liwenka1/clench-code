import { describe, expect, test } from "vitest";

import {
  checkDestructive,
  classifyCommand,
  validateCommand,
  validateMode,
  validatePaths,
  validateReadOnly,
  validateSed
} from "../../src/runtime";

describe("runtime bash validation", () => {
  test("ports bash validation logic", async () => {
    expect(validateReadOnly("rm -rf /tmp/x", "read-only")).toMatchObject({
      type: "block"
    });
    expect(validateReadOnly("git status", "read-only")).toEqual({ type: "allow" });
    expect(validateMode("cp file.txt /etc/config", "workspace-write")).toMatchObject({
      type: "warn"
    });
    expect(validateSed("sed -i 's/old/new/' file.txt", "read-only")).toMatchObject({
      type: "block"
    });
    expect(checkDestructive("rm -rf /")).toMatchObject({ type: "warn" });
    expect(validatePaths("cat ../../../etc/passwd")).toMatchObject({ type: "warn" });
    expect(classifyCommand("curl https://example.com")).toBe("network");
    expect(classifyCommand("git push origin main")).toBe("write");
    expect(validateCommand("ls -la", "read-only")).toEqual({ type: "allow" });
  });
});
