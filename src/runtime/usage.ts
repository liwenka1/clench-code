import { apiModelIdForSelection, type Usage } from "../api";
import type { Session } from "./session";

export interface ModelPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cacheCreationCostPerMillion: number;
  cacheReadCostPerMillion: number;
}

export interface UsageCostEstimate {
  inputCostUsd: number;
  outputCostUsd: number;
  cacheCreationCostUsd: number;
  cacheReadCostUsd: number;
  totalCostUsd: number;
}

export class UsageTracker {
  private readonly turnsCount: number;
  private readonly usage: Usage;
  private readonly latestTurn: Usage;

  constructor(turnsCount = 0, usage: Usage = zeroUsage(), latestTurn: Usage = zeroUsage()) {
    this.turnsCount = turnsCount;
    this.usage = usage;
    this.latestTurn = latestTurn;
  }

  static fromSession(session: Session): UsageTracker {
    let turns = 0;
    const cumulative = zeroUsage();
    let latest = zeroUsage();
    for (const message of session.messages) {
      if (message.role === "assistant" && message.usage) {
        turns += 1;
        latest = { ...message.usage };
        cumulative.input_tokens += message.usage.input_tokens;
        cumulative.output_tokens += message.usage.output_tokens;
        cumulative.cache_creation_input_tokens =
          (cumulative.cache_creation_input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0);
        cumulative.cache_read_input_tokens =
          (cumulative.cache_read_input_tokens ?? 0) +
          (message.usage.cache_read_input_tokens ?? 0);
      }
    }
    return new UsageTracker(turns, cumulative, latest);
  }

  record(usage: Usage): UsageTracker {
    return new UsageTracker(this.turnsCount + 1, {
      input_tokens: this.usage.input_tokens + usage.input_tokens,
      output_tokens: this.usage.output_tokens + usage.output_tokens,
      cache_creation_input_tokens:
        (this.usage.cache_creation_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      cache_read_input_tokens:
        (this.usage.cache_read_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
    }, { ...usage });
  }

  turns(): number {
    return this.turnsCount;
  }

  cumulativeUsage(): Usage {
    return { ...this.usage };
  }

  currentTurnUsage(): Usage {
    return { ...this.latestTurn };
  }
}

export function zeroUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };
}

export function totalTokens(usage: Usage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

export function defaultSonnetPricing(): ModelPricing {
  return {
    inputCostPerMillion: 15,
    outputCostPerMillion: 75,
    cacheCreationCostPerMillion: 18.75,
    cacheReadCostPerMillion: 1.5
  };
}

export function pricingForModel(model: string): ModelPricing | undefined {
  const normalized = apiModelIdForSelection(model).toLowerCase();
  if (normalized.includes("haiku")) {
    return {
      inputCostPerMillion: 1,
      outputCostPerMillion: 5,
      cacheCreationCostPerMillion: 1.25,
      cacheReadCostPerMillion: 0.1
    };
  }
  if (normalized.includes("opus")) {
    return {
      inputCostPerMillion: 15,
      outputCostPerMillion: 75,
      cacheCreationCostPerMillion: 18.75,
      cacheReadCostPerMillion: 1.5
    };
  }
  if (normalized.includes("sonnet")) {
    return defaultSonnetPricing();
  }
  return undefined;
}

export function estimateCostUsd(
  usage: Usage,
  pricing: ModelPricing = defaultSonnetPricing()
): UsageCostEstimate {
  const inputCostUsd = costForTokens(usage.input_tokens, pricing.inputCostPerMillion);
  const outputCostUsd = costForTokens(usage.output_tokens, pricing.outputCostPerMillion);
  const cacheCreationCostUsd = costForTokens(
    usage.cache_creation_input_tokens ?? 0,
    pricing.cacheCreationCostPerMillion
  );
  const cacheReadCostUsd = costForTokens(
    usage.cache_read_input_tokens ?? 0,
    pricing.cacheReadCostPerMillion
  );

  return {
    inputCostUsd,
    outputCostUsd,
    cacheCreationCostUsd,
    cacheReadCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd + cacheCreationCostUsd + cacheReadCostUsd
  };
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

export function summaryLinesForModel(
  label: string,
  usage: Usage,
  model?: string
): string[] {
  const pricing = model ? pricingForModel(model) : undefined;
  const cost = estimateCostUsd(usage, pricing ?? defaultSonnetPricing());
  const modelSuffix = model ? ` model=${model}` : "";
  const pricingSuffix = model && !pricing ? " pricing=estimated-default" : "";

  return [
    `${label}: total_tokens=${totalTokens(usage)} input=${usage.input_tokens} output=${usage.output_tokens} cache_write=${usage.cache_creation_input_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0} estimated_cost=${formatUsd(cost.totalCostUsd)}${modelSuffix}${pricingSuffix}`,
    `  cost breakdown: input=${formatUsd(cost.inputCostUsd)} output=${formatUsd(cost.outputCostUsd)} cache_write=${formatUsd(cost.cacheCreationCostUsd)} cache_read=${formatUsd(cost.cacheReadCostUsd)}`
  ];
}

function costForTokens(tokens: number, usdPerMillionTokens: number): number {
  return (tokens / 1_000_000) * usdPerMillionTokens;
}
