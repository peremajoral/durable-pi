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

/** Tools that create, update or delete: shell, files, App State, job runs, subagents. A `writes:`
 *  flag on an agent's tools and the read-only filter both read this, on either host. */
export const WRITE_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  "update_state",
  "run_durable_job",
  "ping_on_call_engineer",
  "subagent",
  "start_session",
]);

/**
 * What routes.ts, streams.ts and the idempotency middleware actually ask of a store. Picked from
 * the Node store, so the signatures are the real ones, but listed by name, so a second store (the
 * Durable Object's) answers only what is asked of it instead of all 62 methods a Store happens to
 * have. Extending the router is a compile error until the name is added here. `opened` comes along
 * because streams.ts reads it to tell a live session from a dead one.
 */
type RouterMethods =
  | "deviceInfo"
  | "tree"
  | "browse"
  | "deviceDoc"
  | "create"
  | "sessionSummary"
  | "rename"
  | "archive"
  | "list"
  | "preview"
  | "resolveSession"
  | "resolveAgent"
  | "harness"
  | "subscribe"
  | "agents"
  | "createAgent"
  | "agentSummary"
  | "agentDetail"
  | "setAgentName"
  | "entries"
  | "activeEntries"
  | "transcript"
  | "inbox"
  | "send"
  | "settled"
  | "withdraw"
  | "abort"
  | "fork"
  | "configure"
  | "extensionsOf"
  | "setExtension"
  | "compact"
  | "reset"
  | "agentDoc"
  | "liveTasks"
  | "tasks"
  | "taskNode"
  | "labelTasks"
  | "abortTask"
  | "inspect"
  | "usage"
  | "compactionOf"
  | "setCompaction"
  | "demoState"
  | "startJob"
  | "approveJob"
  | "replay"
  | "remember";

export type DeviceStore = Pick<Store, RouterMethods> & Pick<Store, "opened">;
