export interface RuntimeConfig {
  model?: string;
  sandbox?: {
    enabled?: boolean;
  };
  plugins?: Record<string, { enabled: boolean }>;
}

export function resolveConfigLayers(layers: RuntimeConfig[]): RuntimeConfig {
  return layers.reduce<RuntimeConfig>(
    (merged, layer) => ({
      ...merged,
      ...layer,
      sandbox: {
        ...merged.sandbox,
        ...layer.sandbox
      },
      plugins: {
        ...(merged.plugins ?? {}),
        ...(layer.plugins ?? {})
      }
    }),
    {}
  );
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
  return {
    ...config,
    plugins: {
      ...(config.plugins ?? {}),
      [pluginName]: { enabled }
    }
  };
}
