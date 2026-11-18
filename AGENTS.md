# AGENTS.md — mistral-vibe-custom

Paseo plugin that runs Mistral Vibe (`vibe-acp`) as a provider labeled "Mistral Vibe Custom",
adding what the stock ACP shim does not surface: thinking-level selector, context ring /
usage data, monthly budget in the usage modal, and conversation rewind.

## Workflow

- Typecheck after every change: `npx tsc --noEmit` (must exit 0).
- Reload on the daemon after edits: `paseo plugin reload mistral-vibe-custom`, then check
  `paseo plugin ls` (running, no error) and `paseo plugin logs mistral-vibe-custom`.
- Test with a real agent: `paseo run --provider mistral-vibe-custom/mistral-large-4-0-3 ...`
  then `paseo inspect <id> --json`, `paseo logs <id> --json`, `paseo usage ls --json --refresh`.
- Archive test agents afterwards (`paseo archive <id>`).
- The desktop app caches the client bundle: restart the Paseo app to see client-side changes.
- Never restart the daemon from here while a session is running inside Paseo.

## Points of attention (known fragilities)

- **vibe-acp internals**: the plugin depends on the config option id `thinking` with the
  non-standard category `thinking` (the ACP spec reserves `thought_level`), the extension
  methods `_rewind/to` and `_account/read`, the `usage_update` payload and its `_meta`
  fields, and camelCase aliases. A vibe upgrade can break any of these silently; keep
  fallbacks and log lines (`paseo plugin logs`). The durable fix is upstream: vibe should
  use the `thought_level` category.
- **ACP shim limitation**: `runAcpProvider` answers `request.failed` to `session.revert`,
  so the plugin owns the vibe-acp process through a custom connector (`server/vibe-acp.ts`)
  with a JSON-RPC side channel. If Paseo ships native ACP revert (getpaseo/paseo#5748),
  delete the connector/wrapper and keep only the transformers.
- **Process↔session mapping is exact, not positional**: each handle records the native
  session ids it serves (from `session/new` responses and `session/load` requests) and is
  matched by id at `session.opened`. Do not reintroduce index-based heuristics; parallel
  sessions are the norm. Verified with 3 parallel agents.
- **revertToken attachment is timing-sensitive**: two paths — live (re-emit the
  `user_message` item with the token when the chunk arrives) and replay (attach on the
  item emitted from chunks). If vibe changes when `user_message_chunk` is sent, tokens may
  attach late or missing.
- **Usage cards do not attach to plugin-provider agents**: the ring popover's `AgentUsage`
  section needs `usageScopeKey`, which plugin sessions do not expose (daemon-side
  `session.usageSession()`). Session data (context %, tokens, cost) reaches the ring via
  the patched `session.usage` events; only the monthly allowance shows in the host usage
  modal. Fixing this needs daemon support (expose usageSession for plugin providers).
- **Icon**: provider icons are monochrome SVG with `fill="currentColor"` (theme-tinted).
  The manifest `icon` for the registry listing must be a PNG, not SVG.
- **Security**: plugin code is trusted and unsandboxed on the daemon host. Never log
  credentials; the side channel only carries session/message ids.

## Cross-provider session history (mistral-vibe vs mistral-vibe-custom)

Both providers spawn the same `vibe-acp` binary, so they share one session store
(`session/list` returns the same native session ids for both — verified against the daemon
via `fetchRecentProviderSessions` with each provider filter). Consequences:

- The Custom provider already lists AND opens conversations created with the native
  provider (and vice versa): `session.open` with `persistence.data.sessionId` maps to
  vibe-acp `session/load`. Verified end-to-end: importing a native-created vibe session
  through `mistral-vibe-custom` replays its history correctly.
- The apparent "split" is daemon-side, not plugin-side: listing entries are tagged with
  the listing provider and the handle encoding differs (native: raw uuid; plugin:
  `plugin:{...}`), so the same conversation can appear once per provider in the combined
  import view, and the "already imported" filter is keyed `(provider, handle)` — importing
  under one provider does not hide it under the other. The plugin cannot change either:
  the `plugin:` encoding and the per-provider dedup key live in the daemon
  (`plugin-provider.js` `encodePersistence`, `import-sessions.js`
  `toProviderSessionHandleKey`). True cross-provider dedup is an upstream Paseo change.
- vibe enforces a per-session lease (`vibe/core/session/session_lease.py`): a session can
  only be open in one vibe-acp process at a time ("Session is already open"), so the same
  conversation cannot be open simultaneously under both providers — same limitation as
  within a single provider.

## External code review (2026-11-18, subagent "reviewer")

Verdict before fixes: "not safe with parallel sessions". Findings and their fixes:

- HIGH — vibe-acp child processes leaked (no cancel/close path). Fixed: shutdown/cancel
  hooks terminate the child; `close()` kills every handle of the connection.
- HIGH — uncaught TypeError when enqueueing after cancel. Fixed: guarded enqueue, pending
  requests rejected on exit/close (with timeout), 16 MB stdout buffer cap.
- HIGH — pending `callExt` hung forever if the process died. Fixed: 30 s timeout on every
  side-channel call.
- HIGH — usage probe could hang/leak, no in-flight dedup, no negative cache. Fixed in
  `server/usage-source.ts`: one shared in-flight probe promise, 60 s positive cache,
  30 s negative cache, relies on the callExt timeout.
- HIGH — global `pendingUserEntryId` misattributed user messages across parallel sessions.
  Fixed: state (thinking level, pending user entry) keyed per native vibe session id.
- MEDIUM — stale per-session maps on `session.closed`. Fixed: prune on close.
- MEDIUM — shared mutable `emitEvent`. Fixed: per-connection emit closure.
- MEDIUM — NaN prices/cost from malformed TOML. Fixed: `Number.isFinite` guards,
  inline-comment stripping, mtime+TTL cached parse in `server/prices.ts`.
- MEDIUM — unconditional extra capabilities advertised. Fixed: intersected with the
  request's own capabilities.
- LOW — dead exports/files. Fixed: `client/web.ts` and the client renderer deleted;
  `index.client.tsx` is an empty contribute.

Re-verified after fixes: `npx tsc --noEmit` exit 0; plugin reloads running; 3 parallel
agents answered correctly with exact native-id mapping; `pgrep vibe-acp` back to baseline
after archiving test agents (no leaks); `paseo usage ls --json --refresh` shows only the
monthly allowance window.

## Layout

- `index.server.ts` — registers provider + usage source.
- `server/provider.ts` — provider wrapper: extra capabilities, `session.revert` → `_rewind/to`,
  event patching (config, usage, revertToken).
- `server/vibe-acp.ts` — spawn + ndjson framing + native-id tracking + `callExt`.
- `server/transformers.ts` — thinking remap (discover/configure) + `session/update` parsing.
- `server/usage-source.ts` — monthly budget via `_account/read` probe (one in-flight probe,
  60 s positive / 30 s negative cache).
- `server/prices.ts` — model prices from `~/.vibe/config.toml` + cost estimate.
- `shared/usage.ts` — zod schema for usage payloads.
- `paseo-plugin.json` — manifest; id must stay kebab-case; `requirements.paseo` is the floor.

## Publishing (see public-docs/plugins/publishing.md in getpaseo/paseo)

- GitHub repo: public, containing manifest, runtime entries, imported files, assets.
- npm: scoped name `@scope/paseo-<name>`, `repository` pointing at the public GitHub repo,
  no `private`, version set. Only devDependencies here (host libs), so no runtime lockfile
  or build step is required.
- `OVERVIEW.md` must not contain `paseo plugin add` / `npm install` strings (validator
  rejects them); factual tone, no marketing/badges/changelog.
- Registry submission: issue form in github.com/getpaseo/plugins (submit-plugin.yml),
  source = public GitHub repo or npm package; reviewer pins the approved revision.
