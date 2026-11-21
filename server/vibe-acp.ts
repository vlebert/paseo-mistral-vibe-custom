import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";

export interface VibeAcpHandle {
  stream: AcpStream;
  /** Native ACP session ids served by this process (a process can host a child session too). */
  readonly nativeSessionIds: Set<string>;
  /** Send a raw JSON-RPC request to the vibe-acp process (standard or "_"-prefixed extension). */
  callExt(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** Answer a request the tap kept away from the shim (elicitation/create). */
  respond(id: string | number, result: unknown): void;
  close(): Promise<void>;
}

/**
 * Raw message tap: called for every parsed inbound JSON-RPC message before the shim sees it.
 * Return `false` to keep the message away from the shim entirely — the shim only knows
 * standard ACP requests and would answer `method not found` to anything else.
 */
export type MessageTap = (message: AcpStreamMessage) => boolean | void;

/**
 * Declare the ACP elicitation capability on the outbound `initialize`.
 *
 * vibe-acp reads `clientCapabilities.elicitation.form` at initialize time and, when the client
 * stays silent, drops `ask_user_question` from the model's tool list (see `_supports_user_input`
 * and NON_INTERACTIVE_DISABLED_TOOLS in vibe/acp/agent.py). Paseo's shim sends
 * `clientCapabilities: {}`, so the tool never reaches the model. We own the child, so we patch
 * the one field the shim does not send and answer the resulting `elicitation/create` requests
 * ourselves (provider.ts), because the shim would reply "method not found" to them.
 *
 * `form` must be an OBJECT: the Python SDK types it as `ElicitationFormCapabilities` and
 * rejects `true` with -32602.
 */
function withElicitationCapability(message: AcpStreamMessage): AcpStreamMessage {
  if (!("method" in message) || message.method !== "initialize") return message;
  const params = (message.params ?? {}) as Record<string, unknown>;
  const current = params.clientCapabilities;
  const clientCapabilities =
    typeof current === "object" && current !== null && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  const currentElicitation = clientCapabilities.elicitation;
  const elicitation =
    typeof currentElicitation === "object" && currentElicitation !== null && !Array.isArray(currentElicitation)
      ? currentElicitation
      : {};
  return {
    ...message,
    params: {
      ...params,
      // Merge instead of replace: the host may already advertise other elicitation modes.
      clientCapabilities: { ...clientCapabilities, elicitation: { ...elicitation, form: {} } },
    },
  } as AcpStreamMessage;
}

const MAX_BUFFER_CHARS = 16 * 1024 * 1024;
const DEFAULT_EXT_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Spawn `vibe-acp` and expose it as an ACP ndjson stream plus a side channel for
 * vendor extension methods. The Paseo ACP shim owns the stream; the side channel
 * lets us call vibe-acp extensions the shim does not forward (_rewind/to, _account/read).
 *
 * Lifecycle: cancelling the readable or closing the writable terminates the child and
 * rejects all pending side-channel requests, so no process outlives its connection.
 *
 * `sessionEnv` is the per-agent env the daemon sends with `session.open` (`config.env`):
 * it carries `PASEO_AGENT_ID`, `PASEO_AGENT_CWD` and `PASEO_WORKSPACE_ID`. The stock shim
 * spawns with `{ ...launch.env, ...config.env }`; owning the process means repeating that
 * merge. `launch.env` alone is the daemon env and holds no identity, so the agent would
 * lose its caller (`paseo run` from inside it drops `callerAgentId`).
 */
export function startVibeAcp(
  launch: ProviderLaunch | undefined,
  sessionEnv: Readonly<Record<string, string>> = {},
  onMessage?: MessageTap,
): VibeAcpHandle {
  const command = launch?.command ?? "vibe-acp";
  const args = launch?.args ?? [];
  const env = { ...(launch?.env ?? process.env), ...sessionEnv };
  const child = spawnProcess(command, args, { env, stdio: "pipe" });
  child.stderr.on("data", () => undefined);
  child.stdin.on("error", () => undefined); // EPIPE after child death

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const pending = new Map<string, PendingRequest>();
  /** Outbound request id -> method, so inbound responses can be attributed (session/new). */
  const outboundMethods = new Map<string, string>();
  const nativeSessionIds = new Set<string>();
  let nextId = 1;
  let buffer = "";
  let closed = false;

  const settleAll = (error: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const shutdown = (error: Error) => {
    if (closed) return;
    closed = true;
    settleAll(error);
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    void terminateProcess(child).catch(() => undefined);
  };

  child.on("error", () => shutdown(new Error("vibe-acp process error")));
  child.on("exit", () => shutdown(new Error("vibe-acp process exited")));

  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      child.stdout.on("data", (chunk: Buffer) => {
        if (closed) return;
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > MAX_BUFFER_CHARS) {
          controller.error(new Error("vibe-acp ndjson line too large"));
          shutdown(new Error("vibe-acp ndjson line too large"));
          return;
        }
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line) continue;
          let message: AcpStreamMessage;
          try {
            message = JSON.parse(line) as AcpStreamMessage;
          } catch {
            continue;
          }
          if (!("method" in message) && "id" in message && message.id !== null) {
            const id = String(message.id);
            const method = outboundMethods.get(id);
            outboundMethods.delete(id);
            if (method === "session/new" && !("error" in message)) {
              const sessionId = (message as { result?: { sessionId?: unknown } }).result?.sessionId;
              if (typeof sessionId === "string") nativeSessionIds.add(sessionId);
            }
            const entry = pending.get(id);
            if (entry) {
              pending.delete(id);
              clearTimeout(entry.timer);
              if ("error" in message) entry.reject(new Error(message.error.message));
              else entry.resolve((message as { result: unknown }).result);
            }
          }
          if (onMessage?.(message) === false) continue;
          try {
            controller.enqueue(message);
          } catch {
            return; // controller already closed/cancelled
          }
        }
      });
      child.stdout.on("end", () => {
        buffer += decoder.decode();
        if (!closed) {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      });
      child.stdout.on("error", (error) => {
        if (!closed) controller.error(error);
      });
    },
    cancel() {
      shutdown(new Error("vibe-acp stream cancelled"));
    },
  });

  const writable = new WritableStream<AcpStreamMessage>({
    write(message) {
      if (closed) return;
      const outgoing = withElicitationCapability(message);
      if ("method" in outgoing && "id" in outgoing && outgoing.id !== null) {
        outboundMethods.set(String(outgoing.id), outgoing.method);
        if (outgoing.method === "session/load") {
          const sessionId = (outgoing.params as { sessionId?: unknown } | undefined)?.sessionId;
          if (typeof sessionId === "string") nativeSessionIds.add(sessionId);
        }
      }
      child.stdin.write(encoder.encode(`${JSON.stringify(outgoing)}\n`));
    },
    close() {
      shutdown(new Error("vibe-acp stream closed"));
    },
    abort() {
      shutdown(new Error("vibe-acp stream aborted"));
    },
  });

  return {
    stream: { readable, writable },
    nativeSessionIds,
    callExt(method, params, timeoutMs = DEFAULT_EXT_TIMEOUT_MS) {
      const id = `vibe-ext-${nextId++}`;
      // Callers pass the exact wire method: standard ACP methods as-is ("initialize",
      // "session/new"), vendor extensions with the "_" prefix ("_rewind/to").
      return new Promise<unknown>((resolve, reject) => {
        if (closed) {
          reject(new Error("vibe-acp process is closed"));
          return;
        }
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`vibe-acp request ${method} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`));
      });
    },
    respond(id, result) {
      if (closed) return;
      child.stdin.write(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`));
    },
    async close() {
      shutdown(new Error("vibe-acp handle closed"));
    },
  };
}
