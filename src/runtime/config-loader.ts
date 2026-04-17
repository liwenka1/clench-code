import fs from "node:fs";
import path from "node:path";

import { checkUnsupportedConfigFormat, validateConfigFile, type ValidationResult } from "./config-validate.js";
import { resolveConfigLayers, type RuntimeConfig } from "./config.js";

export interface LoadedRuntimeConfig {
  loadedFiles: string[];
  merged: RuntimeConfig;
  validation: Record<string, ValidationResult>;
}

export function loadRuntimeConfig(cwd: string): LoadedRuntimeConfig {
  const loadedFiles: string[] = [];
  const layers: RuntimeConfig[] = [];
  const validation: Record<string, ValidationResult> = {};

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
    loadedFiles.push(candidate);
    try {
      checkUnsupportedConfigFormat(candidate);
      const source = fs.readFileSync(candidate, "utf8");
      validation[candidate] = validateConfigFile(source, candidate);
      layers.push(JSON.parse(source) as RuntimeConfig);
    } catch {
      // Ignore malformed config and continue loading later layers.
    }
  }

  return {
    loadedFiles,
    merged: resolveConfigLayers(layers),
    validation
  };
}
