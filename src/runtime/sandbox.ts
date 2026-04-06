import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type FilesystemIsolationMode = "off" | "workspace-only" | "allow-list";

export interface SandboxConfig {
  enabled?: boolean;
  namespaceRestrictions?: boolean;
  networkIsolation?: boolean;
  filesystemMode?: FilesystemIsolationMode;
  allowedMounts: string[];
}

export interface SandboxRequest {
  enabled: boolean;
  namespaceRestrictions: boolean;
  networkIsolation: boolean;
  filesystemMode: FilesystemIsolationMode;
  allowedMounts: string[];
}

export interface ContainerEnvironment {
  inContainer: boolean;
  markers: string[];
}

export interface SandboxDetectionInputs {
  envPairs: [string, string][];
  dockerenvExists: boolean;
  containerenvExists: boolean;
  proc1Cgroup?: string;
}

export interface SandboxStatus {
  enabled: boolean;
  requested: SandboxRequest;
  supported: boolean;
  active: boolean;
  namespaceSupported: boolean;
  namespaceActive: boolean;
  networkSupported: boolean;
  networkActive: boolean;
  filesystemMode: FilesystemIsolationMode;
  filesystemActive: boolean;
  allowedMounts: string[];
  inContainer: boolean;
  containerMarkers: string[];
  fallbackReason?: string;
}

export interface LinuxSandboxCommand {
  program: string;
  args: string[];
  env: [string, string][];
}

export function sandboxConfigResolveRequest(
  config: SandboxConfig,
  overrides: {
    enabled?: boolean;
    namespaceRestrictions?: boolean;
    networkIsolation?: boolean;
    filesystemMode?: FilesystemIsolationMode;
    allowedMounts?: string[];
  } = {}
): SandboxRequest {
  return {
    enabled: overrides.enabled ?? config.enabled ?? true,
    namespaceRestrictions: overrides.namespaceRestrictions ?? config.namespaceRestrictions ?? true,
    networkIsolation: overrides.networkIsolation ?? config.networkIsolation ?? false,
    filesystemMode: overrides.filesystemMode ?? config.filesystemMode ?? "workspace-only",
    allowedMounts: overrides.allowedMounts ?? [...config.allowedMounts]
  };
}

export function detectContainerEnvironmentFrom(inputs: SandboxDetectionInputs): ContainerEnvironment {
  const markers: string[] = [];
  if (inputs.dockerenvExists) {
    markers.push("/.dockerenv");
  }
  if (inputs.containerenvExists) {
    markers.push("/run/.containerenv");
  }
  for (const [key, value] of inputs.envPairs) {
    const normalized = key.toLowerCase();
    if (
      ["container", "docker", "podman", "kubernetes_service_host"].includes(normalized) &&
      value.trim().length > 0
    ) {
      markers.push(`env:${key}=${value}`);
    }
  }
  if (inputs.proc1Cgroup) {
    for (const needle of ["docker", "containerd", "kubepods", "podman", "libpod"]) {
      if (inputs.proc1Cgroup.includes(needle)) {
        markers.push(`/proc/1/cgroup:${needle}`);
      }
    }
  }
  markers.sort();
  const deduped = [...new Set(markers)];
  return {
    inContainer: deduped.length > 0,
    markers: deduped
  };
}

let unshareCache: boolean | undefined;

function unshareUserNamespaceWorks(): boolean {
  if (unshareCache !== undefined) {
    return unshareCache;
  }
  if (process.platform !== "linux") {
    unshareCache = false;
    return false;
  }
  const result = spawnSync("unshare", ["--user", "--map-root-user", "true"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"]
  });
  unshareCache = result.status === 0;
  return unshareCache;
}

export function resolveSandboxStatusForRequest(
  request: SandboxRequest,
  cwd: string,
  container: ContainerEnvironment = detectContainerEnvironment()
): SandboxStatus {
  const namespaceSupported = process.platform === "linux" && unshareUserNamespaceWorks();
  const networkSupported = namespaceSupported;
  const filesystemActive = request.enabled && request.filesystemMode !== "off";
  const fallbackReasons: string[] = [];

  if (request.enabled && request.namespaceRestrictions && !namespaceSupported) {
    fallbackReasons.push("namespace isolation unavailable (requires Linux with `unshare`)");
  }
  if (request.enabled && request.networkIsolation && !networkSupported) {
    fallbackReasons.push("network isolation unavailable (requires Linux with `unshare`)");
  }
  if (request.enabled && request.filesystemMode === "allow-list" && request.allowedMounts.length === 0) {
    fallbackReasons.push("filesystem allow-list requested without configured mounts");
  }

  const active =
    request.enabled &&
    (!request.namespaceRestrictions || namespaceSupported) &&
    (!request.networkIsolation || networkSupported);

  const allowedMounts = normalizeMounts(request.allowedMounts, cwd);

  return {
    enabled: request.enabled,
    requested: { ...request },
    supported: namespaceSupported,
    active,
    namespaceSupported,
    namespaceActive: request.enabled && request.namespaceRestrictions && namespaceSupported,
    networkSupported,
    networkActive: request.enabled && request.networkIsolation && networkSupported,
    filesystemMode: request.filesystemMode,
    filesystemActive,
    allowedMounts,
    inContainer: container.inContainer,
    containerMarkers: container.markers,
    fallbackReason: fallbackReasons.length > 0 ? fallbackReasons.join("; ") : undefined
  };
}

export function resolveSandboxStatus(config: SandboxConfig, cwd: string): SandboxStatus {
  const request = sandboxConfigResolveRequest(config);
  return resolveSandboxStatusForRequest(request, cwd);
}

export function buildLinuxSandboxCommand(
  command: string,
  cwd: string,
  status: SandboxStatus
): LinuxSandboxCommand | undefined {
  if (process.platform !== "linux" || !status.enabled || (!status.namespaceActive && !status.networkActive)) {
    return undefined;
  }

  const args = [
    "--user",
    "--map-root-user",
    "--mount",
    "--ipc",
    "--pid",
    "--uts",
    "--fork"
  ];
  if (status.networkActive) {
    args.push("--net");
  }
  args.push("sh", "-lc", command);

  const sandboxHome = path.join(cwd, ".sandbox-home");
  const sandboxTmp = path.join(cwd, ".sandbox-tmp");
  const env: [string, string][] = [
    ["HOME", sandboxHome],
    ["TMPDIR", sandboxTmp],
    ["CLAWD_SANDBOX_FILESYSTEM_MODE", status.filesystemMode],
    ["CLAWD_SANDBOX_ALLOWED_MOUNTS", status.allowedMounts.join(":")]
  ];
  if (process.env.PATH) {
    env.push(["PATH", process.env.PATH]);
  }

  return {
    program: "unshare",
    args,
    env
  };
}

export function detectContainerEnvironment(): ContainerEnvironment {
  let proc1: string | undefined;
  try {
    proc1 = fs.readFileSync("/proc/1/cgroup", "utf8");
  } catch {
    proc1 = undefined;
  }
  const envPairs = Object.entries(process.env).filter(
    (e): e is [string, string] => e[1] !== undefined
  );
  return detectContainerEnvironmentFrom({
    envPairs,
    dockerenvExists: fs.existsSync("/.dockerenv"),
    containerenvExists: fs.existsSync("/run/.containerenv"),
    proc1Cgroup: proc1
  });
}

function normalizeMounts(mounts: string[], cwd: string): string[] {
  return mounts.map((mount) => {
    const p = path.isAbsolute(mount) ? mount : path.join(cwd, mount);
    return path.resolve(p);
  });
}
