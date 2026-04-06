import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 16_384;

export interface BashCommandInput {
  command: string;
  timeout?: number;
  description?: string;
  runInBackground?: boolean;
  dangerouslyDisableSandbox?: boolean;
}

export interface BashSandboxStatus {
  enabled: boolean;
}

export interface BashCommandOutput {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  backgroundTaskId?: string;
  dangerouslyDisableSandbox?: boolean;
  noOutputExpected?: boolean;
  returnCodeInterpretation?: string;
  sandboxStatus: BashSandboxStatus;
}

export async function executeBash(input: BashCommandInput): Promise<BashCommandOutput> {
  const sandboxStatus = {
    enabled: !input.dangerouslyDisableSandbox
  };

  if (input.runInBackground) {
    const child = spawn("sh", ["-lc", input.command], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return {
      stdout: "",
      stderr: "",
      interrupted: false,
      backgroundTaskId: String(child.pid),
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
      noOutputExpected: true,
      sandboxStatus
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-lc", input.command], {
      timeout: input.timeout,
      encoding: "utf8"
    });
    return {
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
      interrupted: false,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
      noOutputExpected: stdout.trim() === "" && stderr.trim() === "",
      sandboxStatus
    };
  } catch (error) {
    const typed = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
      killed?: boolean;
      signal?: string;
    };

    return {
      stdout: truncateOutput(typed.stdout ?? ""),
      stderr: truncateOutput(
        typed.killed && typed.signal === "SIGTERM"
          ? `Command exceeded timeout of ${input.timeout} ms`
          : typed.stderr ?? String(error)
      ),
      interrupted: Boolean(typed.killed),
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
      noOutputExpected: false,
      returnCodeInterpretation:
        typeof typed.code === "number" ? `exit_code:${typed.code}` : undefined,
      sandboxStatus
    };
  }
}

export function truncateOutput(output: string): string {
  if (Buffer.byteLength(output, "utf8") <= MAX_OUTPUT_BYTES) {
    return output;
  }

  let end = Math.min(output.length, MAX_OUTPUT_BYTES);
  while (end > 0 && !isUtf8Boundary(output, end)) {
    end -= 1;
  }

  return `${output.slice(0, end)}\n\n[output truncated - exceeded 16384 bytes]`;
}

function isUtf8Boundary(value: string, index: number): boolean {
  try {
    return Buffer.from(value.slice(0, index), "utf8").toString("utf8") === value.slice(0, index);
  } catch {
    return false;
  }
}
