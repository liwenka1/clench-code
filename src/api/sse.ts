import { ApiError } from "./error";
import type { StreamEvent } from "./types";

export class SseParser {
  private buffer = "";

  push(chunk: string | Uint8Array): StreamEvent[] {
    this.buffer +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    const events: StreamEvent[] = [];

    while (true) {
      const next = nextFrame(this.buffer);
      if (!next) {
        break;
      }

      this.buffer = next.rest;
      const parsed = parseFrame(next.frame);
      if (parsed) {
        events.push(parsed);
      }
    }

    return events;
  }

  finish(): StreamEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }

    const trailing = this.buffer;
    this.buffer = "";
    const parsed = parseFrame(trailing);
    return parsed ? [parsed] : [];
  }
}

export function parseFrame(frame: string): StreamEvent | null {
  const trimmed = frame.trim();
  if (!trimmed) {
    return null;
  }

  const dataLines: string[] = [];
  let eventName: string | undefined;

  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (eventName === "ping" || dataLines.length === 0) {
    return null;
  }

  const payload = dataLines.join("\n");
  if (payload === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(payload) as StreamEvent;
  } catch (error) {
    throw ApiError.invalidSseFrame("json parse failed", error);
  }
}

function nextFrame(buffer: string): { frame: string; rest: string } | null {
  const newlineIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");

  if (newlineIndex === -1 && crlfIndex === -1) {
    return null;
  }

  if (newlineIndex !== -1 && (crlfIndex === -1 || newlineIndex < crlfIndex)) {
    return {
      frame: buffer.slice(0, newlineIndex),
      rest: buffer.slice(newlineIndex + 2)
    };
  }

  return {
    frame: buffer.slice(0, crlfIndex),
    rest: buffer.slice(crlfIndex + 4)
  };
}
