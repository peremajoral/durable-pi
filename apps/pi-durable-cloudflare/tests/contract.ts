// Contract conformance sweep: call every DpiClient method the hub, dpi-tui and curl use,
// and report what the device actually answers. Red = the device is not in the network.
//
//   just cloudflare dev          # in another shell
//   npx tsx apps/pi-durable-cloudflare/tests/contract.ts
//
// Env: DPI_CF_URL (default http://127.0.0.1:8899), DPI_CF_TOKEN.
import { DpiClient } from "../../dpi-sdk/src/client.js";

const url = process.env.DPI_CF_URL ?? "http://127.0.0.1:8899";
const token = process.env.DPI_CF_TOKEN ?? "";
const client = new DpiClient(url, token);

type Row = { name: string; ok: boolean; detail: string };
const rows: Row[] = [];

const brief = (value: unknown): string => {
  if (value === undefined) return "ok";
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value !== "object" || value === null) return String(value);
  const keys = Object.keys(value as object);
  const o = value as Record<string, unknown>;
  if (typeof o.items !== "undefined") return `${(o.items as unknown[]).length} items`;
  if (typeof o.status === "string") return `status=${o.status}`;
  if (typeof o.format === "string") return `format=${o.format}`;
  if (typeof o.archived === "string") return `archived=${o.archived}`;
  if (typeof o.text === "string") return `${o.text.length} chars`;
  return keys.slice(0, 5).join(",") || "{}";
};

async function probe(name: string, fn: () => Promise<unknown>) {
  try {
    rows.push({ name, ok: true, detail: brief(await fn()) });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    rows.push({ name, ok: false, detail: `${err.code ?? "error"}: ${err.message ?? String(e)}` });
  }
}

/** Read one frame from a stream and stop: a stream that never opens is a failure. */
async function firstFrame(name: string, stream: (signal: AbortSignal) => AsyncIterable<unknown>) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
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
await probe("GET /v1/device", () => client.device({ timeoutMs: 6000 }));
await probe("GET /v1/tree", () => client.tree());
await probe("GET /v1/fs/dirs", () => client.dirs(""));
await probe("GET /v1/docs/:kind", () => client.deviceDoc("app.shared-state"));
await firstFrame("GET /v1/events", (signal) => client.deviceEvents(signal));
await probe("GET /v1/sessions", () => client.sessions());

const sessions = await client.sessions().catch(() => []);
const s = sessions[0]?.id ?? "cloudflare";
const a = "main";
const agent = client.agent(s, a);
const session = client.session(s);

// ---------------------------------------------------------------- session scope
await probe("GET /v1/sessions/:s", () => session.get());
await probe("PATCH /v1/sessions/:s", () => session.rename("cf-sweep"));
await probe("GET /v1/sessions/:s/agents", () => session.agents());
await probe("POST /v1/sessions/:s/agents", () => session.createAgent({ name: `sweep-${Date.now()}` }));
await probe("GET /v1/sessions/:s/tasks", () => session.tasks("terminal", 5));
await probe("GET /v1/sessions/:s/tasks?status=live", () => session.tasks("live", 5));
await probe("GET /v1/sessions/:s/inspect", () => session.inspect());
await probe("GET /v1/sessions/:s/compaction", () => session.compaction());
await probe("PATCH /v1/sessions/:s/compaction", () => session.setCompaction({ enabled: true }));
await firstFrame("GET /v1/sessions/:s/events", (signal) => session.events(signal));
await probe("POST /v1/sessions/:s/tasks/:id/abort", () => session.abortTask(1));

// ---------------------------------------------------------------- agent scope
await probe("GET .../agents/:a", () => agent.get());
await probe("PATCH .../agents/:a", () => agent.rename("Main"));
await probe("GET .../agents/:a/config", () => agent.config());
await probe("PATCH .../agents/:a/config", () => agent.configure({ thinkingLevel: "off" }));
await probe("GET .../agents/:a/extensions", () => agent.extensions());
await probe("PATCH .../agents/:a/extensions", () => agent.setExtension({ name: "cloudflare", enabled: true }));
await probe("GET .../agents/:a/entries", () => agent.entries({ limit: 5 }));
await probe("GET .../agents/:a/entries?scope=active", () => agent.entries({ scope: "active", limit: 5 }));
await probe("GET .../agents/:a/transcript", () => agent.transcript("json"));
await probe("GET .../agents/:a/transcript?format=markdown", () => agent.transcript("markdown"));
await probe("GET .../agents/:a/docs/:kind", () => agent.doc("demo.job-runs"));
await firstFrame("GET .../agents/:a/events", (signal) => agent.events(signal));
await probe("POST .../agents/:a/messages (queued)", () =>
  agent.send("sweep queued", "followUp", `sweep-${Date.now()}`, 0),
);
await probe("GET .../submissions/:id", () => session.submission(1, 0));
await probe("POST .../agents/:a/abort", () => agent.abort());
await probe("DELETE .../agents/:a/inbox/:id", () => agent.withdraw(1));
await probe("POST .../agents/:a/compact", () => agent.compact());
await probe("POST .../agents/:a/reset", () => agent.reset());
await probe("POST .../agents/:a/fork", () => agent.fork({ name: `fork-${Date.now()}` }));
await probe("POST .../agents/:a/demo/state", () => agent.demo("state", { operation: "read", path: "/" }));
await probe("POST .../agents/:a/demo/jobs", () => agent.demo("jobs", {}));
await probe("POST .../agents/:a/demo/jobs/:id/approval", () => agent.demo("jobs/1/approval", { approved: true }));
await probe("POST /v1/sessions", () => client.createSession({ name: `sweep-${Date.now()}` }));

// ---------------------------------------------------------------- report
const width = Math.max(...rows.map((r) => r.name.length));
const failed = rows.filter((r) => !r.ok);
for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
console.log(`\n${rows.length - failed.length}/${rows.length} ok, ${failed.length} failing`);
process.exitCode = failed.length > 0 ? 1 : 0;
