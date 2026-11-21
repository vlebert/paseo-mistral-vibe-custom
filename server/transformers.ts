import type { AcpTransformer, AcpVendorUpdate } from "@getpaseo/plugin/server/acp";
import { usageItemSchema } from "../shared/usage.js";

export const PLUGIN_ID = "mistral-vibe-custom";

/**
 * Per-native-session state. Everything here is keyed by the vibe-acp native session id so
 * parallel sessions never share thinking levels or pending revert tokens.
 * vibe-acp declares its thinking option with id "thinking" and the non-standard category
 * "thinking" (the ACP spec reserves "thought_level"), which is why the stock adapter never
 * surfaces it: we capture the level list from config_option_update and remap writes in
 * configure().
 */
export const transformerState = {
  thinkingBySession: new Map<string, { levels: string[]; current?: string }>(),
  /** Native session id -> native entry id of the last streamed user message (revert token). */
  pendingUserEntry: new Map<string, string>(),
  /** Last known level list, for the catalog probe (which has no real session). */
  fallbackLevels: [] as string[],
  fallbackCurrent: undefined as string | undefined,
};

const DEFAULT_LEVELS = ["low", "medium", "high"];

export function currentThinkingOptions(nativeSessionId?: string) {
  const perSession = nativeSessionId ? transformerState.thinkingBySession.get(nativeSessionId) : undefined;
  const levels = perSession?.levels.length ? perSession.levels : transformerState.fallbackLevels.length ? transformerState.fallbackLevels : DEFAULT_LEVELS;
  const current = perSession?.current ?? transformerState.fallbackCurrent ?? levels[0];
  return {
    levels,
    current,
    thinkingOptions: levels.map((id) => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      isDefault: id === current,
    })),
  };
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pick(update: Record<string, unknown>, camel: string, snake: string): unknown {
  return update[camel] ?? update[snake];
}

export const vibeTransformer: AcpTransformer = {
  async discover(catalog, ctx) {
    // The catalog probe has no user session; try reading the live value, else last known.
    try {
      const values = await ctx.config.read();
      const current = text(values.thinking);
      if (current) transformerState.fallbackCurrent = current;
    } catch {
      // config not readable during discovery; fall back to captured levels
    }
    const { thinkingOptions, current } = currentThinkingOptions();
    return {
      ...catalog,
      thinkingOptions,
      defaultThinkingOption: current,
      models: catalog.models.map((model) => ({
        ...model,
        thinkingOptions,
        defaultThinkingOptionId: current,
      })),
    };
  },

  async configure(change, ctx) {
    if (change.target !== "thinking") return "pass";
    const level = change.value;
    if (level === null) return "pass";
    await ctx.config.set("thinking", level);
    transformerState.fallbackCurrent = level;
    return "handled";
  },
};

/**
 * Handle one raw ACP `session/update` payload. Standard updates are tapped from the
 * connector stream (the shim only forwards vendor extension methods to transformers, so
 * `session/update` never reaches `AcpTransformer.notification`).
 * `nativeSessionId` keys all captured state so parallel sessions stay isolated.
 * Returns vendor updates to emit (currently: the usage capture consumed by the wrapper).
 */
export function processSessionUpdate(
  update: Record<string, unknown>,
  nativeSessionId: string | undefined,
  boundarySessionId: string | null,
): AcpVendorUpdate[] {
  const kind = pick(update, "sessionUpdate", "session_update") as string | undefined;

  if (kind === "config_option_update") {
    const options = (pick(update, "configOptions", "config_options") ?? []) as Array<Record<string, unknown>>;
    for (const option of options) {
      if (option?.category === "thinking" && Array.isArray(option.options)) {
        const levels = option.options
          .map((entry) => text((entry as Record<string, unknown>)?.value) ?? text((entry as Record<string, unknown>)?.id) ?? "")
          .filter((value) => value.length > 0);
        const current = text(pick(option, "currentValue", "current_value"));
        if (nativeSessionId) {
          transformerState.thinkingBySession.set(nativeSessionId, { levels, current: current ?? undefined });
        }
        if (levels.length > 0) transformerState.fallbackLevels = levels;
        if (current) transformerState.fallbackCurrent = current;
      }
    }
    return [];
  }

  if (kind === "user_message_chunk") {
    const id = text(pick(update, "messageId", "message_id"));
    if (id && nativeSessionId) transformerState.pendingUserEntry.set(nativeSessionId, id);
    return [];
  }

  if (kind === "usage_update" && boundarySessionId) {
    const meta = (update._meta ?? {}) as Record<string, unknown>;
    // vibe sends `cost: {amount, currency}` at the top level (see _send_usage_update).
    const cost = update.cost as Record<string, unknown> | undefined;
    const data = usageItemSchema.parse({
      used: num(pick(update, "used", "used_tokens")),
      size: num(pick(update, "size", "context_window")),
      costUsd: num(cost?.amount ?? cost?.value),
      promptTokens: num(pick(meta, "promptTokens", "prompt_tokens")),
      completionTokens: num(pick(meta, "completionTokens", "completion_tokens")),
      cachedTokens: num(pick(meta, "cachedTokens", "cached_tokens")),
      totalTokens: num(pick(meta, "totalTokens", "total_tokens")),
      updatedAt: new Date().toISOString(),
    });
    return [
      {
        type: "timeline",
        item: {
          type: "plugin",
          pluginId: PLUGIN_ID,
          kind: "vibe-usage",
          version: 1,
          id: `vibe-usage-${boundarySessionId}`,
          data,
        },
      },
    ];
  }

  return [];
}
