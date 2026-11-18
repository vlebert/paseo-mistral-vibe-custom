import { homedir } from "node:os";
import { z } from "zod";
import type { UsageSourceRegistration, UsageReport } from "@getpaseo/plugin/server/usage";
import { windowFromUsedPct } from "@getpaseo/plugin/server/usage";
import { startVibeAcp } from "./vibe-acp.js";

interface AccountBudget {
  usagePct: number | null;
  resetAt: string | null;
  payg: boolean;
}

let budgetCache: { at: number; budget: AccountBudget | null } | null = null;
let budgetInFlight: Promise<AccountBudget | null> | null = null;
const BUDGET_CACHE_MS = 60_000;
const NEGATIVE_CACHE_MS = 30_000;

/**
 * Monthly Vibe Code allowance comes from vibe's billing API, exposed over ACP as the
 * `_account/read` extension (account.budget: usage_percentage, reset_at, payg_enabled).
 * Needs a live session in the process, so we spawn a short-lived probe vibe-acp.
 * Concurrent callers share one in-flight probe; failures are negatively cached
 * briefly so a broken probe does not spawn processes on every fetch.
 */
async function readAccountBudget(): Promise<AccountBudget | null> {
  if (budgetCache) {
    const ttl = budgetCache.budget ? BUDGET_CACHE_MS : NEGATIVE_CACHE_MS;
    if (Date.now() - budgetCache.at < ttl) return budgetCache.budget;
  }
  if (!budgetInFlight) {
    budgetInFlight = probeAccountBudget().finally(() => {
      budgetInFlight = null;
    });
  }
  return budgetInFlight;
}

async function probeAccountBudget(): Promise<AccountBudget | null> {
  const handle = startVibeAcp(undefined);
  try {
    await handle.callExt("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "paseo-plugin-mistral-vibe-custom", version: "0" },
    });
    const session = (await handle.callExt("session/new", { cwd: homedir(), mcpServers: [] })) as {
      sessionId: string;
    };
    const account = (await handle.callExt("_account/read", { sessionId: session.sessionId })) as {
      budget?: {
        usagePercentage?: unknown;
        usage_percentage?: unknown;
        resetAt?: unknown;
        reset_at?: unknown;
        paygEnabled?: unknown;
        payg_enabled?: unknown;
      };
    };
    const raw = account?.budget;
    const budget: AccountBudget | null = raw
      ? {
          usagePct: typeof raw.usagePercentage === "number" ? raw.usagePercentage : typeof raw.usage_percentage === "number" ? raw.usage_percentage : null,
          resetAt: typeof raw.resetAt === "string" ? raw.resetAt : typeof raw.reset_at === "string" ? raw.reset_at : null,
          payg: raw.paygEnabled === true || raw.payg_enabled === true,
        }
      : null;
    budgetCache = { at: Date.now(), budget };
    return budget;
  } catch (error) {
    console.error("[mistral-vibe-custom] account/read probe failed:", error instanceof Error ? error.message : String(error));
    budgetCache = { at: Date.now(), budget: null };
    return null;
  } finally {
    await handle.close();
  }
}

export function createVibeUsageSource(): UsageSourceRegistration {
  return {
    id: "mistral-vibe-custom",
    label: "Mistral Vibe",
    input: z.looseObject({}),
    discover: async () => [
      {
        key: "mistral-vibe-custom",
        label: "Mistral Vibe",
        harness: "Mistral Vibe",
        input: {},
      },
    ],
    fetch: async (): Promise<UsageReport> => {
      // Global account info only: the monthly allowance. Session-level data (context
      // window, tokens, cost) is per-agent and shown from the composer context ring.
      const budget = await readAccountBudget();
      if (!budget) {
        return { status: "unavailable", problem: { kind: "no_quota", detail: "No vibe billing data available" } };
      }
      return {
        status: "available",
        planLabel: "Mistral Vibe",
        windows: [
          windowFromUsedPct({
            id: "vibe-monthly-budget",
            label: budget.payg ? "Monthly allowance (pay-as-you-go past 100%)" : "Monthly allowance",
            shortLabel: "mo",
            summary: true,
            utilizationPct: budget.usagePct,
            resetsAt: budget.resetAt,
          }),
        ],
      };
    },
  };
}
