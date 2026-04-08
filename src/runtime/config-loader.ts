import fs from "node:fs";
import path from "node:path";

import { resolveConfigLayers, type RuntimeConfig } from "./config.js";

export interface LoadedRuntimeConfig {
  loadedFiles: string[];
  merged: RuntimeConfig;
}

export function loadRuntimeConfig(cwd: string): LoadedRuntimeConfig {
  const loadedFiles: string[] = [];
  const layers: RuntimeConfig[] = [];

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
      layers.push(JSON.parse(fs.readFileSync(candidate, "utf8")) as RuntimeConfig);
    } catch {
      // Ignore malformed config and continue loading later layers.
    }
  }

  return {
    loadedFiles,
    merged: resolveConfigLayers(layers)
  };
}
