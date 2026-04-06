export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class JsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonError";
  }
}

export function renderJson(value: JsonValue): string {
  return JSON.stringify(value);
}

export function prettyJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}

export function parseJson(source: string): JsonValue {
  try {
    return JSON.parse(source) as JsonValue;
  } catch (error) {
    throw new JsonError(error instanceof Error ? error.message : String(error));
  }
}
