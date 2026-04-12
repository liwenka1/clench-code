import { ApiError } from "../api";
import type { CliOutputFormat } from "./args";

export function inferCliOutputFormat(argv: string[]): CliOutputFormat {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--output-format") {
      return normalizeCliOutputFormat(argv[index + 1]);
    }
    if (token.startsWith("--output-format=")) {
      return normalizeCliOutputFormat(token.slice("--output-format=".length));
    }
  }
  return "text";
}

export function writeCliError(
  error: unknown,
  outputFormat: CliOutputFormat,
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr
): void {
  if (outputFormat === "text") {
    stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return;
  }
  const payload = serializeCliError(error);
  if (outputFormat === "ndjson") {
    stderr.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function serializeCliError(error: unknown): Record<string, unknown> {
  if (error instanceof ApiError) {
    return {
      kind: "error",
      name: error.name,
      message: error.message,
      code: error.code,
      provider: error.provider,
      envVars: error.envVars,
      status: error.status,
      errorType: error.errorType,
      retryable: error.retryable,
      body: error.body,
      cause: serializeErrorCause(error.cause)
    };
  }
  if (error instanceof Error) {
    return {
      kind: "error",
      name: error.name,
      message: error.message,
      cause: serializeErrorCause((error as Error & { cause?: unknown }).cause)
    };
  }
  return {
    kind: "error",
    message: String(error)
  };
}

function serializeErrorCause(cause: unknown): Record<string, unknown> | string | undefined {
  if (!cause) {
    return undefined;
  }
  if (cause instanceof ApiError || cause instanceof Error) {
    return serializeCliError(cause);
  }
  return String(cause);
}

function normalizeCliOutputFormat(value: string | undefined): CliOutputFormat {
  return value === "json" || value === "ndjson" ? value : "text";
}
