import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { runReplLoop } from "../../src/cli/repl";
import { createTempWorkspace, type TempWorkspace } from "../helpers/tempWorkspace";

const workspaces: TempWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0, workspaces.length).map((workspace) => workspace.cleanup()));
  vi.restoreAllMocks();
});

describe("cli repl", () => {
  test("repl model add slash persists provider config", async () => {
    const workspace = await createTempWorkspace("clench-repl-model-add-");
    workspaces.push(workspace);

    const rl = new FakeReadline(["/model add local", "quit"], ["local", "", "", "", "qwen2.5-coder:14b", "y"]);
    vi.spyOn(process, "cwd").mockReturnValue(workspace.root);

    const stdout = await captureStdout(async () => {
      const run = runReplLoop({
        model: "claude-opus-4-6",
        permissionMode: "danger-full-access",
        outputFormat: "text"
      }, {
        createInterface: () => rl as never
      });
      await withTimeout(run, 2_000);
    });

    expect(rl.prompts).toContain("Provider ID [local]: ");
    expect(rl.prompts).toContain("Provider kind (openai/anthropic/xai) [openai]: ");
    expect(rl.prompts).toContain("Default model ID: ");
    expect(stdout).toContain("Current          local/qwen2.5-coder:14b");

    const saved = JSON.parse(fs.readFileSync(path.join(workspace.root, ".clench", "settings.local.json"), "utf8"));
    expect(saved.providers.local).toEqual({
      kind: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "dummy"
    });
    expect(saved.model).toBe("local/qwen2.5-coder:14b");
  });
});

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((msg: string | Uint8Array) => {
    chunks.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

class FakeReadline {
  history: string[] = [];
  prompts: string[] = [];
  line = "";
  cursor = 0;
  private currentPrompt = "";

  constructor(
    private readonly lines: string[],
    private readonly answers: string[]
  ) {}

  setPrompt(value: string): void {
    this.currentPrompt = value;
  }

  prompt(): void {
    this.prompts.push(this.currentPrompt);
  }

  on(_event: string, _handler: (...args: unknown[]) => void): this {
    return this;
  }

  pause(): void {}

  resume(): void {}

  close(): void {}

  question(prompt: string, callback: (answer: string) => void): void {
    this.prompts.push(prompt);
    callback(this.answers.shift() ?? "");
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<string> {
    for (const line of this.lines) {
      yield line;
    }
  }
}