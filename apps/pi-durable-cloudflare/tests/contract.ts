// Contract conformance sweep: call every DpiClient method the hub, dpi-tui and curl use,
// against one device, and report what it actually answers.
//
//   DPI_URL=http://127.0.0.1:4780 DPI_TOKEN=<token> npx tsx apps/pi-durable-cloudflare/tests/contract.ts
//
// Works against any device kind: `local`, a url device, the Cloudflare Durable Object.
// A route counts as failing unless it answers; 404 is a missing route, anything else is
// the device answering wrongly. Ids are real ones taken from the device, never 1.
import { DpiClient } from "../../dpi-sdk/src/client.js";

const url = process.env.DPI_URL ?? "http://127.0.0.1:8899";
const token = process.env.DPI_TOKEN ?? "";
const client = new DpiClient(url, token);

type Row = { name: string; ok: boolean; detail: string };
const rows: Row[] = [];

const brief = (value: unknown): string => {
  if (value === undefined) return "ok";
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value !== "object" || value === null) return String(value);
  const o = value as Record<string, unknown>;
  if (Array.isArray(o.items)) return `${o.items.length} items`;
  if (typeof o.status === "string") return `status=${o.status}`;
  if (typeof o.text === "string") return `${o.text.length} chars`;
  if (typeof o.format === "string") return `format=${o.format}`;
  return `{${Object.keys(o).slice(0, 6).join(",")}}`;
};

async function probe(name: string, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    const value = await fn();
    rows.push({ name, ok: true, detail: brief(value) });
    return value;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    rows.push({ name, ok: false, detail: `${err.code ?? "error"}: ${err.message ?? String(e)}` });
    return undefined;
  }
}

/** Read one frame from a stream and stop: a stream that never opens is a failure. */
async function firstFrame(name: string, stream: (signal: AbortSignal) => AsyncIterable<unknown>) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    for await (const frame of stream(ctl.signal)) {
      rows.push({ name, ok: true, detail: `frame type=${(frame as { type?: string }).type}` });
      return;
    }
    rows.push({ name, ok: false, detail: "stream closed with no frame" });
  } catch (e) {
    rows.push({ name, ok: false, detail: `error: ${(e as Error).message}` });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- device scope
const info = (await probe("GET /v1/device", () => client.device({ timeoutMs: 10000 }))) as
  | { models?: { id: string; provider: string }[]; defaultModel?: string }
  | undefined;
// The hub offers this model in the new-session form; the device rejects a session without it.
const model = info?.models?.find((m) => m.id === info.defaultModel) ?? info?.models?.[0];
await probe("GET /v1/tree", () => client.tree());
const dirs = (await probe("GET /v1/fs/dirs", () => client.dirs(""))) as
  | { dirs?: { path: string }[] }
  | undefined;
// Also exercise browsing one level down, which is what the session form does.
await probe("GET /v1/fs/dirs?path=<start dir>", () => client.dirs(dirs?.dirs?.[0]?.path ?? ""));
await probe("GET /v1/docs/:kind", () => client.deviceDoc("app.shared-state"));
await firstFrame("GET /v1/events", (signal) => client.deviceEvents(signal));
const existing = (await probe("GET /v1/sessions", () => client.sessions())) as
  | { id: string }[]
  | undefined;

// ---------------------------------------------------------------- a session to work in
const cwd = dirs?.dirs?.[0]?.path;
const created = (await probe("POST /v1/sessions", () =>
  client.createSession({
    name: `sweep ${Date.now()}`,
    ...(cwd ? { cwd } : {}),
    ...(model ? { model: { provider: model.provider, modelId: model.id } } : {}),
  }),
)) as { id: string } | undefined;
const s = created?.id ?? existing?.[0]?.id;
if (s === undefined) {
  console.log("the device answered no session, so nothing below can be exercised\n");
  for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(46)}  ${r.detail}`);
  const bad = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - bad}/${rows.length} ok, ${bad} failing`);
  process.exitCode = 1;
  process.exit();
}
const session = client.session(s);
const a = "main";
const agent = client.agent(s, a);

// ---------------------------------------------------------------- session scope
await probe("GET /v1/sessions/:s", () => session.get());
await probe("GET /v1/sessions/:s/agents", () => session.agents());
await probe("POST /v1/sessions/:s/agents", () => session.createAgent({ name: `sweep ${Date.now()}` }));
await probe("GET /v1/sessions/:s/compaction", () => session.compaction());
await probe("PATCH /v1/sessions/:s/compaction", () => session.setCompaction({ enabled: true }));
const tasks = (await probe("GET /v1/sessions/:s/tasks", () => session.tasks("terminal", 5))) as
  | { id?: number; taskId?: number }[]
  | undefined;
await probe("GET /v1/sessions/:s/tasks?status=live", () => session.tasks("live", 5));
await probe("GET /v1/sessions/:s/inspect", () => session.inspect());
await firstFrame("GET /v1/sessions/:s/events", (signal) => session.events(signal));
await probe("PATCH /v1/sessions/:s", () => session.rename(`sweep ${Date.now()}`));

// ---------------------------------------------------------------- agent scope
await probe("GET .../agents/:a", () => agent.get());
await probe("GET .../agents/:a/config", () => agent.config());
await probe("GET .../agents/:a/extensions", () => agent.extensions());
await probe("GET .../agents/:a/entries", () => agent.entries({ limit: 5 }));
await probe("GET .../agents/:a/entries?scope=active", () => agent.entries({ scope: "active", limit: 5 }));
await probe("GET .../agents/:a/transcript", () => agent.transcript("json"));
await probe("GET .../agents/:a/transcript?format=markdown", () => agent.transcript("markdown"));
await probe("GET .../agents/:a/docs/:kind", () => agent.doc("demo.job-runs"));
await firstFrame("GET .../agents/:a/events", (signal) => agent.events(signal));
await probe("PATCH .../agents/:a", () => agent.rename("Main"));
await probe("PATCH .../agents/:a/config", () => agent.configure({ thinkingLevel: "off" }));
await probe("PATCH .../agents/:a/extensions", () =>
  agent.setExtension({ name: "system-prompts", enabled: false }),
);

// ---------------------------------------------------------------- work: real ids from here
const queued = (await probe("POST .../agents/:a/messages (queued)", () =>
  agent.send("sweep", "followUp", `sweep-${Date.now()}`, 0),
)) as { submissionId?: number } | undefined;
const submissionId = queued?.submissionId;
if (submissionId !== undefined) {
  await probe("GET .../sessions/:s/submissions/:id", () => session.submission(submissionId, 0));
  await probe("DELETE .../agents/:a/inbox/:submissionId", () => agent.withdraw(submissionId));
} else {
  rows.push({ name: "GET .../sessions/:s/submissions/:id", ok: false, detail: "no submission to read" });
  rows.push({ name: "DELETE .../agents/:a/inbox/:submissionId", ok: false, detail: "no submission to withdraw" });
}
await probe("POST .../agents/:a/abort", () => agent.abort());
// Compaction is a durable task, so its id is a real one to abort; a fresh session has no tasks yet.
const compacted = (await probe("POST .../agents/:a/compact", () => agent.compact())) as
  | { taskId?: number }
  | undefined;
const abortable = compacted?.taskId ?? tasks?.[0]?.id ?? tasks?.[0]?.taskId;
await probe("POST /v1/sessions/:s/tasks/:id/abort", async () => {
  if (abortable === undefined) throw Object.assign(new Error("no task to abort"), { code: "no_task" });
  return session.abortTask(abortable);
});
await probe("POST .../agents/:a/reset", () => agent.reset());
// The fork fixture is its own agent: an entry is only visible in the conversation that has it.
const solo = (await probe("POST /v1/sessions/:s/agents (fork fixture)", () =>
  session.createAgent({ name: `fixture ${Date.now()}` }),
)) as { id?: number } | undefined;
const soloAgent = solo?.id !== undefined ? client.agent(s, solo.id) : undefined;
let entryId: number | undefined;
if (soloAgent) {
  const settled = (await probe("POST .../agents/:id/messages (waited)", () =>
    soloAgent.send("say hi", "followUp", `fixture-${Date.now()}`, 60000),
  )) as { answer?: { entryId: number } } | undefined;
  entryId = settled?.answer?.entryId;
} else {
  // Always a row: a probe that disappears changes the denominator between backends and can
  // hide a failure as an absence.
  rows.push({
    name: "POST .../agents/:id/messages (waited)",
    ok: false,
    detail: "skipped: the device answered no fork fixture agent",
  });
}
await probe("POST .../agents/:a/fork", async () => {
  if (!soloAgent || entryId === undefined)
    throw Object.assign(new Error("no entry to fork at"), { code: "no_entry" });
  return soloAgent.fork({ entryId, name: `fork ${Date.now()}` });
});
// App State operations are create | update | increment. /goal exists from initialize(), so an
// update is idempotent and the sweep can run against the same device repeatedly.
await probe("POST .../agents/:a/demo/state", () =>
  agent.demo("state", { operation: "update", path: "/goal", value: "sweep" }),
);
await probe("POST .../agents/:a/demo/jobs", () =>
  agent.demo("jobs", { job: "workspace-snapshot", input: { path: cwd ?? "/tmp" } }),
);

// ---------------------------------------------------------------- report
// Not in the sweep, and why: POST .../demo/jobs/:id/approval only answers for a release-check
// run parked at its approve phase, which needs a live subagent and bash. The repo exercises it
// in apps/dpi-playground/tests/agent-features.mjs; here it would be a false red on any device.
const notExercised = ["POST .../agents/:a/demo/jobs/:id/approval"];
const width = Math.max(...rows.map((r) => r.name.length));
const failed = rows.filter((r) => !r.ok);
for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
for (const name of notExercised) console.log(`--    ${name.padEnd(width)}  not exercised here`);
console.log(
  `\n${rows.length - failed.length}/${rows.length} ok, ${failed.length} failing (session ${s})`,
);
process.exitCode = failed.length > 0 ? 1 : 0;
