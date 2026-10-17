// The `/v1` router's side of the store: the constants and the type both hosts agree on, in a file
// with no `node:` import anywhere. This is the seam that lets routes.ts and streams.ts be bundled
// into a Cloudflare Worker, where store.ts - node:sqlite, a real filesystem, a shell - cannot exist.
//
// Values live here, not in store.ts, because routes.ts *runs* on these constants (it validates a
// document kind before reading it) and a runtime import of store.ts drags node:sqlite into the
// Worker bundle.
import { JOB_RUNS_DOC } from "../../dpi-sdk/src/jobs.js";
import type { Store } from "./store.js";

/** A session as the catalog holds it: the row every session route resolves first. */
export type SessionRow = {
  id: string;
  name: string;
  cwd: string;
  dbPath: string;
  createdAt: number;
  model: string;
  provider: string;
};

/** The workspace document a session's agents may read and stream. */
export const WORKSPACE_DOC = "demo.workspace";

/** Agent documents a client may read or stream, by kind. Keys of store.ts's AGENT_DOCS. */
export const AGENT_DOC_KINDS = [JOB_RUNS_DOC, WORKSPACE_DOC];

/** Device documents a client may read or stream, by kind. */
export const DEVICE_DOC_KINDS = ["app.shared-state"];

/**
 * What routes.ts and streams.ts need from a store, and nothing else: the method surface of the Node
 * store, plus the set of sessions it has open. Derived instead of hand-written, so a second store
 * (the Durable Object's) cannot drift from the first without a compile error. `import type` only:
 * nothing of store.ts reaches a Worker bundle through this file.
 */
export type DeviceStore = {
  [K in keyof Store as Store[K] extends (...args: any[]) => any ? K : never]: Store[K];
} & Pick<Store, "opened">;
