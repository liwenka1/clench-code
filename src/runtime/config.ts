export interface PluginConfigEntry {
  enabled: boolean;
  path?: string;
  version?: string;
  kind?: string;
  toolCount?: number;
  health?: "unconfigured" | "validated" | "healthy" | "degraded" | "failed" | "stopped";
}

export interface RuntimeConfig {
  model?: string;
  sandbox?: {
    enabled?: boolean;
  };
  mcp?: Record<string, unknown>;
  plugins?: Record<string, PluginConfigEntry>;
}

export function resolveConfigLayers(layers: RuntimeConfig[]): RuntimeConfig {
  return layers.reduce<RuntimeConfig>((merged, layer) => {
    const mergedPlugins: RuntimeConfig["plugins"] = { ...(merged.plugins ?? {}) };
    for (const [name, plugin] of Object.entries(layer.plugins ?? {})) {
      mergedPlugins[name] = {
        ...(mergedPlugins[name] ?? { enabled: false }),
        ...plugin
      };
    }

    return {
      ...merged,
      ...layer,
      sandbox: {
        ...merged.sandbox,
        ...layer.sandbox
      },
      mcp: {
        ...(merged.mcp ?? {}),
        ...(layer.mcp ?? {})
      },
      plugins: mergedPlugins
    };
  }, {});
}

export function pluginState(
  config: RuntimeConfig,
  pluginName: string
): { enabled: boolean } | undefined {
  return config.plugins?.[pluginName];
}

export function setPluginEnabled(
  config: RuntimeConfig,
  pluginName: string,
  enabled: boolean
): RuntimeConfig {
  const current = config.plugins?.[pluginName];
  return {
    ...config,
    plugins: {
      ...(config.plugins ?? {}),
      [pluginName]: { ...current, enabled }
    }
  };
}
