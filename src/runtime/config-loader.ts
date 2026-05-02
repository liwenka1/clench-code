import fs from "node:fs";
import path from "node:path";

import { checkUnsupportedConfigFormat, validateConfigFile, type ValidationResult } from "./config-validate.js";
import { resolveConfigLayers, type RuntimeConfig } from "./config.js";

export type ConfigLoadDiagnosticKind = "unsupported_format" | "read_error" | "parse_error";

export interface ConfigLoadDiagnostic {
  path: string;
  kind: ConfigLoadDiagnosticKind;
  message: string;
}

export interface LoadedRuntimeConfig {
  loadedFiles: string[];
  merged: RuntimeConfig;
  validation: Record<string, ValidationResult>;
  loadDiagnostics: ConfigLoadDiagnostic[];
}

export function loadRuntimeConfig(cwd: string): LoadedRuntimeConfig {
  const loadedFiles: string[] = [];
  const layers: RuntimeConfig[] = [];
  const validation: Record<string, ValidationResult> = {};
  const loadDiagnostics: ConfigLoadDiagnostic[] = [];

  const configHome = process.env.CLENCH_CONFIG_HOME;
  const candidates = [
    configHome ? path.join(configHome, "settings.json") : undefined,
    path.join(cwd, ".clench.json"),
    path.join(cwd, ".clench", "settings.local.json")
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      checkUnsupportedConfigFormat(candidate);
    } catch (error) {
      loadDiagnostics.push({
        path: candidate,
        kind: "unsupported_format",
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    let source: string;
    try {
      source = fs.readFileSync(candidate, "utf8");
    } catch (error) {
      loadDiagnostics.push({
        path: candidate,
        kind: "read_error",
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    validation[candidate] = validateConfigFile(source, candidate);
    try {
      layers.push(JSON.parse(source) as RuntimeConfig);
      loadedFiles.push(candidate);
    } catch (error) {
      loadDiagnostics.push({
        path: candidate,
        kind: "parse_error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    loadedFiles,
    merged: resolveConfigLayers(layers),
    validation,
    loadDiagnostics
  };
}
