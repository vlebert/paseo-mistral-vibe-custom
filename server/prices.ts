import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelPrices {
  input: number;
  output: number;
  cached: number;
}

const FALLBACK_PRICES: Record<string, ModelPrices> = {
  "mistral-large-4": { input: 0.7, output: 2.1, cached: 0.07 },
  "zai-glm-5-3": { input: 1.4, output: 4.4, cached: 0.26 },
};

let pricesCache: { at: number; mtimeMs: number; prices: Record<string, ModelPrices> } | null = null;
const PRICES_CACHE_MS = 60_000;

function parseTomlNumber(raw: string): number | undefined {
  // Strip inline comments and quotes; require a finite number.
  const cleaned = raw.split("#")[0].trim().replace(/^"|"$/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

/** Parse [[models]] blocks of ~/.vibe/config.toml for per-alias prices ($/M tokens). Cached by mtime. */
export function readVibePrices(): Record<string, ModelPrices> {
  const path = join(homedir(), ".vibe", "config.toml");
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (pricesCache && Date.now() - pricesCache.at < PRICES_CACHE_MS && pricesCache.mtimeMs === mtimeMs) {
      return pricesCache.prices;
    }
    const text = readFileSync(path, "utf8");
    const prices: Record<string, ModelPrices> = { ...FALLBACK_PRICES };
    let alias: string | undefined;
    let input: number | undefined;
    let output: number | undefined;
    let cached: number | undefined;
    const flush = () => {
      if (alias && input !== undefined && output !== undefined) {
        prices[alias] = { input, output, cached: cached ?? input };
      }
      alias = undefined;
      input = undefined;
      output = undefined;
      cached = undefined;
    };
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("[[")) {
        flush();
        continue;
      }
      if (line.startsWith("[")) continue;
      const match = /^(\w+)\s*=\s*(.+)$/.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      if (key === "alias") alias = value.split("#")[0].trim().replace(/^"|"$/g, "");
      else if (key === "input_price") input = parseTomlNumber(value);
      else if (key === "output_price") output = parseTomlNumber(value);
      else if (key === "cached_input_price") cached = parseTomlNumber(value);
    }
    flush();
    pricesCache = { at: Date.now(), mtimeMs, prices };
    return prices;
  } catch {
    return pricesCache?.prices ?? { ...FALLBACK_PRICES };
  }
}

/** Estimated session cost in USD from token counts and $/M prices. */
export function estimateCostUsd(
  usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number },
  modelAlias: string | undefined,
): number | undefined {
  const prices = readVibePrices();
  const price = (modelAlias ? prices[modelAlias] : undefined) ?? prices["mistral-large-4"];
  if (!price) return undefined;
  const prompt = usage.promptTokens ?? 0;
  const cached = Math.min(usage.cachedTokens ?? 0, prompt);
  const uncached = prompt - cached;
  const output = usage.completionTokens ?? 0;
  const cost = (uncached * price.input + cached * price.cached + output * price.output) / 1_000_000;
  return Number.isFinite(cost) ? cost : undefined;
}
