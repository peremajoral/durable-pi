// REST v1. Every route requires the device token (see auth.ts). Session refs are a UUID or a
// unique name; agent refs are a numeric id, `main`, or a unique name.
//
// Hono, not express: this router is meant to be mounted unchanged on a Node server and inside a
// Cloudflare Durable Object, so it may not reach for a Node-only framework. Bodies, status codes
// and the error shape are the ones apps/dpi-backend/API.md documents.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { DEVICE_DOC_KINDS, type DeviceStore, type SessionRow } from "./device-store.js";
import { agentStream, deviceStream, sessionStream } from "./streams.js";
import { openChannel } from "./sse.js";
import { idempotent } from "./idempotency.js";
import { invalid } from "./errors.js";

const MAX_BODY = 256 * 1024;
const MAX_WAIT_MS = 300_000;

/** A JSON Response, built here rather than through the framework, so both hosts answer alike. */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const int = (value: unknown, name: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw invalid(`${name} must be an integer`);
  return n;
};

/** express.json() semantics: no body is {}, malformed JSON is a 400 invalid, over the limit is too.
 *  Untyped on purpose: the body is the wire boundary, exactly as `req.body` was. */
async function body(c: Context): Promise<any> {
  const length = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY) throw invalid("Body too large");
  const text = await c.req.text();
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null ? parsed : {};
}

const waitMsOf = (value: unknown) => Math.min(Number(value ?? 0) || 0, MAX_WAIT_MS);

export function v1(store: DeviceStore) {
  const app = new Hono();
  const create = idempotent(store);

  const rowOf = (c: Context): SessionRow => store.resolveSession(c.req.param("s") ?? "");
  /** Resolve both refs once per request: the session row, the harness and the conversation. */
  const targetOf = async (c: Context) => {
    const row = rowOf(c);
    const resolved = await store.resolveAgent(c.req.param("s") ?? "", c.req.param("a") ?? "");
    return { row, h: resolved.h as Harness, conv: resolved.c as Conversation };
  };
  /** A stream route: the channel writes into a ReadableStream and the Response is built after. */
  const stream = async (c: Context, run: (res: ReturnType<typeof openChannel>["res"]) => void | Promise<void>) => {
    const channel = openChannel(c.req.raw.signal);
    await run(channel.res);
    return channel.response();
  };

  // ---------------------------------------------------------- device
  app.get("/device", (c) => json(store.deviceInfo()));
  app.get("/tree", async (c) => json(await store.tree()));
  app.get("/events", (c) => stream(c, (res) => deviceStream(store, { query: c.req.query() }, res)));
  app.get("/fs/dirs", async (c) => json(await store.browse(String(c.req.query("path") ?? ""))));
  app.get("/docs/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (!DEVICE_DOC_KINDS.includes(kind)) throw invalid(`Unknown device document ${kind}`);
    return json({ kind, ...(await store.deviceDoc(kind)) });
  });

  // ---------------------------------------------------------- sessions
  app.get("/sessions", async () => json((await store.tree()).sessions));
  app.post("/sessions", create, async (c) => json(await store.create(await body(c)), 201));
  app.get("/sessions/:s", async (c) => json(await store.sessionSummary(rowOf(c))));
  app.patch("/sessions/:s", async (c) => json(await store.rename(rowOf(c), (await body(c)).name)));
  app.get("/sessions/:s/compaction", (c) => json(store.compactionOf(rowOf(c).id)));
  app.patch("/sessions/:s/compaction", async (c) => json(store.setCompaction(rowOf(c), await body(c))));
  app.delete("/sessions/:s", async (c) => json(await store.archive(rowOf(c))));
  app.get("/sessions/:s/events", (c) => stream(c, (res) => sessionStream(store, rowOf(c), res)));
  app.get("/sessions/:s/tasks", async (c) => {
    const status = String(c.req.query("status") ?? "terminal");
    if (!["live", "terminal"].includes(status)) throw invalid("status must be live or terminal");
    const h = store.harness(rowOf(c));
    if (status === "live") return json(await store.liveTasks(h));
    return json(await store.tasks(h, status, Number(c.req.query("limit") ?? 20)));
  });
  app.post("/sessions/:s/tasks/:taskId/abort", async (c) =>
    json(await store.abortTask(store.harness(rowOf(c)), int(c.req.param("taskId"), "taskId"))),
  );
  app.get("/sessions/:s/inspect", async (c) => json(await store.inspect(store.harness(rowOf(c)))));
  app.get("/sessions/:s/submissions/:id", async (c) =>
    json(
      await store.settled(
        store.harness(rowOf(c)),
        int(c.req.param("id"), "submission id"),
        waitMsOf(c.req.query("waitMs")),
        c.req.raw.signal,
      ),
    ),
  );

  // ---------------------------------------------------------- agents
  app.get("/sessions/:s/agents", async (c) => json(await store.agents(rowOf(c))));
  app.post("/sessions/:s/agents", create, async (c) => json(await store.createAgent(rowOf(c), await body(c)), 201));
  const a = "/sessions/:s/agents/:a";
  app.get(a, async (c) => {
    const { row, conv } = await targetOf(c);
    return json(await store.agentDetail(row, conv));
  });
  app.patch(a, async (c) => {
    const { row, conv } = await targetOf(c);
    store.setAgentName(row, conv.id as number, (await body(c)).name);
    return json(await store.agentSummary(row, conv));
  });
  app.get(
    `${a}/events`,
    (c) =>
      stream(c, async (res) => {
        const { row, h, conv } = await targetOf(c);
        return agentStream(store, { row, h, c: conv }, { query: c.req.query() }, res);
      }),
  );
  app.get(`${a}/entries`, async (c) => {
    const { conv } = await targetOf(c);
    if (String(c.req.query("scope") ?? "all") === "active")
      return json({ items: await store.activeEntries(conv) });
    return json(await store.entries(conv, c.req.query("cursor"), Number(c.req.query("limit") ?? 500)));
  });
  app.get(`${a}/transcript`, async (c) => {
    const { conv } = await targetOf(c);
    return json(await store.transcript(conv, String(c.req.query("format") ?? "json")));
  });
  app.post(`${a}/messages`, async (c) => {
    const { h, conv } = await targetOf(c);
    const input = await body(c);
    const submission = await store.send(conv, input);
    const waitMs = waitMsOf(input.waitMs);
    if (!waitMs) return json({ submissionId: submission.id, status: "queued" }, 202);
    const result = await store.settled(h, submission.id as number, waitMs, c.req.raw.signal);
    const settled = result.status === "done" || result.status === "unanswered";
    return json(result, settled ? 200 : 202);
  });
  app.delete(`${a}/inbox/:submissionId`, async (c) => {
    const { h, conv } = await targetOf(c);
    return json(await store.withdraw(h, conv, int(c.req.param("submissionId"), "submissionId")));
  });
  app.post(`${a}/abort`, async (c) => {
    const { conv } = await targetOf(c);
    return json(await store.abort(conv, (await body(c)).background === true));
  });
  app.post(`${a}/fork`, create, async (c) => {
    const { row, conv } = await targetOf(c);
    return json(await store.fork(row, conv, await body(c)), 201);
  });
  app.get(`${a}/config`, async (c) => {
    const { row, conv } = await targetOf(c);
    return json((await store.agentDetail(row, conv)).config);
  });
  app.patch(`${a}/config`, async (c) => {
    const { row, conv } = await targetOf(c);
    return json(await store.configure(row, conv, await body(c)));
  });
  app.get(`${a}/extensions`, async (c) => {
    const { row, conv } = await targetOf(c);
    return json(await store.extensionsOf(row, conv));
  });
  app.patch(`${a}/extensions`, async (c) => {
    const { row, conv } = await targetOf(c);
    return json(await store.setExtension(row, conv, await body(c)));
  });
  app.post(`${a}/compact`, async (c) => {
    const { conv } = await targetOf(c);
    return json(await store.compact(conv, (await body(c)).instructions));
  });
  app.post(`${a}/reset`, async (c) => {
    const { conv } = await targetOf(c);
    return json(await store.reset(conv, (await body(c)).note));
  });
  app.get(`${a}/docs/:kind`, async (c) => {
    const { h, conv } = await targetOf(c);
    const kind = c.req.param("kind");
    return json({ kind, value: await store.agentDoc(h, conv, kind) });
  });

  // ---------------------------------------------------------- demo extension
  app.post(`${a}/demo/state`, async (c) => {
    const { conv } = await targetOf(c);
    return json(await store.demoState(conv, await body(c)));
  });
  app.post(`${a}/demo/jobs`, async (c) => {
    const { row, h, conv } = await targetOf(c);
    return json(await store.startJob(row, h, conv, await body(c)), 201);
  });
  app.post(`${a}/demo/jobs/:taskId/approval`, async (c) => {
    const { conv } = await targetOf(c);
    return json(await store.approveJob(conv, int(c.req.param("taskId"), "taskId"), (await body(c)).approved));
  });

  return app;
}
