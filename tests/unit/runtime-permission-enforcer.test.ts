import { describe, expect, test } from "vitest";

import { PermissionPolicy, validateMode, validateReadOnly } from "../../src/runtime";

describe("runtime permission enforcer", () => {
  test("allow_mode_permits_everything", async () => {
    const policy = new PermissionPolicy("allow")
      .withToolRequirement("write_file", "workspace-write")
      .withToolRequirement("bash", "danger-full-access");

    expect(policy.authorize("write_file", "{}")).toEqual({ type: "allow" });
    expect(policy.authorize("bash", '{"command":"rm -rf /tmp/x"}')).toEqual({ type: "allow" });
  });

  test("read_only_denies_writes", async () => {
    const policy = new PermissionPolicy("read-only").withToolRequirement(
      "write_file",
      "workspace-write"
    );

    expect(policy.authorize("write_file", '{"path":"file.txt"}')).toEqual({
      type: "deny",
      reason: "tool 'write_file' requires workspace-write permission; current mode is read-only"
    });
  });

  test("read_only_allows_read_commands", async () => {
    expect(validateReadOnly("git status", "read-only")).toEqual({ type: "allow" });
    expect(validateReadOnly("cat package.json", "read-only")).toEqual({ type: "allow" });
  });

  test("workspace_write_allows_within_workspace", async () => {
    expect(validateMode("cp file.txt ./backup", "workspace-write")).toEqual({ type: "allow" });
  });

  test("workspace_write_denies_outside_workspace", async () => {
    expect(validateMode("cp file.txt /etc/config", "workspace-write")).toMatchObject({
      type: "warn"
    });
  });

  test("danger_full_access_permits_file_writes_and_bash", async () => {
    const policy = new PermissionPolicy("danger-full-access")
      .withToolRequirement("write_file", "workspace-write")
      .withToolRequirement("bash", "danger-full-access");

    expect(policy.authorize("write_file", '{"path":"file.txt"}')).toEqual({ type: "allow" });
    expect(policy.authorize("bash", '{"command":"rm -rf /tmp/x"}')).toEqual({ type: "allow" });
  });

  test("bash_heuristic_redirects_block_read_only_commands", async () => {
    expect(validateReadOnly("echo hello > file.txt", "read-only")).toMatchObject({
      type: "block"
    });
  });
});
