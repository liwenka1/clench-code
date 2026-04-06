export interface SpinnerState {
  frameIndex: number;
}

const SPINNER_FRAMES = ["-", "\\", "|", "/"];

export function newSpinner(): SpinnerState {
  return { frameIndex: 0 };
}

export function tickSpinner(state: SpinnerState, label: string): string {
  const frame = SPINNER_FRAMES[state.frameIndex % SPINNER_FRAMES.length]!;
  state.frameIndex += 1;
  return `${frame} ${label}`;
}

export function finishSpinner(label: string): string {
  return `OK ${label}`;
}

export function renderMarkdown(markdown: string): string {
  return markdown
    .replace(/^# /gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/^- /gm, "• ");
}
