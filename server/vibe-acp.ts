import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";

export interface VibeAcpHandle {
  stream: AcpStream;
  /** Native ACP session ids served by this process (a process can host a child session too). */
  readonly nativeSessionIds: Set<string>;
  /** Send a raw JSON-RPC request to the vibe-acp process (standard or "_"-prefixed extension). */
  callExt(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

/** Raw message tap: called for every parsed inbound JSON-RPC message before the shim sees it. */
export type MessageTap = (message: AcpStreamMessage) => void;

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
 */
export function startVibeAcp(launch: ProviderLaunch | undefined, onMessage?: MessageTap): VibeAcpHandle {
  const command = launch?.command ?? "vibe-acp";
  const args = launch?.args ?? [];
  const env = launch?.env ?? process.env;
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
          onMessage?.(message);
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
      if ("method" in message && "id" in message && message.id !== null) {
        outboundMethods.set(String(message.id), message.method);
        if (message.method === "session/load") {
          const sessionId = (message.params as { sessionId?: unknown } | undefined)?.sessionId;
          if (typeof sessionId === "string") nativeSessionIds.add(sessionId);
        }
      }
      child.stdin.write(encoder.encode(`${JSON.stringify(message)}\n`));
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
    async close() {
      shutdown(new Error("vibe-acp handle closed"));
    },
  };
}
