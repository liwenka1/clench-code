import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { listActiveSkillNames, resolveSkillsCommand } from "../../src/cli/skills";
import { createTempWorkspace, type TempWorkspace } from "../helpers/tempWorkspace";

const workspaces: TempWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0, workspaces.length).map((workspace) => workspace.cleanup()));
});

describe("cli skills", () => {
  test("resolveSkillsCommand_returns_skill_invocation_with_prompt_injection", async () => {
    const workspace = await createTempWorkspace("clench-skills-unit-");
    workspaces.push(workspace);

    const skillDir = path.join(workspace.root, ".claw", "skills", "reviewer");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: reviewer",
        "description: Review risky changes",
        "---",
        "",
        "# Reviewer",
        "Focus on correctness and regressions."
      ].join("\n"),
      "utf8"
    );

    const resolved = resolveSkillsCommand(workspace.root, ["reviewer", "audit", "auth", "flow"]);

    expect(resolved.kind).toBe("invoke");
    if (resolved.kind !== "invoke") {
      return;
    }
    expect(resolved.invocation.skillName).toBe("reviewer");
    expect(resolved.invocation.prompt).toBe("audit auth flow");
    expect(resolved.invocation.systemPrompt).toContain("# Active skill");
    expect(resolved.invocation.systemPrompt).toContain("Review risky changes");
    expect(resolved.invocation.systemPrompt).toContain("Focus on correctness and regressions.");
  });

  test("resolveSkillsCommand_unknown_skill_lists_available_names", async () => {
    const workspace = await createTempWorkspace("clench-skills-unknown-");
    workspaces.push(workspace);

    const skillDir = path.join(workspace.root, ".claw", "skills", "helper");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Helper\n", "utf8");

    expect(() => resolveSkillsCommand(workspace.root, ["missing"])).toThrowError(/Available skills: helper/);
  });

  test("resolveSkillsCommand_supports_legacy_commands_roots", async () => {
    const workspace = await createTempWorkspace("clench-skills-legacy-");
    workspaces.push(workspace);

    const commandsDir = path.join(workspace.root, ".claude", "commands");
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(commandsDir, "trace.md"),
      [
        "---",
        "description: Trace execution paths",
        "---",
        "",
        "# Trace",
        "Follow the critical path."
      ].join("\n"),
      "utf8"
    );

    const resolved = resolveSkillsCommand(workspace.root, ["trace"]);
    expect(resolved.kind).toBe("invoke");
    if (resolved.kind !== "invoke") {
      return;
    }
    expect(resolved.invocation.displayName).toBe("trace");
    expect(resolved.invocation.systemPrompt).toContain("Trace execution paths");
    expect(resolved.invocation.systemPrompt).toContain("Follow the critical path.");
  });

  test("listActiveSkillNames_includes_omc_learned_roots", async () => {
    const workspace = await createTempWorkspace("clench-skills-learned-");
    workspaces.push(workspace);

    const learnedRoot = path.join(workspace.root, ".claude-config");
    const learnedDir = path.join(learnedRoot, "skills", "omc-learned", "learned");
    fs.mkdirSync(learnedDir, { recursive: true });
    fs.writeFileSync(path.join(learnedDir, "SKILL.md"), "# Learned\n", "utf8");

    const original = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = learnedRoot;
    try {
      expect(listActiveSkillNames(workspace.root)).toContain("learned");
    } finally {
      if (original === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = original;
      }
    }
  });
});
