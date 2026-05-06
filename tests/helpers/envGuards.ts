import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T> | T
): Promise<T> {
  const original = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    original.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export async function withIsolatedRuntimeConfig<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T> | T
): Promise<T> {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "clench-test-config-"));
  try {
    return await withEnv(
      {
        CLENCH_CONFIG_HOME: configHome,
        CLAW_CONFIG_HOME: configHome,
        CODEX_HOME: configHome,
        CLAUDE_CONFIG_DIR: configHome,
        ...overrides
      },
      run
    );
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
}
