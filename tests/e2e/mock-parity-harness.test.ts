import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import {
  ConversationRuntime,
  PermissionPolicy,
  Session,
  StaticToolExecutor,
  estimateCostUsd,
  formatUsd,
  type AssistantEvent,
  type PermissionMode,
  type PermissionPrompter,
  type RuntimeApiClient
} from "../../src/runtime/index.js";
import { createTempWorkspace } from "../helpers/tempWorkspace.js";

interface ParityScenario {
  name: string;
  category: string;
  description: string;
  parity_refs: string[];
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const scenarioPath = join(repoRoot, "clench-migration/parity-scenarios.json");
const scenarios = JSON.parse(readFileSync(scenarioPath, "utf8")) as ParityScenario[];
const pendingCleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  const cleanups = [...pendingCleanups];
  pendingCleanups.clear();
  await Promise.all(cleanups.map(async (cleanup) => await cleanup()));
});

describe("mock parity harness manifest", () => {
  test("keeps the canonical scenario count", () => {
    expect(scenarios).toHaveLength(12);
  });

  test("scenario names remain unique", () => {
    const uniqueNames = new Set(scenarios.map((scenario) => scenario.name));
    expect(uniqueNames.size).toBe(scenarios.length);
  });

  test("port parity scenario: streaming_text", async () => {
    const run = await runScenario({
      scripts: [[text("Mock streaming says hello from the parity harness."), stop()]]
    });

    expect(run.summary.iterations).toBe(1);
    expect(run.summary.assistantMessages[0]?.blocks[0]).toEqual({
      type: "text",
      text: "Mock streaming says hello from the parity harness."
    });
  });

  test("port parity scenario: read_file_roundtrip", async () => {
    const run = await runScenario({
      setup: async (root) => {
        await writeFile(join(root, "fixture.txt"), "alpha parity line\n", "utf8");
      },
      scripts: [
        [tool("tool-1", "read_file", JSON.stringify({ path: "fixture.txt" })), stop()],
        [text("I read alpha parity line from the fixture."), stop()]
      ],
      permissionMode: "read-only",
      toolRequirements: { read_file: "read-only" }
    });

    expect(run.summary.iterations).toBe(2);
    expect(toolResultText(run, 0)).toContain("alpha parity line");
    expect(lastAssistantText(run)).toContain("alpha parity line");
  });

  test("port parity scenario: grep_chunk_assembly", async () => {
    const run = await runScenario({
      setup: async (root) => {
        await writeFile(join(root, "fixture.txt"), "alpha parity line\nbeta line\ngamma parity line\n", "utf8");
      },
      scripts: [
        [tool("tool-1", "grep_search", JSON.stringify({ pattern: "parity", path: "fixture.txt", output_mode: "count" })), stop()],
        [text("I found 2 occurrences of parity in the fixture."), stop()]
      ],
      permissionMode: "read-only",
      toolRequirements: { grep_search: "read-only" }
    });

    expect(run.summary.iterations).toBe(2);
    expect(toolResultText(run, 0)).toContain("2");
    expect(lastAssistantText(run)).toContain("2 occurrences");
  });

  test("port parity scenario: write_file_allowed", async () => {
    const run = await runScenario({
      scripts: [
        [tool("tool-1", "write_file", JSON.stringify({ path: "generated/output.txt", content: "created by mock service\n" })), stop()],
        [text("I wrote generated/output.txt successfully."), stop()]
      ],
      permissionMode: "workspace-write",
      toolRequirements: { write_file: "workspace-write" }
    });

    expect(run.summary.iterations).toBe(2);
    expect(await readFile(join(run.workspace.root, "generated/output.txt"), "utf8")).toBe("created by mock service\n");
    expect(lastAssistantText(run)).toContain("generated/output.txt");
  });

  test("port parity scenario: write_file_denied", async () => {
    const run = await runScenario({
      scripts: [
        [tool("tool-1", "write_file", JSON.stringify({ path: "generated/denied.txt", content: "nope\n" })), stop()],
        [text("The write was denied as expected."), stop()]
      ],
      permissionMode: "read-only",
      toolRequirements: { write_file: "workspace-write" }
    });

    expect(run.summary.iterations).toBe(2);
    expect(toolResultBlock(run, 0)?.is_error).toBe(true);
    expect(toolResultText(run, 0)).toContain("requires workspace-write permission");
    expect(lastAssistantText(run)).toContain("denied as expected");
  });

  test("port parity scenario: multi_tool_turn_roundtrip", async () => {
    const run = await runScenario({
      setup: async (root) => {
        await writeFile(join(root, "fixture.txt"), "alpha parity line\nbeta line\ngamma parity line\n", "utf8");
      },
      scripts: [
        [
          tool("tool-1", "read_file", JSON.stringify({ path: "fixture.txt" })),
          tool("tool-2", "grep_search", JSON.stringify({ pattern: "parity", path: "fixture.txt", output_mode: "count" })),
          stop()
        ],
        [text("The file includes alpha parity line and 2 occurrences of parity."), stop()]
      ],
      permissionMode: "read-only",
      toolRequirements: { read_file: "read-only", grep_search: "read-only" }
    });

    expect(run.summary.iterations).toBe(2);
    expect(run.summary.toolResults).toHaveLength(2);
    expect(lastAssistantText(run)).toContain("alpha parity line");
    expect(lastAssistantText(run)).toContain("2 occurrences");
  });

  test("port parity scenario: bash_stdout_roundtrip", async () => {
    const run = await runScenario({
      scripts: [
        [tool("tool-1", "bash", JSON.stringify({ command: "echo alpha from bash" })), stop()],
        [text("Bash returned alpha from bash."), stop()]
      ],
      permissionMode: "danger-full-access",
      toolRequirements: { bash: "danger-full-access" }
    });

    expect(run.summary.iterations).toBe(2);
    expect(toolResultText(run, 0)).toContain("alpha from bash");
    expect(lastAssistantText(run)).toContain("alpha from bash");
  });

  test("port parity scenario: bash_permission_prompt_approved", async () => {
    const run = await runScenario({
      scripts: [
        [tool("tool-1", "bash", JSON.stringify({ command: "echo approved via prompt" })), stop()],
        [text("The bash command was approved and executed."), stop()]
      ],
      permissionMode: "workspace-write",
      toolRequirements: { bash: "danger-full-access" },
      prompter: new StaticPrompter(true)
    });

    expect(run.summary.iterations).toBe(2);
    expect(toolResultBlock(run, 0)?.is_error).toBe(false);
    expect(toolResultText(run, 0)).toContain("approved via prompt");
    expect(lastAssistantText(run)).toContain("approved and executed");
  });

  test("port parity scenario: bash_permission_prompt_denied", async () => {
    const run = await runScenario({
      scripts: [
        [tool("tool-1", "bash", JSON.stringify({ command: "echo denied via prompt" })), stop()],
        [text("The bash command was denied as expected."), stop()]
      ],
      permissionMode: "workspace-write",
      toolRequirements: { bash: "danger-full-access" },
      prompter: new StaticPrompter(false)
    });

    expect(run.summary.iterations).toBe(2);
    expect(toolResultBlock(run, 0)?.is_error).toBe(true);
    expect(toolResultText(run, 0)).toContain("denied by user approval prompt");
    expect(lastAssistantText(run)).toContain("denied as expected");
  });

  test("port parity scenario: plugin_tool_roundtrip", async () => {
    const run = await runScenario({
      scripts: [
        [tool("tool-1", "plugin_echo", JSON.stringify({ message: "hello from plugin parity" })), stop()],
        [text("The plugin echoed hello from plugin parity."), stop()]
      ],
      permissionMode: "workspace-write",
      toolRequirements: { plugin_echo: "workspace-write" }
    });

    expect(run.summary.iterations).toBe(2);
    expect(toolResultText(run, 0)).toContain("parity-plugin@external");
    expect(toolResultText(run, 0)).toContain("hello from plugin parity");
    expect(lastAssistantText(run)).toContain("hello from plugin parity");
  });

  test("port parity scenario: auto_compact_triggered", async () => {
    const run = await runScenario({
      session: new Session("auto", [
        { role: "user", blocks: [{ type: "text", text: "one" }] },
        { role: "assistant", blocks: [{ type: "text", text: "two" }] },
        { role: "user", blocks: [{ type: "text", text: "three" }] },
        { role: "assistant", blocks: [{ type: "text", text: "four" }] }
      ]),
      scripts: [[text("auto compact parity complete."), usage(120_000, 4), stop()]],
      autoCompactionInputTokensThreshold: 100_000
    });

    expect(run.summary.iterations).toBe(1);
    expect(run.summary.autoCompaction).toEqual({ removedMessageCount: 2 });
    expect(run.runtime.session().messages[0]?.role).toBe("system");
    expect(lastAssistantText(run)).toContain("auto compact parity complete.");
  });

  test("port parity scenario: token_cost_reporting", async () => {
    const run = await runScenario({
      scripts: [[text("token cost reporting parity complete."), usage(2_000, 500, 100, 50), stop()]]
    });

    const estimated = formatUsd(estimateCostUsd(run.summary.usage).totalCostUsd);
    expect(run.summary.iterations).toBe(1);
    expect(run.summary.usage.input_tokens).toBeGreaterThan(0);
    expect(run.summary.usage.output_tokens).toBeGreaterThan(0);
    expect(estimated.startsWith("$")).toBe(true);
    expect(lastAssistantText(run)).toContain("token cost reporting parity complete.");
  });
});

class ScriptedApiClient implements RuntimeApiClient {
  private callIndex = 0;

  constructor(private readonly scripts: AssistantEvent[][]) {}

  stream(): AssistantEvent[] {
    const script = this.scripts[this.callIndex] ?? this.scripts[this.scripts.length - 1] ?? [stop()];
    this.callIndex += 1;
    return script;
  }
}

class StaticPrompter implements PermissionPrompter {
  constructor(private readonly allow: boolean) {}

  decide() {
    return this.allow ? { type: "allow" as const } : { type: "deny" as const, reason: "denied by user approval prompt" };
  }
}

async function runScenario(options: {
  scripts: AssistantEvent[][];
  setup?: (root: string) => Promise<void>;
  session?: Session;
  permissionMode?: PermissionMode;
  toolRequirements?: Record<string, PermissionMode>;
  autoCompactionInputTokensThreshold?: number;
  prompter?: PermissionPrompter;
}) {
  const workspace = await createTempWorkspace("mock-parity-");
  pendingCleanups.add(workspace.cleanup);

  await options.setup?.(workspace.root);

  const executor = new StaticToolExecutor()
    .register("read_file", async (input) => {
      const parsed = JSON.parse(input) as { path: string };
      return await readFile(join(workspace.root, parsed.path), "utf8");
    })
    .register("grep_search", async (input) => {
      const parsed = JSON.parse(input) as { pattern: string; path: string; output_mode?: string };
      const contents = await readFile(join(workspace.root, parsed.path), "utf8");
      const matches = contents.match(new RegExp(parsed.pattern, "g")) ?? [];
      return parsed.output_mode === "count" ? String(matches.length) : matches.join("\n");
    })
    .register("write_file", async (input) => {
      const parsed = JSON.parse(input) as { path: string; content: string };
      const target = join(workspace.root, parsed.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, parsed.content, "utf8");
      return target;
    })
    .register("bash", async (input) => {
      const parsed = JSON.parse(input) as { command: string };
      const stdout = parsed.command.replace(/^echo\s+/, "");
      return JSON.stringify({ stdout, stderr: "", exitCode: 0 });
    })
    .register("plugin_echo", async (input) =>
      JSON.stringify({
        plugin: "parity-plugin@external",
        tool: "plugin_echo",
        input: JSON.parse(input) as { message: string }
      })
    );

  let policy = new PermissionPolicy(options.permissionMode ?? "read-only");
  for (const [toolName, requiredMode] of Object.entries(options.toolRequirements ?? {})) {
    policy = policy.withToolRequirement(toolName, requiredMode);
  }

  let runtime = new ConversationRuntime(
    options.session ?? Session.new(),
    new ScriptedApiClient(options.scripts),
    executor,
    policy,
    ["system"]
  );

  if (options.autoCompactionInputTokensThreshold !== undefined) {
    runtime = runtime.withAutoCompactionInputTokensThreshold(options.autoCompactionInputTokensThreshold);
  }

  const summary = await runtime.runTurn("run parity scenario", options.prompter);
  return { summary, runtime, workspace };
}

function text(value: string): AssistantEvent {
  return { type: "text_delta", text: value };
}

function tool(id: string, name: string, input: string): AssistantEvent {
  return { type: "tool_use", id, name, input };
}

function usage(
  input_tokens: number,
  output_tokens: number,
  cache_creation_input_tokens = 0,
  cache_read_input_tokens = 0
): AssistantEvent {
  return {
    type: "usage",
    usage: {
      input_tokens,
      output_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens
    }
  };
}

function stop(): AssistantEvent {
  return { type: "message_stop" };
}

function toolResultBlock(
  run: Awaited<ReturnType<typeof runScenario>>,
  index: number
) {
  const block = run.summary.toolResults[index]?.blocks[0];
  return block && block.type === "tool_result" ? block : undefined;
}

function toolResultText(run: Awaited<ReturnType<typeof runScenario>>, index: number): string {
  return toolResultBlock(run, index)?.output ?? "";
}

function lastAssistantText(run: Awaited<ReturnType<typeof runScenario>>): string {
  const blocks = run.summary.assistantMessages.at(-1)?.blocks ?? [];
  return blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}
