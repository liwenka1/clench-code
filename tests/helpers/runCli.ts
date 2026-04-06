import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface RunCliOptions {
  cwd: string;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}

export interface RunCliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export async function runCli(options: RunCliOptions): Promise<RunCliResult> {
  const command = options.command ?? "node";
  const args = normalizeArgs(options.args ?? ["./dist/index.js"]);

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);

    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout,
        stderr
      });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }

    child.stdin.end();
  });
}

function normalizeArgs(args: string[]): string[] {
  if (args.length === 0) {
    return args;
  }

  const [entry, ...rest] = args;
  if (!entry || !entry.startsWith("./dist/")) {
    return args;
  }

  const helperDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(helperDir, "..", "..");
  return [path.join(projectRoot, entry.slice(2)), ...rest];
}
