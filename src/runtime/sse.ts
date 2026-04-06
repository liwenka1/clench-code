export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export class IncrementalSseParser {
  private buffer = "";
  private eventName?: string;
  private dataLines: string[] = [];
  private id?: string;
  private retry?: number;

  pushChunk(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];

    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.processLine(line, events);
    }

    return events;
  }

  finish(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer) {
      this.processLine(this.buffer.replace(/\r$/, ""), events);
      this.buffer = "";
    }
    const finalEvent = this.takeEvent();
    if (finalEvent) {
      events.push(finalEvent);
    }
    return events;
  }

  private processLine(line: string, events: SseEvent[]): void {
    if (line === "") {
      const event = this.takeEvent();
      if (event) {
        events.push(event);
      }
      return;
    }
    if (line.startsWith(":")) {
      return;
    }

    const [field, rawValue = ""] = line.split(/:(.*)/s, 2);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") {
      this.eventName = value;
    } else if (field === "data") {
      this.dataLines.push(value);
    } else if (field === "id") {
      this.id = value;
    } else if (field === "retry") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        this.retry = parsed;
      }
    }
  }

  private takeEvent(): SseEvent | undefined {
    if (this.dataLines.length === 0 && this.eventName === undefined && this.id === undefined && this.retry === undefined) {
      return undefined;
    }

    const event: SseEvent = {
      event: this.eventName,
      data: this.dataLines.join("\n"),
      id: this.id,
      retry: this.retry
    };

    this.eventName = undefined;
    this.dataLines = [];
    this.id = undefined;
    this.retry = undefined;
    return event;
  }
}
