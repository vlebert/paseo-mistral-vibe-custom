import { runAcpProvider, type AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  ProviderConnectRequest,
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderLaunch,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { startVibeAcp, type VibeAcpHandle } from "./vibe-acp.js";
import {
  answersFromPermission,
  isQuestionPermission,
  isToolQuestionInput,
  questionFromElicitation,
  type ElicitationResult,
  type PendingQuestion,
} from "./questions.js";
import {
  PLUGIN_ID,
  currentThinkingOptions,
  processSessionUpdate,
  transformerState,
  vibeTransformer,
} from "./transformers.js";
import type { UsageItemData } from "../shared/usage.js";

/**
 * Capabilities the stock ACP shim does not offer but vibe-acp supports:
 * - session.revert.conversation / session.revert.both: vibe-acp exposes the "_rewind/to"
 *   extension, which we call from the side channel;
 * - timeline.plugin: used to carry the usage capture internally.
 */
const EXTRA_CAPABILITIES = ["timeline.plugin", "session.revert.conversation", "session.revert.both"] as const;

interface LatestVibeUsage {
  data: UsageItemData;
}

/** A question card waiting for the user, with the callback that answers the child. */
interface PendingQuestionEntry {
  /** Boundary (Paseo) session id, to settle the card when that session stops. */
  sessionId: string;
  pending: PendingQuestion;
  respond: (result: ElicitationResult) => void;
}

/** All mutable state is per connection, so parallel sessions and reconnects stay isolated. */
interface ConnCtx {
  handles: VibeAcpHandle[];
  sessionHandle: Map<string, VibeAcpHandle>;
  sessionNativeId: Map<string, string>;
  boundaryByNative: Map<string, string>;
  lastUserMessage: Map<string, ProviderEvent & { type: "timeline.item" }>;
  latestUsage: Map<string, LatestVibeUsage>;
  /** Permission id -> question waiting for the user (only ids minted by this plugin). */
  pendingQuestions: Map<string, PendingQuestionEntry>;
  /** Native session id -> `rawInput` of the last ask_user_question tool call, until used. */
  pendingToolQuestions: Map<string, JsonValue>;
  listeners: Set<(event: ProviderEvent) => void>;
  emit: (event: ProviderEvent) => void;
  closed: boolean;
}

export function createVibeCustomProvider(): ProviderRegistration {
  // One context per connect(); the connector picks the most recent one (connects are
  // sequential per provider registration).
  const contexts: ConnCtx[] = [];
  let currentLaunch: ProviderLaunch | undefined;
  /**
   * Env queued for a spawn, oldest first. The shim calls `connector()` synchronously while
   * dispatching an input, so the order of `send()` below is the order of the spawns: every
   * input that starts a process queues its session env here, the connector consumes the
   * oldest one (why it matters: see `startVibeAcp`). An entry is dropped when `inner.send`
   * rejects before dispatching, so a failed open cannot shift the next one.
   */
  const pendingSessionEnv: Array<{ env: Readonly<Record<string, string>>; dropped: boolean }> = [];

  function queueSessionEnv(env: Readonly<Record<string, string>>) {
    const entry = { env, dropped: false };
    pendingSessionEnv.push(entry);
    return entry;
  }

  function takeSessionEnv(): Readonly<Record<string, string>> {
    for (let entry = pendingSessionEnv.shift(); entry; entry = pendingSessionEnv.shift()) {
      if (!entry.dropped) return entry.env;
    }
    return {};
  }

  const base = runAcpProvider({
    id: PLUGIN_ID,
    label: "Mistral Vibe Custom",
    description:
      "Mistral Vibe via vibe-acp, with thinking-level selector, context/usage ring data, monthly budget in the usage modal and conversation rewind",
    icon: "icon.svg",
    connector: () => {
      const ctx = contexts[contexts.length - 1];
      let child: VibeAcpHandle | undefined;

      /**
       * vibe answers the model's `ask_user_question` tool with a client-bound
       * `elicitation/create` request, which the ACP shim does not know (it would answer
       * "method not found" and the turn would fail). Surface it as a `session.permission` of
       * kind "question" - the shape Paseo's shared question card renders - and keep the
       * request id so the user's answer can go back on the child's stdin.
       */
      const answerQuestion = (message: AcpStreamMessage) => {
        if (!("method" in message)) return;
        const rpcId = "id" in message ? (message.id ?? null) : null;
        const params = message.params as { sessionId?: unknown } | undefined;
        const native = typeof params?.sessionId === "string" ? params.sessionId : undefined;
        const boundary = native && ctx ? ctx.boundaryByNative.get(native) : undefined;
        const captured = native && ctx ? ctx.pendingToolQuestions.get(native) : undefined;
        const built =
          native && rpcId !== null
            ? questionFromElicitation(rpcId, message.params, native, captured)
            : null;
        if (!ctx || !native || !boundary || !built) {
          // Nothing to render: hand the turn back instead of leaving the model waiting.
          console.error(
            `[mistral-vibe-custom] ask_user_question could not be surfaced (session=${native ?? "?"}, rpc=${String(rpcId)}); declining`,
          );
          if (rpcId !== null) child?.respond(rpcId, { action: "decline" });
          return;
        }
        ctx.pendingToolQuestions.delete(native);
        const { permission, pending } = built;
        ctx.pendingQuestions.set(permission.id, {
          sessionId: boundary,
          pending,
          respond: (result) => child?.respond(pending.rpcId, result),
        });
        ctx.emit({ type: "session.permission", sessionId: boundary, request: permission });
      };

      const handle = startVibeAcp(currentLaunch, takeSessionEnv(), (message) => {
        if (!ctx || ctx.closed) return;
        // Owned by us: only ever forwarded to the user, never to the shim.
        if ("method" in message && message.method === "elicitation/create") {
          answerQuestion(message);
          return false;
        }
        if (!("method" in message) || "id" in message || message.method !== "session/update") return;
        const params = (message.params ?? {}) as { sessionId?: unknown; update?: Record<string, unknown> };
        const native = typeof params.sessionId === "string" ? params.sessionId : undefined;
        const boundary = native ? ctx.boundaryByNative.get(native) : undefined;
        if (!params.update) return;
        // The tool call carries what the elicitation schema drops (option descriptions,
        // hideOther); keep it until the matching elicitation arrives.
        const toolInput = params.update.rawInput ?? params.update.raw_input;
        if (
          native &&
          (params.update.sessionUpdate ?? params.update.session_update) === "tool_call" &&
          isToolQuestionInput(toolInput)
        ) {
          ctx.pendingToolQuestions.set(native, toolInput);
        }
        for (const update of processSessionUpdate(params.update, native, boundary ?? null)) {
          if (update.type === "timeline" && boundary && update.item.type === "plugin" && update.item.kind === "vibe-usage") {
            // Captured for the context ring and the usage source; not emitted as an inline
            // timeline item (that info belongs in the ring popover, not between messages).
            ctx.latestUsage.set(boundary, { data: update.item.data as UsageItemData });
          }
        }
        // Live user messages are emitted by the shim at prompt time, before the chunk
        // carrying the native entry id arrives. Re-emit the item with the revertToken.
        const chunk = params.update;
        if (boundary && native && (chunk.sessionUpdate ?? chunk.session_update) === "user_message_chunk") {
          const nativeId = transformerState.pendingUserEntry.get(native);
          const last = ctx.lastUserMessage.get(boundary);
          if (nativeId && last && last.item.type === "user_message" && last.item.revertToken === undefined) {
            const item = { ...last.item, revertToken: nativeId };
            ctx.lastUserMessage.set(boundary, { ...last, item });
            ctx.emit({ type: "timeline.item", sessionId: boundary, item });
          }
        }
      });
      child = handle;
      if (ctx) ctx.handles.push(handle);
      return handle.stream;
    },
    transformers: [vibeTransformer],
  });

  return {
    ...base,
    async connect(request: ProviderConnectRequest): Promise<ProviderConnection> {
      currentLaunch = request.launch;
      const inner = await base.connect(request);
      const ctx: ConnCtx = {
        handles: [],
        sessionHandle: new Map(),
        sessionNativeId: new Map(),
        boundaryByNative: new Map(),
        lastUserMessage: new Map(),
        latestUsage: new Map(),
        pendingQuestions: new Map(),
        pendingToolQuestions: new Map(),
        listeners: new Set(),
        emit: () => {},
        closed: false,
      };
      ctx.emit = (event) => {
        for (const listener of ctx.listeners) listener(event);
      };
      contexts.push(ctx);

      /** Settle every question card of a session: its child is done waiting for an answer. */
      function cancelQuestions(sessionId: string): void {
        for (const [permissionId, entry] of [...ctx.pendingQuestions]) {
          if (entry.sessionId !== sessionId) continue;
          ctx.pendingQuestions.delete(permissionId);
          entry.respond({ action: "cancel" });
          ctx.emit({ type: "session.permission_resolved", sessionId, permissionId });
        }
      }

      // Only advertise extra capabilities the host actually negotiated.
      const extra = EXTRA_CAPABILITIES.filter((cap) => request.capabilities.includes(cap));

      async function doRevert(input: Extract<ProviderInput, { type: "session.revert" }>): Promise<void> {
        if (input.scope === "files") throw new Error("Files-only rewind is not supported");
        const handle = ctx.sessionHandle.get(input.sessionId);
        const nativeId = ctx.sessionNativeId.get(input.sessionId);
        if (!handle || !nativeId) throw new Error(`No vibe-acp process for session ${input.sessionId}`);
        if (typeof input.token !== "string" || input.token.length === 0) {
          throw new Error("Missing revert token (native message id)");
        }
        const result = (await handle.callExt("_rewind/to", {
          sessionId: nativeId,
          messageId: input.token,
          restoreFiles: input.scope === "both",
        })) as { restoreErrors?: unknown } | undefined;
        // vibe restores what it can and reports the rest; surface it instead of dropping it.
        const restoreErrors = Array.isArray(result?.restoreErrors) ? result.restoreErrors : [];
        if (restoreErrors.length > 0) {
          console.error(
            `[mistral-vibe-custom] rewind restored files with ${restoreErrors.length} error(s):`,
            JSON.stringify(restoreErrors.slice(0, 3)),
          );
        }
        // Paseo closes the session and reopens the latest persistence with history replay.
      }

      inner.onEvent((raw) => {
        if (ctx.closed) return;
        let event = raw;
        if (event.type === "session.opened") {
          const nativeId = typeof (event.persistence?.data as { sessionId?: unknown } | undefined)?.sessionId === "string"
            ? ((event.persistence!.data as { sessionId: string }).sessionId)
            : null;
          if (nativeId) {
            ctx.sessionNativeId.set(event.sessionId, nativeId);
            ctx.boundaryByNative.set(nativeId, event.sessionId);
            // Exact mapping: the handle whose process serves this native session id.
            // Parallel sessions each get their own process; a child session shares its
            // parent's process, hence the Set on the handle.
            const handle = ctx.handles.find((h) => h.nativeSessionIds.has(nativeId));
            if (handle) {
              ctx.sessionHandle.set(event.sessionId, handle);
            } else {
              console.error(`[mistral-vibe-custom] no vibe-acp process found for native session ${nativeId}`);
            }
          }
          event = { ...event, capabilities: [...event.capabilities, ...extra] };
        }
        if (event.type === "session.closed") {
          cancelQuestions(event.sessionId);
          const native = ctx.sessionNativeId.get(event.sessionId);
          if (native) {
            ctx.boundaryByNative.delete(native);
            ctx.pendingToolQuestions.delete(native);
          }
          ctx.sessionNativeId.delete(event.sessionId);
          ctx.sessionHandle.delete(event.sessionId);
          ctx.lastUserMessage.delete(event.sessionId);
          ctx.latestUsage.delete(event.sessionId);
        }
        if (event.type === "timeline.item" && event.item.type === "user_message") {
          ctx.lastUserMessage.set(event.sessionId, event);
          // Replayed history: the shim emits user_message items from chunks, so the
          // native entry id captured by the tap can be attached directly.
          const native = ctx.sessionNativeId.get(event.sessionId);
          const entryId = native ? transformerState.pendingUserEntry.get(native) : undefined;
          if (entryId && event.item.revertToken === undefined) {
            event = { ...event, item: { ...event.item, revertToken: entryId } };
            transformerState.pendingUserEntry.delete(native!);
          }
        }
        if (event.type === "session.usage") {
          // ACP PromptResponse.usage carries no context fields; vibe's usage_update does.
          // Merge them so the composer context ring and its click popover get real data.
          const latest = ctx.latestUsage.get(event.sessionId);
          if (latest) {
            event = {
              ...event,
              usage: {
                ...event.usage,
                contextWindowUsedTokens: latest.data.used ?? event.usage.contextWindowUsedTokens,
                contextWindowMaxTokens: latest.data.size ?? event.usage.contextWindowMaxTokens,
                // vibe's own figure only: it prices cached and uncached input separately, and
                // omits `cost` when it has no price for the model. Never guess here.
                totalCostUsd: latest.data.costUsd ?? event.usage.totalCostUsd,
              },
            };
          }
        }
        if (event.type === "session.config") {
          // The stock shim files every non-standard config option as a generic setting,
          // which renders a second thinking selector next to the dedicated one. Drop the
          // generic "thinking" control and surface it as the real thinkingOption instead.
          const native = ctx.sessionNativeId.get(event.sessionId);
          const { thinkingOptions, current } = currentThinkingOptions(native ?? undefined);
          const sessionThinking = native ? transformerState.thinkingBySession.get(native) : undefined;
          event = {
            ...event,
            config: {
              ...event.config,
              thinkingOption: sessionThinking?.current ?? current,
              thinkingOptions,
              settings: (event.config.settings ?? []).filter((setting) => setting.id !== "thinking"),
              controls: (event.config.controls ?? []).filter((control) => control.key !== "thinking"),
            },
          };
        }
        ctx.emit(event);
      });

      return {
        version: inner.version,
        capabilities: [...inner.capabilities, ...extra],
        async send(input: ProviderInput): Promise<void> {
          // Question cards are ours: the shim has no ACP permission behind them, and would
          // throw "Unknown ACP permission" for the answer.
          if (input.type === "session.permission" && isQuestionPermission(input.permissionId)) {
            const entry = ctx.pendingQuestions.get(input.permissionId);
            ctx.pendingQuestions.delete(input.permissionId);
            if (entry) entry.respond(answersFromPermission(entry.pending, input.response));
            ctx.emit({
              type: "session.permission_resolved",
              sessionId: input.sessionId,
              permissionId: input.permissionId,
            });
            return;
          }
          // An interrupt or a close cancels the callback inside vibe; settle the cards first
          // so no request lingers as "waiting for input".
          if (input.type === "session.interrupt" || input.type === "session.close") {
            cancelQuestions(input.sessionId);
          }
          if (input.type === "session.revert") {
            try {
              await doRevert(input);
              ctx.emit({ type: "request.completed", requestId: input.requestId });
            } catch (error) {
              ctx.emit({
                type: "request.failed",
                requestId: input.requestId,
                error: { message: error instanceof Error ? error.message : String(error) },
              });
            }
            return;
          }
          // Inputs the shim answers by starting a process through `connector`; each one
          // queues the env that process must inherit. `catalog` and `sessions` probes run
          // in the daemon env, but they still consume a slot, hence the empty object.
          const queued =
            input.type === "session.open"
              ? queueSessionEnv(input.config.env)
              : input.type === "catalog" || input.type === "sessions"
                ? queueSessionEnv({})
                : undefined;
          try {
            await inner.send(input);
          } catch (error) {
            if (queued) queued.dropped = true;
            throw error;
          }
        },
        onEvent(listener) {
          ctx.listeners.add(listener);
          return () => {
            ctx.listeners.delete(listener);
          };
        },
        async close() {
          ctx.closed = true;
          ctx.pendingQuestions.clear();
          ctx.pendingToolQuestions.clear();
          const idx = contexts.indexOf(ctx);
          if (idx >= 0) contexts.splice(idx, 1);
          // Terminating every handle this connection spawned (stream cancel would also do
          // it via the shim, but be explicit so no vibe-acp process outlives the connection).
          await Promise.all(ctx.handles.map((h) => h.close().catch(() => undefined)));
          await inner.close();
        },
      };
    },
  };
}
