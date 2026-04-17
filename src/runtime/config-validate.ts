import path from "node:path";

import { JsonError, parseJson, type JsonValue } from "./json.js";

export interface ConfigDiagnostic {
  path: string;
  field: string;
  line?: number;
  kind: DiagnosticKind;
}

export type DiagnosticKind =
  | { type: "unknown_key"; suggestion?: string }
  | { type: "wrong_type"; expected: string; got: string }
  | { type: "deprecated"; replacement: string };

export interface ValidationResult {
  errors: ConfigDiagnostic[];
  warnings: ConfigDiagnostic[];
}

type FieldType = "string" | "boolean" | "object" | "string_array" | "number";

interface FieldSpec {
  name: string;
  expected: FieldType;
}

interface DeprecatedField {
  name: string;
  replacement: string;
}

const TOP_LEVEL_FIELDS: FieldSpec[] = [
  { name: "$schema", expected: "string" },
  { name: "model", expected: "string" },
  { name: "hooks", expected: "object" },
  { name: "permissions", expected: "object" },
  { name: "permissionMode", expected: "string" },
  { name: "mcp", expected: "object" },
  { name: "oauth", expected: "object" },
  { name: "enabledPlugins", expected: "object" },
  { name: "plugins", expected: "object" },
  { name: "sandbox", expected: "object" },
  { name: "env", expected: "object" },
  { name: "aliases", expected: "object" },
  { name: "providerFallbacks", expected: "object" },
  { name: "trustedRoots", expected: "string_array" }
];

const HOOKS_FIELDS: FieldSpec[] = [
  { name: "PreToolUse", expected: "string_array" },
  { name: "PostToolUse", expected: "string_array" },
  { name: "PostToolUseFailure", expected: "string_array" }
];

const PERMISSIONS_FIELDS: FieldSpec[] = [
  { name: "defaultMode", expected: "string" },
  { name: "allow", expected: "string_array" },
  { name: "deny", expected: "string_array" },
  { name: "ask", expected: "string_array" }
];

const SANDBOX_FIELDS: FieldSpec[] = [
  { name: "enabled", expected: "boolean" },
  { name: "namespaceRestrictions", expected: "boolean" },
  { name: "networkIsolation", expected: "boolean" },
  { name: "filesystemMode", expected: "string" },
  { name: "allowedMounts", expected: "string_array" }
];

const OAUTH_FIELDS: FieldSpec[] = [
  { name: "clientId", expected: "string" },
  { name: "authorizeUrl", expected: "string" },
  { name: "tokenUrl", expected: "string" },
  { name: "callbackPort", expected: "number" },
  { name: "manualRedirectUrl", expected: "string" },
  { name: "scopes", expected: "string_array" }
];

const PLUGIN_ENTRY_FIELDS: FieldSpec[] = [
  { name: "enabled", expected: "boolean" },
  { name: "path", expected: "string" },
  { name: "version", expected: "string" },
  { name: "kind", expected: "string" },
  { name: "toolCount", expected: "number" },
  { name: "health", expected: "string" }
];

const DEPRECATED_FIELDS: DeprecatedField[] = [
  { name: "permissionMode", replacement: "permissions.defaultMode" },
  { name: "enabledPlugins", replacement: "plugins" }
];

export function validateConfigFile(source: string, filePath: string): ValidationResult {
  const parsed = parseConfigObject(source);
  if ("errors" in parsed) {
    return parsed;
  }

  const result = validateObjectKeys(parsed.value, TOP_LEVEL_FIELDS, "", source, filePath);

  for (const deprecated of DEPRECATED_FIELDS) {
    if (deprecated.name in parsed.value) {
      result.warnings.push({
        path: filePath,
        field: deprecated.name,
        line: findKeyLine(source, deprecated.name),
        kind: { type: "deprecated", replacement: deprecated.replacement }
      });
    }
  }

  mergeValidation(result, validateKnownNested(parsed.value.hooks, HOOKS_FIELDS, "hooks", source, filePath));
  mergeValidation(result, validateKnownNested(parsed.value.permissions, PERMISSIONS_FIELDS, "permissions", source, filePath));
  mergeValidation(result, validateKnownNested(parsed.value.sandbox, SANDBOX_FIELDS, "sandbox", source, filePath));
  mergeValidation(result, validateKnownNested(parsed.value.oauth, OAUTH_FIELDS, "oauth", source, filePath));

  const plugins = asObject(parsed.value.plugins);
  if (plugins) {
    for (const [pluginName, value] of Object.entries(plugins)) {
      if (!isObject(value)) {
        result.errors.push({
          path: filePath,
          field: `plugins.${pluginName}`,
          line: findKeyLine(source, pluginName),
          kind: { type: "wrong_type", expected: "an object", got: jsonTypeLabel(value) }
        });
        continue;
      }
      mergeValidation(
        result,
        validateObjectKeys(value, PLUGIN_ENTRY_FIELDS, `plugins.${pluginName}`, source, filePath)
      );
    }
  }

  return result;
}

export function checkUnsupportedConfigFormat(filePath: string): void {
  if (path.extname(filePath).toLowerCase() === ".toml") {
    throw new Error(`${filePath}: TOML config files are not supported. Use JSON (settings.json) instead`);
  }
}

export function formatConfigDiagnostics(result: ValidationResult): string {
  return [
    ...result.warnings.map((warning) => `warning: ${formatDiagnostic(warning)}`),
    ...result.errors.map((error) => `error: ${formatDiagnostic(error)}`)
  ].join("\n");
}

function parseConfigObject(source: string): { value: Record<string, JsonValue> } | ValidationResult {
  try {
    const parsed = parseJson(source);
    if (!isObject(parsed)) {
      return {
        errors: [{
          path: "<inline>",
          field: "<root>",
          kind: { type: "wrong_type", expected: "an object", got: jsonTypeLabel(parsed) }
        }],
        warnings: []
      };
    }
    return { value: parsed };
  } catch (error) {
    const message = error instanceof JsonError ? error.message : String(error);
    return {
      errors: [{ path: "<inline>", field: "<parse>", kind: { type: "wrong_type", expected: "valid JSON object", got: message } }],
      warnings: []
    };
  }
}

function validateKnownNested(
  value: JsonValue | undefined,
  fields: FieldSpec[],
  prefix: string,
  source: string,
  filePath: string
): ValidationResult {
  const object = asObject(value);
  if (!object) {
    return { errors: [], warnings: [] };
  }
  return validateObjectKeys(object, fields, prefix, source, filePath);
}

function validateObjectKeys(
  object: Record<string, JsonValue>,
  knownFields: FieldSpec[],
  prefix: string,
  source: string,
  filePath: string
): ValidationResult {
  const result: ValidationResult = { errors: [], warnings: [] };
  const knownNames = knownFields.map((field) => field.name);

  for (const [key, value] of Object.entries(object)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    const spec = knownFields.find((field) => field.name === key);
    if (!spec) {
      if (DEPRECATED_FIELDS.some((field) => field.name === key)) {
        continue;
      }
      result.errors.push({
        path: filePath,
        field: fieldPath,
        line: findKeyLine(source, key),
        kind: { type: "unknown_key", suggestion: suggestField(key, knownNames) }
      });
      continue;
    }
    if (!matchesFieldType(spec.expected, value)) {
      result.errors.push({
        path: filePath,
        field: fieldPath,
        line: findKeyLine(source, key),
        kind: {
          type: "wrong_type",
          expected: fieldTypeLabel(spec.expected),
          got: jsonTypeLabel(value)
        }
      });
    }
  }

  return result;
}

function mergeValidation(target: ValidationResult, other: ValidationResult): void {
  target.errors.push(...other.errors);
  target.warnings.push(...other.warnings);
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return isObject(value) ? value : undefined;
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesFieldType(expected: FieldType, value: JsonValue): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isObject(value);
    case "string_array":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string");
    case "number":
      return typeof value === "number";
  }
}

function fieldTypeLabel(expected: FieldType): string {
  switch (expected) {
    case "string":
      return "a string";
    case "boolean":
      return "a boolean";
    case "object":
      return "an object";
    case "string_array":
      return "an array of strings";
    case "number":
      return "a number";
  }
}

function jsonTypeLabel(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "boolean":
      return "a boolean";
    case "number":
      return "a number";
    case "string":
      return "a string";
    case "object":
      return "an object";
    default:
      return typeof value;
  }
}

function findKeyLine(source: string, key: string): number | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`"${escaped}"\\s*:`, "g");
  const match = regex.exec(source);
  if (!match) {
    return undefined;
  }
  return source.slice(0, match.index).split("\n").length;
}

function suggestField(input: string, candidates: string[]): string | undefined {
  return candidates
    .map((candidate) => ({ candidate, distance: editDistance(input.toLowerCase(), candidate.toLowerCase()) }))
    .filter((entry) => entry.distance <= 3)
    .sort((left, right) => left.distance - right.distance)[0]?.candidate;
}

function editDistance(left: string, right: string): number {
  if (!left) return right.length;
  if (!right) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1).fill(0);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    current[0] = leftIndex + 1;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const cost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        previous[rightIndex + 1]! + 1,
        current[rightIndex]! + 1,
        previous[rightIndex]! + cost
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length]!;
}

function formatDiagnostic(diagnostic: ConfigDiagnostic): string {
  const location = diagnostic.line ? ` (line ${diagnostic.line})` : "";
  switch (diagnostic.kind.type) {
    case "unknown_key":
      return diagnostic.kind.suggestion
        ? `${diagnostic.path}: unknown key "${diagnostic.field}"${location}. Did you mean "${diagnostic.kind.suggestion}"?`
        : `${diagnostic.path}: unknown key "${diagnostic.field}"${location}`;
    case "wrong_type":
      return `${diagnostic.path}: field "${diagnostic.field}" must be ${diagnostic.kind.expected}, got ${diagnostic.kind.got}${location}`;
    case "deprecated":
      return `${diagnostic.path}: field "${diagnostic.field}" is deprecated${location}. Use "${diagnostic.kind.replacement}" instead`;
  }
}
