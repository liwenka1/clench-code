export interface PluginConfigEntry {
  enabled: boolean;
  path?: string;
  version?: string;
  kind?: string;
  toolCount?: number;
  health?: "unconfigured" | "validated" | "healthy" | "degraded" | "failed" | "stopped";
}

export interface PermissionsConfig {
  defaultMode?: string;
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

export interface HooksConfig {
  PreToolUse?: string[];
  PostToolUse?: string[];
  PostToolUseFailure?: string[];
}

export interface OAuthRuntimeConfig {
  clientId?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  callbackPort?: number;
  manualRedirectUrl?: string;
  scopes?: string[];
}

export interface RuntimeConfig {
  $schema?: string;
  model?: string;
  sandbox?: {
    enabled?: boolean;
    namespaceRestrictions?: boolean;
    networkIsolation?: boolean;
    filesystemMode?: string;
    allowedMounts?: string[];
  };
  mcp?: Record<string, unknown>;
  plugins?: Record<string, PluginConfigEntry>;
  hooks?: HooksConfig;
  permissions?: PermissionsConfig;
  permissionMode?: string;
  oauth?: OAuthRuntimeConfig;
  enabledPlugins?: Record<string, boolean>;
  env?: Record<string, string>;
  aliases?: Record<string, string>;
  providerFallbacks?: Record<string, unknown>;
  trustedRoots?: string[];
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
