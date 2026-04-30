import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ApiError } from "../../src/api/error";
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
      apiKey: "dummy",
      defaultModel: "qwen2.5-coder:14b"
    });
    expect(saved.model).toBe("local/qwen2.5-coder:14b");
  });

  test("repl model slash resolves provider defaults from config", async () => {
    const workspace = await createTempWorkspace("clench-repl-model-provider-");
    workspaces.push(workspace);

    fs.mkdirSync(path.join(workspace.root, ".clench"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace.root, ".clench", "settings.local.json"),
      JSON.stringify({
        providers: {
          cccc: {
            kind: "openai",
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "dummy",
            defaultModel: "qwen3.5:4b"
          }
        },
        model: "claude-opus-4-6"
      }, null, 2)
    );

    const rl = new FakeReadline(["/model cccc", "/model", "quit"], []);
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

    const matches = stdout.match(/Current\s+cccc\/qwen3\.5:4b/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test("repl treats provider-qualified model arguments as slash commands", async () => {
    const workspace = await createTempWorkspace("clench-repl-model-qualified-");
    workspaces.push(workspace);

    fs.mkdirSync(path.join(workspace.root, ".clench"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace.root, ".clench", "settings.local.json"),
      JSON.stringify({
        providers: {
          cccc: {
            kind: "openai",
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "dummy"
          }
        },
        model: "cccc"
      }, null, 2)
    );

    const rl = new FakeReadline(["/model cccc/qwen3.5:4b", "/model", "quit"], []);
    vi.spyOn(process, "cwd").mockReturnValue(workspace.root);

    const stdout = await captureStdout(async () => {
      const run = runReplLoop({
        model: "cccc",
        permissionMode: "danger-full-access",
        outputFormat: "text"
      }, {
        createInterface: () => rl as never
      });
      await withTimeout(run, 2_000);
    });

    expect(stdout).toContain("Current          cccc/qwen3.5:4b");
    expect(stdout).toContain("Previous         cccc");
  });

  test("repl rejects unknown bare model selections without changing the current model", async () => {
    const workspace = await createTempWorkspace("clench-repl-model-unknown-");
    workspaces.push(workspace);

    fs.mkdirSync(path.join(workspace.root, ".clench"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace.root, ".clench", "settings.local.json"),
      JSON.stringify({
        providers: {
          cccc: {
            kind: "openai",
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "dummy",
            defaultModel: "qwen3.5:4b"
          }
        },
        model: "cccc/qwen3.5:4b"
      }, null, 2)
    );

    const rl = new FakeReadline(["/model sss", "/model", "quit"], []);
    vi.spyOn(process, "cwd").mockReturnValue(workspace.root);

    const { stdout, stderr } = await captureStdio(async () => {
      const run = runReplLoop({
        model: "cccc/qwen3.5:4b",
        permissionMode: "danger-full-access",
        outputFormat: "text"
      }, {
        createInterface: () => rl as never
      });
      await withTimeout(run, 2_000);
    });

    expect(stderr).toContain("unknown model selection 'sss'.");
    expect(stderr).toContain("Configured providers: cccc");
    expect(stderr).toContain("/model sonnet to use a built-in alias");
    expect(stderr).toContain("/model <provider-id> to use a provider default model");
    expect(stderr).toContain("/model <provider-id>/<model-id> to select an explicit model");
    expect(stderr).toContain("/model list to inspect configured providers");
    expect(stdout).toContain("Current          cccc/qwen3.5:4b");

    const saved = JSON.parse(fs.readFileSync(path.join(workspace.root, ".clench", "settings.local.json"), "utf8"));
    expect(saved.model).toBe("cccc/qwen3.5:4b");
  });

  test("repl explains how to fix unknown providers without changing the current model", async () => {
    const workspace = await createTempWorkspace("clench-repl-model-unknown-provider-");
    workspaces.push(workspace);

    fs.mkdirSync(path.join(workspace.root, ".clench"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace.root, ".clench", "settings.local.json"),
      JSON.stringify({
        providers: {
          aaa: {
            kind: "openai",
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "dummy"
          },
          cccc: {
            kind: "openai",
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "dummy",
            defaultModel: "qwen3.5:4b"
          }
        },
        model: "cccc/qwen3.5:4b"
      }, null, 2)
    );

    const rl = new FakeReadline(["/model nope/qwen3.5:4b", "/model", "quit"], []);
    vi.spyOn(process, "cwd").mockReturnValue(workspace.root);

    const { stdout, stderr } = await captureStdio(async () => {
      const run = runReplLoop({
        model: "cccc/qwen3.5:4b",
        permissionMode: "danger-full-access",
        outputFormat: "text"
      }, {
        createInterface: () => rl as never
      });
      await withTimeout(run, 2_000);
    });

    expect(stderr).toContain("unknown provider 'nope'.");
    expect(stderr).toContain("Configured providers: aaa, cccc");
    expect(stderr).toContain("/model add nope to configure it");
    expect(stderr).toContain("/model <provider-id>/<model-id> to select an explicit model");
    expect(stderr).toContain("/model list to inspect configured providers");
    expect(stdout).toContain("Current          cccc/qwen3.5:4b");

    const saved = JSON.parse(fs.readFileSync(path.join(workspace.root, ".clench", "settings.local.json"), "utf8"));
    expect(saved.model).toBe("cccc/qwen3.5:4b");
  });

  test("repl explains how to fix configured providers without a default model", async () => {
    const workspace = await createTempWorkspace("clench-repl-model-provider-missing-default-");
    workspaces.push(workspace);

    fs.mkdirSync(path.join(workspace.root, ".clench"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace.root, ".clench", "settings.local.json"),
      JSON.stringify({
        providers: {
          aaa: {
            kind: "openai",
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "dummy"
          },
          cccc: {
            kind: "openai",
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "dummy",
            defaultModel: "qwen3.5:4b"
          }
        },
        model: "cccc/qwen3.5:4b"
      }, null, 2)
    );

    const rl = new FakeReadline(["/model aaa", "/model", "quit"], []);
    vi.spyOn(process, "cwd").mockReturnValue(workspace.root);

    const { stdout, stderr } = await captureStdio(async () => {
      const run = runReplLoop({
        model: "cccc/qwen3.5:4b",
        permissionMode: "danger-full-access",
        outputFormat: "text"
      }, {
        createInterface: () => rl as never
      });
      await withTimeout(run, 2_000);
    });

    expect(stderr).toContain("provider 'aaa' is configured, but it has no default model yet.");
    expect(stderr).toContain("/model aaa/<model-id> to switch with an explicit model");
    expect(stderr).toContain("/model add aaa to set its default model");
    expect(stderr).toContain("/model list to inspect configured providers");
    expect(stdout).toContain("Current          cccc/qwen3.5:4b");

    const saved = JSON.parse(fs.readFileSync(path.join(workspace.root, ".clench", "settings.local.json"), "utf8"));
    expect(saved.model).toBe("cccc/qwen3.5:4b");
  });

  test("ctrl-c cancels an in-flight turn without closing the repl", async () => {
    const workspace = await createTempWorkspace("clench-repl-cancel-turn-");
    workspaces.push(workspace);

    const rl = new FakeReadline(["直接回复我 ok", "quit"], []);
    vi.spyOn(process, "cwd").mockReturnValue(workspace.root);

    const { stdout, stderr } = await captureStdio(async () => {
      const run = runReplLoop({
        model: "cccc/qwen3.5:4b",
        permissionMode: "danger-full-access",
        outputFormat: "text"
      }, {
        createInterface: () => rl as never,
        runPromptModeImpl: async (input) => {
          queueMicrotask(() => rl.emit("SIGINT"));
          return await new Promise((_, reject) => {
            input.abortSignal?.addEventListener("abort", () => reject(ApiError.aborted()));
          });
        }
      });
      await withTimeout(run, 2_000);
    });

    expect(stdout).toContain("OK Turn cancelled");
    expect(rl.prompts).toContain("clench(danger-full-access)> ");
    expect(stderr).not.toContain("request aborted");
    expect(rl.closed).toBe(true);
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

async function captureStdio(run: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((msg: string | Uint8Array) => {
    stdoutChunks.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((msg: string | Uint8Array) => {
    stderrChunks.push(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
    return true;
  });
  try {
    await run();
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
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
  closed = false;
  private currentPrompt = "";
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

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

  on(event: string, handler: (...args: unknown[]) => void): this {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
    return this;
  }

  pause(): void {}

  resume(): void {}

  close(): void {
    this.closed = true;
  }

  question(prompt: string, callback: (answer: string) => void): void {
    this.prompts.push(prompt);
    callback(this.answers.shift() ?? "");
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<string> {
    for (const line of this.lines) {
      yield line;
    }
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}