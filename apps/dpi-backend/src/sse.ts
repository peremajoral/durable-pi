// The web-standard side of streams.ts: an SSE channel built on a ReadableStream, so the same three
// stream functions serve any host that can return a Response. `writableLength` is the queued-but-
// not-yet-read byte count, which is the same thing express's writableLength measures.
import type { SseHeaders, SseResponse } from "./streams.js";

const encoder = new TextEncoder();
const MAX_BUFFER = 2_000_000;

export interface SseChannel {
  /** Feed this to deviceStream / sessionStream / agentStream. */
  res: SseResponse;
  /** The Response to return. Read it after the stream function has run: openSse sets status here. */
  response(): Response;
}

export function openChannel(signal: AbortSignal): SseChannel {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cleanups: Array<() => void> = [];
  let closed = false;
  let code = 200;
  let headers: Record<string, string> = {};

  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      cancel() {
        close();
      },
    },
    { highWaterMark: MAX_BUFFER, size: (chunk: Uint8Array) => chunk.byteLength },
  );

  const queued = () => {
    const desired = controller.desiredSize;
    return desired === null ? 0 : Math.max(0, MAX_BUFFER - desired);
  };

  function close() {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {}
    }
    try {
      controller.close();
    } catch {}
  }

  signal.addEventListener("abort", close, { once: true });

  const setHeaders = (next: Record<string, string>) => {
    headers = { ...headers, ...next };
    return undefined;
  };
  const res: SseResponse = {
    status(next: number): SseHeaders {
      code = next;
      return { set: setHeaders };
    },
    flushHeaders() {
      // Nothing to flush: the Response is built once the stream function has set its headers.
    },
    socket: null,
    write(chunk: string) {
      if (closed) return;
      if (queued() > MAX_BUFFER) {
        // A viewer that far behind reconnects to a fresh snapshot instead of buffering forever.
        close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
    },
    end: close,
    on(event: "close", listener: () => void) {
      if (event !== "close") return undefined;
      if (closed) listener();
      else cleanups.push(listener);
      return undefined;
    },
    get writableLength() {
      return queued();
    },
  };

  return {
    res,
    response: () => new Response(stream, { status: code, headers }),
  };
}
