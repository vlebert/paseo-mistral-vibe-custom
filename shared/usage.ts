import { z } from "zod";

export const usageItemSchema = z.object({
  /** Context window tokens currently used. */
  used: z.number().optional(),
  /** Context window size for the active model. */
  size: z.number().optional(),
  /** Session cost in USD reported by vibe. */
  costUsd: z.number().optional(),
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  cachedTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  updatedAt: z.string(),
});

export type UsageItemData = z.infer<typeof usageItemSchema>;
