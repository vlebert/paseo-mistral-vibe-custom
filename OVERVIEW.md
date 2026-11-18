# Mistral Vibe Custom

Runs Mistral Vibe (`vibe-acp`) as a Paseo provider under the name "Mistral Vibe Custom", alongside the built-in ACP entry, and adds what the generic ACP adapter does not surface today:

- a thinking-level selector in the composer, mapped to vibe-acp's `thinking` config option (vibe-acp declares it with the non-standard category `thinking` instead of the reserved `thought_level`, which is why the stock adapter shows no selector);
- a per-session usage timeline item: context window used/size, prompt/completion/cached tokens with cache-hit percentage, and session cost in USD, read from vibe's `usage_update` notifications;
- conversation rewind (and combined rewind with file restore) through vibe-acp's `rewind/to` extension, exposed as Paseo's session revert.

The plugin spawns `vibe-acp` itself (ndjson over stdio) so it can call vendor extension methods the ACP shim does not forward. Requires Paseo >= 0.16.0 and a `vibe-acp` binary on the daemon host's PATH.
