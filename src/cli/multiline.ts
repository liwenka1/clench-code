export interface MultilineComposeState {
  lines: string[];
}

export interface MultilineStepResult {
  state: MultilineComposeState | undefined;
  submittedText?: string;
  cancelled?: boolean;
}

export const MULTILINE_START_COMMAND = "/multiline";
export const MULTILINE_SUBMIT_COMMAND = "/submit";
export const MULTILINE_CANCEL_COMMAND = "/cancel";

export function shouldEnterMultiline(line: string): boolean {
  return line.trim() === MULTILINE_START_COMMAND || hasContinuationMarker(line);
}

export function beginMultiline(line: string): MultilineComposeState {
  if (line.trim() === MULTILINE_START_COMMAND) {
    return { lines: [] };
  }
  return { lines: [stripContinuationMarker(line)] };
}

export function consumeMultilineLine(
  state: MultilineComposeState,
  line: string
): MultilineStepResult {
  const trimmed = line.trim();
  if (trimmed === MULTILINE_CANCEL_COMMAND) {
    return { state: undefined, cancelled: true };
  }
  if (trimmed === MULTILINE_SUBMIT_COMMAND) {
    return {
      state: undefined,
      submittedText: state.lines.join("\n").trimEnd()
    };
  }
  return {
    state: {
      lines: [...state.lines, hasContinuationMarker(line) ? stripContinuationMarker(line) : line]
    }
  };
}

export function hasContinuationMarker(line: string): boolean {
  return /(^|[^\\])\\$/.test(line);
}

function stripContinuationMarker(line: string): string {
  return line.replace(/\\$/, "").trimEnd();
}
