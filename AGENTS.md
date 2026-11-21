# AGENTS.md — mistral-vibe-custom

Paseo plugin that runs Mistral Vibe (`vibe-acp`) as a provider labeled "Mistral Vibe Custom",
adding what the generic ACP adapter does not surface: thinking-level selector, context ring /
usage data, monthly budget in the usage modal, conversation rewind, and the `ask_user_question`
tool.

## Workflow

- Typecheck after every change: `npx tsc --noEmit` (must exit 0).
- Reload on the daemon after edits: `paseo plugin reload mistral-vibe-custom`, then check
  `paseo plugin ls` (running, no error) and `paseo plugin logs mistral-vibe-custom`.
- Test with a real agent: `paseo run --provider mistral-vibe-custom/mistral-large-4-0-3 ...`
  then `paseo inspect <id> --json`, `paseo logs <id> --json`, `paseo usage ls --json --refresh`.
  A prompt driving `ask_user_question` parks the agent on a card: `paseo permit ls`, then
  `paseo permit allow <id> <req> --input '{"answers":{"<header>":"…"}}'` or `paseo permit deny`,
  and check the tool result carries the answer.
  Archive test agents afterwards (`paseo archive <id>`) and check `pgrep vibe-acp` is back to
  baseline (child leaks are the classic bug here).
- The desktop app caches the client bundle: restart the Paseo app to see client-side changes.
- Never restart the daemon from here while a session is running inside Paseo.
- Parallel sessions are the norm: any code path that assumes one active session is a bug.

## Invariants and fragilities

- **vibe-acp internals**: the plugin depends on the config option id `thinking` with the
  non-standard category `thinking` (the ACP spec reserves `thought_level`), the extension
  methods `_rewind/to` and `_account/read`, the `usage_update` payload and its `_meta`
  fields, and camelCase aliases. A vibe upgrade can break any of these silently; keep
  fallbacks and log lines (`paseo plugin logs`). The durable fix is upstream: vibe should
  use the `thought_level` category.
- **`ask_user_question` rides on ACP elicitation, not on permissions**: vibe only offers the
  tool when the client sends `clientCapabilities.elicitation.form` in `initialize`, as an
  OBJECT (`{}`; `true` is -32602). The shim sends `{}`, so the stock adapter never has it: we
  patch that key in `vibe-acp.ts`, then `provider.ts` keeps each `elicitation/create` away from
  the shim (it would answer "method not found" and fail the turn) and turns it into a
  `session.permission` of kind `question`, answering the child on its stdin. Payload is FLAT
  (`{sessionId, toolCallId, message, mode: "form", requestedSchema}`), one `q0`, `q1`… per
  question: `oneOf: [{const}]` = single choice, `items.anyOf` = multi select, `title` = header,
  `description` = question. Reply `{action: "accept", content: {q0: "label", q1: ["a","b"]}}`;
  vibe rejects empty strings/arrays, and `decline`/`cancel` become `cancelled: true` (the model
  keeps its turn). The card takes `input.questions[{question, header, options[{label,
  description}], multiSelect, allowOther}]` and keys answers by HEADER, so headers must be
  non-empty and unique (synthesize them) and every field answerable. Never advertise the
  capability without this bridge, and settle pending questions on interrupt/close: the tool
  call would otherwise wait forever. Permission ids carry the native session id because two
  children reuse JSON-RPC ids.
- **Why the custom connector exists**: `runAcpProvider` answers `request.failed` to
  `session.revert`, so `server/vibe-acp.ts` owns the vibe-acp process with a JSON-RPC side
  channel. If Paseo ships native ACP revert (getpaseo/paseo#5748), delete the
  connector/wrapper and keep only the transformers.
- **Spawn env must carry the session env**: `{ ...launch.env, ...config.env }`. `launch.env`
  is the daemon env; the per-agent identity (`PASEO_AGENT_ID`, `PASEO_AGENT_CWD`,
  `PASEO_WORKSPACE_ID`) only travels in `session.open` → `config.env` (daemon:
  `mapSessionConfig`). The shim calls `connector()` without arguments, synchronously while
  dispatching an input, so `pendingSessionEnv` in `server/provider.ts` maps one queued env
  per spawning input (`session.open`, `catalog`, `sessions`). Keep the FIFO aligned with that
  list, including the drop path for an input rejected by validation. Symptom when it breaks:
  `paseo run` launched from inside an agent loses `callerAgentId` (no parent link).
- **Process↔session mapping is by native session id, never positional**: each handle records
  the ids it serves (from `session/new` responses and `session/load` requests) and is matched
  at `session.opened`.
- **All per-session state is keyed by native vibe session id** (thinking level, pending user
  entry id) and pruned on `session.closed`; a module-level global misattributes events across
  parallel sessions.
- **Lifecycle**: shutdown/cancel hooks and `close()` must terminate every child; pending
  requests are rejected when a process exits; every side-channel `callExt` has a timeout
  (30 s) so a dead process cannot hang the plugin; stdout line buffer is capped.
- **revertToken attachment is timing-sensitive**: two paths — live (re-emit the
  `user_message` item with the token when the chunk arrives) and replay (attach on the
  item emitted from chunks). If vibe changes when `user_message_chunk` is sent, tokens may
  attach late or missing.
- **Usage cards do not attach to plugin-provider agents**: the ring popover's `AgentUsage`
  section needs `usageScopeKey`, which plugin sessions do not expose (daemon-side
  `session.usageSession()`). Session data (context %, tokens, cost) reaches the ring via
  the patched `session.usage` events; only the monthly allowance shows in the host usage
  modal. Fixing this needs daemon support.
- **Icon**: provider icons are monochrome SVG with `fill="currentColor"` (theme-tinted).
  The manifest `icon` for the registry listing must be a PNG, not SVG.
- **Security**: plugin code is trusted and unsandboxed on the daemon host. Never log
  credentials; the side channel only carries session/message ids.

## Cross-provider session history (mistral-vibe vs mistral-vibe-custom)

Both providers spawn the same `vibe-acp` binary, so they share one session store
(`session/list` returns the same native session ids for both). Consequences:

- The Custom provider lists AND opens conversations created with the native provider (and
  vice versa): `session.open` with `persistence.data.sessionId` maps to vibe-acp
  `session/load`, which replays the history.
- The apparent "split" is daemon-side, not plugin-side: listing entries are tagged with the
  listing provider and the handle encoding differs (native: raw uuid; plugin: `plugin:{...}`),
  so one conversation can appear once per provider in the import view, and the
  "already imported" filter is keyed `(provider, handle)`. The `plugin:` encoding lives in the
  daemon (`plugin-provider.js` `encodePersistence`, `import-sessions.js`
  `toProviderSessionHandleKey`); true cross-provider dedup is an upstream Paseo change.
- vibe enforces a per-session lease (`vibe/core/session/session_lease.py`): a session can
  only be open in one vibe-acp process at a time ("Session is already open"), so the same
  conversation cannot be open simultaneously under both providers — same limitation as
  within a single provider.

## Layout

- `index.server.ts` — registers provider + usage source.
- `server/provider.ts` — provider wrapper: extra capabilities, `session.revert` → `_rewind/to`,
  event patching (config, usage, revertToken), `pendingSessionEnv` FIFO.
- `server/vibe-acp.ts` — spawn + ndjson framing + native-id tracking + `callExt`.
- `server/transformers.ts` — thinking remap (discover/configure) + `session/update` parsing.
- `server/questions.ts` — `elicitation/create` ↔ Paseo question card mapping (pure, no state).
- `server/usage-source.ts` — monthly budget via `_account/read` probe (one in-flight probe,
  60 s positive / 30 s negative cache).
- `server/prices.ts` — model prices from `~/.vibe/config.toml` + cost estimate (mtime+TTL
  cached parse, `Number.isFinite` guards).
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
