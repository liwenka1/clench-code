export function extractLastJsonObject(stdout: string): unknown {
  const lines = stdout.trim().split("\n").reverse();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      return JSON.parse(trimmed);
    }
  }

  throw new Error(`No JSON object found in output:\n${stdout}`);
}
