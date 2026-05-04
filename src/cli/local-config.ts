import fs from "node:fs";
import path from "node:path";

import type { RuntimeConfig } from "../runtime/index.js";

export function readLocalConfig(filePath: string): RuntimeConfig {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as RuntimeConfig;
}

export function writeLocalConfig(filePath: string, config: RuntimeConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
