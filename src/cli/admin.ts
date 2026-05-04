import fs from "node:fs";
import path from "node:path";

import { PluginDefinition } from "../plugins/index.js";
import {
  loadRuntimeConfig,
  PluginHealthcheck,
  registryFromConfig,
  type McpServerConfig,
  type PluginConfigEntry,
  type RuntimeConfig
} from "../runtime/index.js";
import { readLocalConfig, writeLocalConfig } from "./local-config";
import {
  renderConfigView,
  renderMcpHelpView,
  renderMcpListView,
  renderMcpServerView,
  renderPluginActionView,
  renderPluginListView
} from "./views";

export function printConfig(cwd: string, section: string | undefined): void {
  const { loadedFiles, merged, loadDiagnostics, validation } = loadRuntimeConfig(cwd);
  const mergedRecord = merged as Record<string, unknown>;
  process.stdout.write(renderConfigView(loadedFiles, section, section ? mergedRecord[section] : undefined, {
    loadDiagnostics,
    validation
  }));
}

export function printMcp(
  cwd: string,
  action: "list" | "show" | "help" | undefined,
  target: string | undefined
): void {
  const { merged } = loadRuntimeConfig(cwd);
  const servers = normalizeMcpConfigMap(merged.mcp);
  const registry = registryFromConfig(servers);
  if (!action || action === "list") {
    process.stdout.write(renderMcpListView(registry.listServers()));
    return;
  }
  if (action === "help") {
    process.stdout.write(renderMcpHelpView());
    return;
  }
  if (!target || !servers[target]) {
    throw new Error("/mcp show requires a configured server");
  }
  const state = registry.getServer(target)!;
  process.stdout.write(renderMcpServerView(target, state, servers[target]!));
}

export function handlePluginCommand(
  cwd: string,
  action: "list" | "install" | "enable" | "disable" | "uninstall" | "update" | undefined,
  target: string | undefined
): void {
  if (!action || action === "list") {
    const { merged } = loadRuntimeConfig(cwd);
    const plugins = normalizePluginMap(merged.plugins);
    process.stdout.write(renderPluginListView(plugins));
    return;
  }

  if (!target) {
    throw new Error(`/plugin ${action} requires a target`);
  }

  const localPath = path.join(cwd, ".clench", "settings.local.json");
  const existing = readLocalConfig(localPath);
  const plugins = normalizePluginMap(existing.plugins);

  if (action === "install") {
    const name = path.basename(target).replace(/\.[^.]+$/, "") || "plugin";
    const installed = loadPluginConfigEntry(target);
    plugins[name] = installed;
    writeLocalConfig(localPath, { ...existing, plugins });
    process.stdout.write(
      renderPluginActionView("Plugin", [
        { key: "installed", value: name },
        { key: "path", value: installed.path ?? target },
        { key: "version", value: installed.version ?? "unknown" },
        { key: "tools", value: installed.toolCount ?? 0 },
        { key: "health", value: installed.health ?? "validated" }
      ])
    );
    return;
  }

  if (action === "uninstall") {
    const existingEntry = plugins[target];
    if (!existingEntry) {
      throw new Error("/plugin uninstall requires an installed plugin");
    }
    delete plugins[target];
    writeLocalConfig(localPath, { ...existing, plugins });
    process.stdout.write(
      renderPluginActionView("Plugin", [
        { key: "uninstalled", value: target },
        { key: "path", value: existingEntry.path }
      ])
    );
    return;
  }

  if (action === "update") {
    const existingEntry = plugins[target];
    if (!existingEntry) {
      throw new Error("/plugin update requires an installed plugin");
    }
    if (!existingEntry.path) {
      throw new Error("/plugin update requires a plugin path");
    }
    const refreshed = loadPluginConfigEntry(existingEntry.path);
    plugins[target] = {
      ...refreshed,
      enabled: existingEntry.enabled
    };
    writeLocalConfig(localPath, { ...existing, plugins });
    process.stdout.write(
      renderPluginActionView("Plugin", [
        { key: "updated", value: target },
        { key: "path", value: refreshed.path ?? existingEntry.path },
        { key: "version", value: refreshed.version ?? existingEntry.version ?? "unknown" },
        { key: "tools", value: refreshed.toolCount ?? existingEntry.toolCount ?? 0 },
        { key: "health", value: refreshed.health ?? existingEntry.health ?? "validated" },
        { key: "enabled", value: existingEntry.enabled }
      ])
    );
    return;
  }

  const current = plugins[target] ?? { enabled: false };
  plugins[target] = {
    ...current,
    enabled: action === "enable",
    health: action === "enable" ? current.health ?? "validated" : "stopped"
  };
  writeLocalConfig(localPath, { ...existing, plugins });
  process.stdout.write(
    renderPluginActionView("Plugin", [{ key: `${action}d`, value: target }])
  );
}

export function summarizeMcpStatus(cwd: string):
  | {
      serverCount: number;
      sseServerCount: number;
      activeSseSessions: number;
      totalReconnects: number;
    }
  | undefined {
  const { merged } = loadRuntimeConfig(cwd);
  const servers = normalizeMcpConfigMap(merged.mcp);
  if (Object.keys(servers).length === 0) {
    return undefined;
  }
  const registry = registryFromConfig(servers);
  const states = registry.listServers();
  const sseStates = states.filter((state) => state.runtimeSession);
  return {
    serverCount: states.length,
    sseServerCount: sseStates.length,
    activeSseSessions: sseStates.filter((state) => state.runtimeSession?.connection === "open").length,
    totalReconnects: sseStates.reduce((count, state) => count + (state.runtimeSession?.reconnectCount ?? 0), 0)
  };
}

function normalizePluginMap(
  value: RuntimeConfig["plugins"]
): Record<string, PluginConfigEntry> {
  const source = value ?? {};
  const out: Record<string, PluginConfigEntry> = {};
  for (const [name, raw] of Object.entries(source)) {
    out[name] = {
      enabled: Boolean(raw.enabled),
      ...(typeof raw.path === "string" ? { path: raw.path } : {}),
      ...(typeof raw.version === "string" ? { version: raw.version } : {}),
      ...(typeof raw.kind === "string" ? { kind: raw.kind } : {}),
      ...(typeof raw.toolCount === "number" ? { toolCount: raw.toolCount } : {}),
      ...(typeof raw.health === "string" ? { health: raw.health } : {})
    };
  }
  return out;
}

function normalizeMcpConfigMap(value: RuntimeConfig["mcp"]): Record<string, McpServerConfig> {
  const source = value ?? {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(source)) {
    if (raw && typeof raw === "object" && "type" in raw) {
      out[name] = raw as McpServerConfig;
    }
  }
  return out;
}

function loadPluginConfigEntry(target: string): PluginConfigEntry {
  if (!fs.existsSync(target)) {
    return {
      enabled: false,
      path: target,
      version: "unknown",
      kind: "external",
      toolCount: 0,
      health: "unconfigured"
    };
  }

  const plugin = PluginDefinition.loadFromFile(target);
  plugin.validate();
  const summary = plugin.summary();
  const serverHealth = plugin.tools.map((tool) => ({
    serverName: tool.definition.name,
    status: "healthy" as const,
    capabilities: [tool.definition.name]
  }));
  const healthcheck = new PluginHealthcheck(summary.name, serverHealth);
  const health = healthcheck.state.state === "healthy" ? "healthy" : "validated";
  return {
    enabled: false,
    path: target,
    version: summary.version,
    kind: summary.kind,
    toolCount: summary.toolNames.length,
    health
  };
}
