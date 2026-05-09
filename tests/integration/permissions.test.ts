import { describe, expect, test } from "vitest";

import {
  PermissionPolicy,
  type PermissionPrompter
} from "../../src/runtime";

describe("runtime permissions integration", () => {
  test("allows_tools_when_active_mode_meets_requirement", async () => {
    const policy = new PermissionPolicy("workspace-write")
      .withToolRequirement("read_file", "read-only")
      .withToolRequirement("write_file", "workspace-write");

    expect(policy.authorize("read_file", "{}")).toEqual({ type: "allow" });
    expect(policy.authorize("write_file", "{}")).toEqual({ type: "allow" });
  });

  test("builder_methods_return_new_policy_instances", async () => {
    const base = new PermissionPolicy("read-only");
    const withWrite = base.withToolRequirement("write_file", "workspace-write");

    expect(base.requiredModeFor("write_file")).toBe("danger-full-access");
    expect(withWrite.requiredModeFor("write_file")).toBe("workspace-write");
  });

  test("denies_read_only_escalations_without_prompt", async () => {
    const policy = new PermissionPolicy("read-only")
      .withToolRequirement("write_file", "workspace-write")
      .withToolRequirement("bash", "danger-full-access");

    expect(policy.authorize("write_file", "{}")).toEqual({
      type: "deny",
      reason: "tool 'write_file' requires workspace-write permission; current mode is read-only"
    });
    expect(policy.authorize("bash", "{}")).toEqual({
      type: "deny",
      reason: "tool 'bash' requires danger-full-access permission; current mode is read-only"
    });
  });

  test("prompts_for_workspace_write_to_danger_full_access_escalation", async () => {
    class RecordingPrompter implements PermissionPrompter {
      seen: unknown[] = [];
      decide(request) {
        this.seen.push(request);
        return { type: "allow" as const };
      }
    }

    const policy = new PermissionPolicy("workspace-write").withToolRequirement(
      "bash",
      "danger-full-access"
    );
    const prompter = new RecordingPrompter();

    expect(policy.authorize("bash", "echo hi", prompter)).toEqual({ type: "allow" });
    expect(prompter.seen).toHaveLength(1);
    expect(prompter.seen[0]).toMatchObject({
      toolName: "bash",
      currentMode: "workspace-write",
      requiredMode: "danger-full-access"
    });
  });

  test("applies_rule_based_denials_and_allows", async () => {
    const policy = new PermissionPolicy("read-only")
      .withToolRequirement("bash", "danger-full-access")
      .withRules({
        allow: ["bash(git:*)"],
        deny: ["bash(rm -rf:*)"]
      });

    expect(policy.authorize("bash", '{"command":"git status"}')).toEqual({ type: "allow" });
    expect(policy.authorize("bash", '{"command":"rm -rf /tmp/x"}')).toEqual({
      type: "deny",
      reason: "Permission to use bash has been denied by rule 'bash(rm -rf:*)'"
    });
  });

  test("ask_rules_force_prompt_even_when_mode_allows", async () => {
    class RecordingPrompter implements PermissionPrompter {
      seen: unknown[] = [];
      decide(request) {
        this.seen.push(request);
        return { type: "allow" as const };
      }
    }

    const policy = new PermissionPolicy("danger-full-access")
      .withToolRequirement("bash", "danger-full-access")
      .withRules({
        ask: ["bash(git:*)"]
      });
    const prompter = new RecordingPrompter();

    expect(policy.authorize("bash", '{"command":"git status"}', prompter)).toEqual({
      type: "allow"
    });
    expect(prompter.seen).toHaveLength(1);
    expect(prompter.seen[0]).toMatchObject({
      reason: expect.stringContaining("ask rule")
    });
  });

  test("hook_deny_short_circuits_permission_flow", async () => {
    const policy = new PermissionPolicy("danger-full-access").withToolRequirement(
      "bash",
      "danger-full-access"
    );

    expect(
      policy.authorizeWithContext("bash", "{}", {
        overrideDecision: "deny",
        overrideReason: "blocked by hook"
      })
    ).toEqual({
      type: "deny",
      reason: "blocked by hook"
    });
  });
});
