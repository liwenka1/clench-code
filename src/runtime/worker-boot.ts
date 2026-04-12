import fs from "node:fs";
import path from "node:path";

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

export type WorkerStatus =
  | "spawning"
  | "trust_required"
  | "ready_for_prompt"
  | "running"
  | "finished"
  | "failed";

export type WorkerBootFailureKind = "trust_gate" | "prompt_delivery" | "protocol" | "provider";

export interface WorkerFailure {
  kind: WorkerBootFailureKind;
  message: string;
  createdAt: number;
}

export type WorkerEventKind =
  | "spawning"
  | "trust_required"
  | "trust_resolved"
  | "ready_for_prompt"
  | "prompt_misdelivery"
  | "prompt_replay_armed"
  | "running"
  | "restarted"
  | "finished"
  | "failed";

export type WorkerTrustResolution = "auto_allowlisted" | "manual_approval";

export type WorkerPromptTarget = "shell" | "wrong_target" | "unknown";

export type WorkerEventPayload =
  | { type: "trust_prompt"; cwd: string; resolution?: WorkerTrustResolution }
  | {
      type: "prompt_delivery";
      promptPreview: string;
      observedTarget: WorkerPromptTarget;
      observedCwd?: string;
      recoveryArmed: boolean;
    };

export interface WorkerEvent {
  seq: number;
  kind: WorkerEventKind;
  status: WorkerStatus;
  detail?: string;
  payload?: WorkerEventPayload;
  timestamp: number;
}

export interface Worker {
  workerId: string;
  cwd: string;
  status: WorkerStatus;
  trustAutoResolve: boolean;
  trustGateCleared: boolean;
  autoRecoverPromptMisdelivery: boolean;
  promptDeliveryAttempts: number;
  promptInFlight: boolean;
  lastPrompt?: string;
  replayPrompt?: string;
  lastError?: WorkerFailure;
  createdAt: number;
  updatedAt: number;
  events: WorkerEvent[];
}

export interface WorkerReadySnapshot {
  workerId: string;
  status: WorkerStatus;
  ready: boolean;
  blocked: boolean;
  replayPromptReady: boolean;
  lastError?: WorkerFailure;
}

export interface WorkerStateSnapshot {
  workerId: string;
  status: WorkerStatus;
  isReady: boolean;
  trustGateCleared: boolean;
  promptInFlight: boolean;
  lastEvent?: WorkerEvent;
  updatedAt: number;
  secondsSinceUpdate: number;
}

function normalizePathStr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function pathMatchesAllowlist(cwd: string, trustedRoot: string): boolean {
  const c = normalizePathStr(cwd);
  const r = normalizePathStr(trustedRoot);
  if (c === r) {
    return true;
  }
  const rel = path.relative(r, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function detectTrustPrompt(lowered: string): boolean {
  return [
    "do you trust the files in this folder",
    "trust the files in this folder",
    "trust this folder",
    "allow and continue",
    "yes, proceed"
  ].some((needle) => lowered.includes(needle));
}

function isShellPrompt(trimmed: string): boolean {
  return (
    trimmed.endsWith("$") ||
    trimmed.endsWith("%") ||
    trimmed.endsWith("#") ||
    trimmed.startsWith("$") ||
    trimmed.startsWith("%") ||
    trimmed.startsWith("#")
  );
}

export function detectReadyForPrompt(screenText: string, lowered = screenText.toLowerCase()): boolean {
  if (
    ["ready for input", "ready for your input", "ready for prompt", "send a message"].some((n) =>
      lowered.includes(n)
    )
  ) {
    return true;
  }
  const lines = screenText.split("\n");
  let lastNonEmpty = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]?.trim() ?? "";
    if (t) {
      lastNonEmpty = t;
      break;
    }
  }
  if (!lastNonEmpty) {
    return false;
  }
  if (isShellPrompt(lastNonEmpty)) {
    return false;
  }
  return (
    lastNonEmpty === ">" ||
    lastNonEmpty === "›" ||
    lastNonEmpty === "❯" ||
    lastNonEmpty.startsWith("> ") ||
    lastNonEmpty.startsWith("› ") ||
    lastNonEmpty.startsWith("❯ ") ||
    lastNonEmpty.includes("│ >") ||
    lastNonEmpty.includes("│ ›") ||
    lastNonEmpty.includes("│ ❯")
  );
}

function detectRunningCue(lowered: string): boolean {
  return ["thinking", "working", "running tests", "inspecting", "analyzing"].some((n) =>
    lowered.includes(n)
  );
}

function promptPreviewText(prompt: string): string {
  const trimmed = prompt.trim();
  if ([...trimmed].length <= 48) {
    return trimmed;
  }
  const preview = [...trimmed].slice(0, 48).join("").trimEnd();
  return `${preview}…`;
}

function isShellPromptToken(token: string): boolean {
  return ["$", "%", "#", ">", "›", "❯"].includes(token);
}

function looksLikeCwdLabel(candidate: string): boolean {
  return (
    candidate.startsWith("/") ||
    candidate.startsWith("~") ||
    candidate.startsWith(".") ||
    candidate.includes("/")
  );
}

function detectObservedShellCwd(screenText: string): string | undefined {
  for (const line of screenText.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    const idx = tokens.findIndex((t) => isShellPromptToken(t));
    if (idx > 0) {
      const candidate = tokens[idx - 1];
      if (candidate && looksLikeCwdLabel(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function cwdMatchesObservedTarget(expectedCwd: string, observedCwd: string): boolean {
  const expected = normalizePathStr(expectedCwd);
  const expectedBase = path.basename(expected);
  const observedBase = path.basename(observedCwd.trim().replace(/:$/, ""));
  const expStr = expected;
  return (
    expStr.endsWith(observedCwd) ||
    observedCwd.endsWith(expStr) ||
    expectedBase === observedBase
  );
}

interface PromptDeliveryObservation {
  target: WorkerPromptTarget;
  observedCwd?: string;
}

function detectPromptMisdelivery(
  screenText: string,
  lowered: string,
  prompt: string | undefined,
  expectedCwd: string
): PromptDeliveryObservation | undefined {
  if (!prompt) {
    return undefined;
  }
  const firstLine = prompt.split("\n").find((l) => l.trim());
  const promptSnippet = (firstLine ?? "").trim().toLowerCase();
  if (!promptSnippet) {
    return undefined;
  }
  const promptVisible = lowered.includes(promptSnippet);

  const observedCwd = detectObservedShellCwd(screenText);
  if (observedCwd && promptVisible && !cwdMatchesObservedTarget(expectedCwd, observedCwd)) {
    return { target: "wrong_target", observedCwd };
  }

  const shellError = [
    "command not found",
    "syntax error near unexpected token",
    "parse error near",
    "no such file or directory",
    "unknown command"
  ].some((needle) => lowered.includes(needle));

  if (shellError && promptVisible) {
    return { target: "shell" };
  }
  return undefined;
}

function promptMisdeliveryDetail(observation: PromptDeliveryObservation): string {
  switch (observation.target) {
    case "shell":
      return "shell misdelivery detected";
    case "wrong_target":
      return "prompt landed in wrong target";
    default:
      return "prompt delivery failure detected";
  }
}

function promptMisdeliveryIsRelevant(worker: Worker): boolean {
  return worker.promptInFlight && worker.lastPrompt !== undefined;
}

function pushEvent(
  worker: Worker,
  kind: WorkerEventKind,
  status: WorkerStatus,
  detail: string | undefined,
  payload: WorkerEventPayload | undefined
): void {
  const timestamp = nowSecs();
  const seq = worker.events.length + 1;
  worker.updatedAt = timestamp;
  worker.events.push({ seq, kind, status, detail, payload, timestamp });
  emitStateFile(worker);
}

export class WorkerRegistry {
  private workers = new Map<string, Worker>();
  private counter = 0;

  create(cwd: string, trustedRoots: string[], autoRecoverPromptMisdelivery: boolean): Worker {
    this.counter += 1;
    const ts = nowSecs();
    const workerId = `worker_${ts.toString(16)}_${this.counter}`;
    const trustAutoResolve = trustedRoots.some((root) => pathMatchesAllowlist(cwd, root));
    const worker: Worker = {
      workerId,
      cwd,
      status: "spawning",
      trustAutoResolve,
      trustGateCleared: false,
      autoRecoverPromptMisdelivery,
      promptDeliveryAttempts: 0,
      promptInFlight: false,
      createdAt: ts,
      updatedAt: ts,
      events: []
    };
    pushEvent(worker, "spawning", "spawning", "worker created", undefined);
    this.workers.set(workerId, worker);
    return { ...worker, events: [...worker.events] };
  }

  get(workerId: string): Worker | undefined {
    const w = this.workers.get(workerId);
    return w ? cloneWorker(w) : undefined;
  }

  observe(workerId: string, screenText: string): Worker {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`worker not found: ${workerId}`);
    }
    const lowered = screenText.toLowerCase();

    if (!worker.trustGateCleared && detectTrustPrompt(lowered)) {
      worker.status = "trust_required";
      worker.lastError = {
        kind: "trust_gate",
        message: "worker boot blocked on trust prompt",
        createdAt: nowSecs()
      };
      pushEvent(worker, "trust_required", "trust_required", "trust prompt detected", {
        type: "trust_prompt",
        cwd: worker.cwd
      });

      if (worker.trustAutoResolve) {
        worker.trustGateCleared = true;
        worker.lastError = undefined;
        worker.status = "spawning";
        pushEvent(
          worker,
          "trust_resolved",
          "spawning",
          "allowlisted repo auto-resolved trust prompt",
          { type: "trust_prompt", cwd: worker.cwd, resolution: "auto_allowlisted" }
        );
      } else {
        return cloneWorker(worker);
      }
    }

    if (promptMisdeliveryIsRelevant(worker)) {
      const observation = detectPromptMisdelivery(
        screenText,
        lowered,
        worker.lastPrompt,
        worker.cwd
      );
      if (observation) {
        const preview = promptPreviewText(worker.lastPrompt ?? "");
        const message =
          observation.target === "shell"
            ? `worker prompt landed in shell instead of coding agent: ${preview}`
            : observation.target === "wrong_target"
              ? `worker prompt landed in the wrong target instead of ${worker.cwd}: ${preview}`
              : `worker prompt delivery failed before reaching coding agent: ${preview}`;
        worker.lastError = {
          kind: "prompt_delivery",
          message,
          createdAt: nowSecs()
        };
        worker.promptInFlight = false;
        pushEvent(worker, "prompt_misdelivery", "failed", promptMisdeliveryDetail(observation), {
          type: "prompt_delivery",
          promptPreview: preview,
          observedTarget: observation.target,
          observedCwd: observation.observedCwd,
          recoveryArmed: false
        });
        if (worker.autoRecoverPromptMisdelivery) {
          worker.replayPrompt = worker.lastPrompt;
          worker.status = "ready_for_prompt";
          pushEvent(
            worker,
            "prompt_replay_armed",
            "ready_for_prompt",
            "prompt replay armed after prompt misdelivery",
            {
              type: "prompt_delivery",
              promptPreview: preview,
              observedTarget: observation.target,
              observedCwd: observation.observedCwd,
              recoveryArmed: true
            }
          );
        } else {
          worker.status = "failed";
        }
        return cloneWorker(worker);
      }
    }

    if (detectRunningCue(lowered) && worker.promptInFlight) {
      worker.promptInFlight = false;
      worker.status = "running";
      worker.lastError = undefined;
    }

    if (detectReadyForPrompt(screenText, lowered) && worker.status !== "ready_for_prompt") {
      worker.status = "ready_for_prompt";
      worker.promptInFlight = false;
      if (worker.lastError?.kind === "trust_gate") {
        worker.lastError = undefined;
      }
      pushEvent(
        worker,
        "ready_for_prompt",
        "ready_for_prompt",
        "worker is ready for prompt delivery",
        undefined
      );
    }

    return cloneWorker(worker);
  }

  resolveTrust(workerId: string): Worker {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`worker not found: ${workerId}`);
    }
    if (worker.status !== "trust_required") {
      throw new Error(
        `worker ${workerId} is not waiting on trust; current status: ${worker.status}`
      );
    }
    worker.trustGateCleared = true;
    worker.lastError = undefined;
    worker.status = "spawning";
    pushEvent(worker, "trust_resolved", "spawning", "trust prompt resolved manually", {
      type: "trust_prompt",
      cwd: worker.cwd,
      resolution: "manual_approval"
    });
    return cloneWorker(worker);
  }

  sendPrompt(workerId: string, prompt: string | undefined): Worker {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`worker not found: ${workerId}`);
    }
    if (worker.status !== "ready_for_prompt") {
      throw new Error(
        `worker ${workerId} is not ready for prompt delivery; current status: ${worker.status}`
      );
    }
    const trimmed = prompt?.trim();
    const nextPrompt =
      trimmed && trimmed.length > 0 ? trimmed : worker.replayPrompt;
    if (!nextPrompt) {
      throw new Error(`worker ${workerId} has no prompt to send or replay`);
    }
    worker.promptDeliveryAttempts += 1;
    worker.promptInFlight = true;
    worker.lastPrompt = nextPrompt;
    worker.replayPrompt = undefined;
    worker.lastError = undefined;
    worker.status = "running";
    pushEvent(
      worker,
      "running",
      "running",
      `prompt dispatched to worker: ${promptPreviewText(nextPrompt)}`,
      undefined
    );
    return cloneWorker(worker);
  }

  awaitReady(workerId: string): WorkerReadySnapshot {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`worker not found: ${workerId}`);
    }
    return {
      workerId: worker.workerId,
      status: worker.status,
      ready: worker.status === "ready_for_prompt",
      blocked: worker.status === "trust_required" || worker.status === "failed",
      replayPromptReady: worker.replayPrompt !== undefined,
      lastError: worker.lastError
    };
  }

  restart(workerId: string): Worker {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`worker not found: ${workerId}`);
    }
    worker.status = "spawning";
    worker.trustGateCleared = false;
    worker.lastPrompt = undefined;
    worker.replayPrompt = undefined;
    worker.lastError = undefined;
    worker.promptDeliveryAttempts = 0;
    worker.promptInFlight = false;
    pushEvent(worker, "restarted", "spawning", "worker restarted", undefined);
    return cloneWorker(worker);
  }

  terminate(workerId: string): Worker {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`worker not found: ${workerId}`);
    }
    worker.status = "finished";
    worker.promptInFlight = false;
    pushEvent(worker, "finished", "finished", "worker terminated by control plane", undefined);
    return cloneWorker(worker);
  }

  observeCompletion(workerId: string, finishReason: string, tokensOutput: number): Worker {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`worker not found: ${workerId}`);
    }
    const isProviderFailure =
      (finishReason === "unknown" && tokensOutput === 0) || finishReason === "error";
    if (isProviderFailure) {
      const message =
        finishReason === "unknown" && tokensOutput === 0
          ? "session completed with finish='unknown' and zero output — provider degraded or context exhausted"
          : `session failed with finish='${finishReason}' — provider error`;
      worker.lastError = {
        kind: "provider",
        message,
        createdAt: nowSecs()
      };
      worker.status = "failed";
      worker.promptInFlight = false;
      pushEvent(worker, "failed", "failed", "provider failure classified", undefined);
    } else {
      worker.status = "finished";
      worker.promptInFlight = false;
      worker.lastError = undefined;
      pushEvent(
        worker,
        "finished",
        "finished",
        `session completed: finish='${finishReason}', tokens=${tokensOutput}`,
        undefined
      );
    }
    return cloneWorker(worker);
  }
}

function cloneWorker(worker: Worker): Worker {
  return {
    ...worker,
    events: [...worker.events],
    lastError: worker.lastError ? { ...worker.lastError } : undefined
  };
}

export function workerStatePath(cwd: string): string {
  return path.join(cwd, ".clench", "worker-state.json");
}

export function workerStateSnapshot(worker: Worker, now = nowSecs()): WorkerStateSnapshot {
  return {
    workerId: worker.workerId,
    status: worker.status,
    isReady: worker.status === "ready_for_prompt",
    trustGateCleared: worker.trustGateCleared,
    promptInFlight: worker.promptInFlight,
    lastEvent: worker.events.at(-1) ? { ...worker.events.at(-1)! } : undefined,
    updatedAt: worker.updatedAt,
    secondsSinceUpdate: Math.max(0, now - worker.updatedAt)
  };
}

function emitStateFile(worker: Worker): void {
  const filePath = workerStatePath(worker.cwd);
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      tmpPath,
      `${JSON.stringify(workerStateSnapshot(worker), null, 2)}\n`,
      "utf8"
    );
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Best-effort observability surface; worker transitions must remain in-memory even if disk fails.
  }
}
