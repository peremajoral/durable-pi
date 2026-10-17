// Durable Pi as a DEVICE of the network: a pi-durable harness inside a Cloudflare Durable
// Object, speaking the same /v1 contract as apps/dpi-backend, so the hub (4781), dpi-tui and
// curl reach it with no new client code. Register it in dpi-network.yaml as kind `url`.
//
// Contract taken from apps/dpi-sdk/src/client.ts (what every client calls) and the shapes from
// apps/dpi-sdk/src/api.ts. The transcript is normalized with the SDK's own toTranscript /
// toMarkdown, the same functions the backend's endpoint uses, so every client stitches tool
// calls and results identically.
//
// 1.3.0 API notes, each of which cost me a debugging round:
//   - openDurableObjectSqliteStorage(ctx.storage) is ASYNC
//   - Harness.open(storage, opts, ctx) then harness.resume() continues unfinished tasks
//   - a conversation needs an agent model, or submissions settle `unanswered`
//   - a tool returns { output: [...] }; `content` was the 1.0.3 name and yields empty output
//   - the faux handle re-arms itself inside the reply factory, or the 2nd request fails
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  section,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { DEFAULT_COMPACTION } from "../../dpi-sdk/src/api.ts";
import { toMarkdown, toTranscript } from "../../dpi-sdk/src/transcript.ts";

const context = BACKGROUND_CONTEXT;
const API_VERSION = 1;

// ─── the agent: one echo tool, so a tool call is visible end to end ────────────

// The spec is kept apart from the tool so the agent detail endpoint can report the same schema the
// model sees, instead of a second copy that drifts.
const ECHO_SPEC = {
  name: "echo",
  description: "Echo the given text back, prefixed with 'echo:'.",
  parameters: Type.Object({ text: Type.String() }),
};

const echo = defineTool({
  ...ECHO_SPEC,
  replay: "safe",
  execute: async (args: { text: string }) => ({
    output: [{ type: "text" as const, text: `echo: ${args.text}` }],
  }),
});

const appExtension = defineExtension({
  name: "cloudflare",
  tools: [echo],
  sections: [section("preamble", () => "You are a concise assistant.", { tag: false })],
});

function createFauxModels() {
  const models = createModels();
  const handle = fauxProvider({
    provider: "faux",
    models: [{ id: "echo", name: "Faux Echo", contextWindow: 128000, maxTokens: 8192 }],
    tokensPerSecond: 400,
  });
  const textOf = (m: { content?: unknown } | undefined): string => {
    const content = m?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return (content as { type: string; text?: string }[])
        .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
        .join("");
    return "";
  };
  const reply: FauxResponseFactory = (generation) => {
    handle.appendResponses([reply]);
    const messages = generation.messages as unknown as { role?: string; content?: unknown }[];
    const last = messages.at(-1);
    if (last?.role === "toolResult")
      return fauxAssistantMessage(fauxText(`Tool said: ${textOf(last).trim()}`));
    const prompt = textOf([...messages].reverse().find((m) => m.role === "user")).trim();
    if (prompt.startsWith("tool:"))
      return fauxAssistantMessage(
        [fauxText("Calling echo."), fauxToolCall("echo", { text: prompt.slice(5).trim() })],
        { stopReason: "toolUse" },
      );
    return fauxAssistantMessage(fauxText(`Echo: ${prompt}`));
  };
  handle.setResponses([reply]);
  models.setProvider(handle.provider);
  return models;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

interface Env {
  SESSIONS: DurableObjectNamespace<Session>;
  /** Bearer token every /v1 call must present. Set with `wrangler secret put DPI_TOKEN`. */
  DPI_TOKEN?: string;
  DPI_DEVICE_NAME?: string;
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const fail = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

const SESSION_NAME = "cloudflare";
const AGENT_NAME = "main";

/**
 * Server-Sent Events, written the same way apps/dpi-backend/src/streams.ts writes them: an
 * `id`/`event`/`data` triple per frame, a `hello` frame first, one frame per type. Closing the
 * response runs the registered cleanups, so a disconnected viewer never leaves a watcher running.
 */
class Sse {
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #encoder = new TextEncoder();
  #seq = 0;
  #closed = false;
  #cleanups: Array<() => void> = [];
  #last = new Map<string, string>();
  #stream: ReadableStream<Uint8Array>;

  constructor(scope: unknown) {
    this.#stream = new ReadableStream({
      start: (controller) => {
        this.#controller = controller;
        this.send({ type: "hello", apiVersion: API_VERSION, serverTime: Date.now(), scope });
      },
      cancel: () => this.close(),
    });
  }

  get closed() {
    return this.#closed;
  }

  send(frame: unknown) {
    if (this.#closed) return;
    const type = (frame as { type: string }).type;
    try {
      this.#controller.enqueue(
        this.#encoder.encode(`id: ${++this.#seq}\nevent: ${type}\ndata: ${JSON.stringify(frame)}\n\n`),
      );
    } catch {
      this.close();
    }
  }

  /** Only send when the payload changed: republishing identical frames just churns the client. */
  sendIfChanged(key: string, frame: unknown) {
    const encoded = JSON.stringify(frame);
    if (this.#last.get(key) === encoded) return;
    this.#last.set(key, encoded);
    this.send(frame);
  }

  onClose(fn: () => void) {
    if (this.#closed) fn();
    else this.#cleanups.push(fn);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const fn of this.#cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // A cleanup that throws must not keep the rest from running.
      }
    }
    try {
      this.#controller.close();
    } catch {
      // Already closed by the client.
    }
  }

  response() {
    return new Response(this.#stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }
}

// ─── the Durable Object: one device, one session, one agent ───────────────────

export class Session extends DurableObject<Env> {
  #harness?: Promise<Harness>;

  async harness(): Promise<Harness> {
    if (!this.#harness) {
      this.#harness = (async () => {
        const registry = createRegistry();
        registry.install(appExtension);
        const storage = await openDurableObjectSqliteStorage(this.ctx.storage as never);
        const harness = await Harness.open(
          storage,
          {
            models: createFauxModels(),
            registry,
            settings: { extensions: [appExtension], documentRetentionMs: 0 },
          },
          context,
        );
        harness.resume();
        return harness;
      })();
    }
    return this.#harness;
  }

  /** The device's one conversation. Creating the agent here means the run always has a model. */
  async root() {
    const harness = await this.harness();
    return harness.root(context, {
      agent: {
        model: { provider: "faux", modelId: "echo" },
        thinkingLevel: "off",
        extensions: [appExtension],
        tools: [echo],
      },
    });
  }

  async #entries(conversation: Awaited<ReturnType<Session["root"]>>) {
    const view = await (conversation as never as {
      viewState(ctx: unknown): Promise<{ value: { entries: unknown[] }; dispose(): void }>;
    }).viewState(context);
    try {
      return JSON.parse(JSON.stringify(view.value.entries)) as {
        id: number;
        kind: string;
        model?: readonly unknown[];
      }[];
    } finally {
      view.dispose();
    }
  }

  async #agentSummary() {
    const root = await this.root();
    return {
      id: root.id,
      name: AGENT_NAME,
      named: true,
      kind: "main" as const,
      busy: false,
      background: 0,
    };
  }

  /** The agent record as pi-durable holds it; the detail and config endpoints both report it. */
  async #agentConfig() {
    const root = await this.root();
    const spec = (await root.agent(context)) as unknown as {
      model?: { provider: string; modelId: string };
      thinkingLevel?: string;
      instructions?: string;
      cwd?: string;
    };
    return {
      model: spec.model,
      thinkingLevel: spec.thinkingLevel,
      instructions: spec.instructions,
      cwd: spec.cwd,
      readOnly: false,
    };
  }

  async #sessionSummary() {
    const root = await this.root();
    const entries = await this.#entries(root);
    return {
      id: String(root.id),
      name: SESSION_NAME,
      cwd: "/",
      model: "faux/echo",
      createdAt: 0,
      dbPath: "durable-object-sqlite://self",
      busy: false,
      agents: [await this.#agentSummary()],
      entryCount: entries.length,
    };
  }

  #deviceInfo() {
    return {
      uid: this.ctx.id.toString(),
      name: "cloudflare-do",
      hostname: "durable-object",
      platform: "workerd",
      apiVersion: API_VERSION,
      durableVersion: "1.3.0",
      startedAt: 0,
      startDirs: ["/"],
      models: [{ id: "echo", name: "Faux Echo", provider: "faux" }],
      defaultModel: "echo",
      storage: {
        dataDir: "durable-object-sqlite",
        catalogPath: "durable-object-sqlite",
        appStatePath: "durable-object-sqlite",
      },
      capabilities: ["events"],
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (path === "/healthz") return json({ ok: true });

    // Token, exactly as dpi-backend: Authorization: Bearer or X-DPI-Token.
    const expected = this.env.DPI_TOKEN;
    const presented =
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      request.headers.get("x-dpi-token") ??
      "";
    if (expected && presented !== expected)
      return fail(401, "unauthorized", "missing or wrong device token");

    if (path === "/v1/device" && method === "GET") return json(this.#deviceInfo());

    if (path === "/v1/tree" && method === "GET")
      return json({
        uid: this.ctx.id.toString(),
        name: "cloudflare-do",
        sessions: [await this.#sessionSummary()],
        at: Date.now(),
      });

    if (path === "/v1/sessions" && method === "GET") return json([await this.#sessionSummary()]);

    if (path === "/v1/sessions" && method === "POST") {
      const summary = await this.#sessionSummary();
      return json(summary, 201);
    }

    const session = path.match(/^\/v1\/sessions\/([^/]+)(\/.*)?$/);
    if (session) {
      const rest = session[2] ?? "";
      if (rest === "" && method === "GET") return json(await this.#sessionSummary());
      if (rest === "/agents" && method === "GET")
        return json((await this.#sessionSummary()).agents);
      if (rest === "/compaction" && method === "GET") return json(DEFAULT_COMPACTION);

      // Session scope: agents, tasks and usage, republished while the task graph moves.
      if (rest === "/events" && method === "GET") {
        const harness = await this.harness();
        const root = await this.root();
        const sse = new Sse({ kind: "session", sessionId: String(root.id) });
        const watch = await harness.watchTaskGraph(context);
        const tasks = () =>
          JSON.parse(
            JSON.stringify(Object.values((watch.value as { tasks: Record<string, unknown> }).tasks)),
          ) as unknown[];
        const agents = async () => (await this.#sessionSummary()).agents;
        sse.send({
          type: "session",
          agents: await agents(),
          tasks: tasks(),
          usage: await harness.usage(context),
        });
        watch.start(async () => {
          if (sse.closed) return;
          sse.sendIfChanged("tasks", { type: "tasks", tasks: tasks() });
          void (async () => {
            sse.sendIfChanged("agents", { type: "agents", agents: await agents() });
            sse.sendIfChanged("usage", { type: "usage", usage: await harness.usage(context) });
          })();
        });
        sse.onClose(() => void watch.stop());
        return sse.response();
      }

      const agent = rest.match(/^\/agents\/([^/]+)(\/.*)?$/);
      if (agent) {
        const tail = agent[2] ?? "";
        const root = await this.root();

        if (tail === "" && method === "GET")
          return json({
            ...(await this.#agentSummary()),
            sessionId: String(root.id),
            config: await this.#agentConfig(),
            tools: [
              {
                name: ECHO_SPEC.name,
                description: ECHO_SPEC.description,
                replay: "safe",
                parameters: JSON.parse(JSON.stringify(ECHO_SPEC.parameters)),
                writes: false,
                offered: true,
              },
            ],
            extensions: [appExtension.name],
          });

        if (tail === "/config" && method === "GET") return json(await this.#agentConfig());

        if (tail === "/extensions" && method === "GET")
          return json({ extensions: [{ name: appExtension.name }], builtIn: [] });

        if (tail === "/entries" && method === "GET")
          // The object holds one conversation, so its active view is the whole history.
          return json({ items: await this.#entries(root) });

        // Agent scope: pi-durable's own event stream. The snapshot seeds the client, then every
        // batch is forwarded verbatim, exactly as the backend's agentStream does.
        if (tail === "/events" && method === "GET") {
          const harness = await this.harness();
          const sse = new Sse({ kind: "agent", sessionId: String(root.id), agentId: root.id });
          const events = await watchEvents(harness, root.id, context);
          sse.send({
            type: "snapshot",
            snapshot: JSON.parse(JSON.stringify(events.snapshot)),
            inbox: [],
          });
          events.start(async (batch) => {
            if (sse.closed) return;
            sse.send({ type: "batch", events: JSON.parse(JSON.stringify(batch)) });
          });
          sse.onClose(() => void events.stop());
          return sse.response();
        }

        if (tail === "/transcript" && method === "GET") {
          const entries = await this.#entries(root);
          const items = toTranscript(entries as never);
          return url.searchParams.get("format") === "markdown"
            ? json({ format: "markdown", text: toMarkdown(items) })
            : json({ format: "json", items });
        }

        if (tail === "/messages" && method === "POST") {
          const body = (await request.json()) as {
            content?: string;
            requestId?: string;
            waitMs?: number;
          };
          if (typeof body?.content !== "string" || body.content.length === 0)
            return fail(400, "invalid", "content is required");
          const submission = await root.submit(
            {
              type: "input",
              content: body.content,
              ...(body.requestId ? { requestId: body.requestId } : {}),
            },
            context,
          );
          const waitMs = Math.max(0, Number(body.waitMs ?? 0));
          if (waitMs === 0) return json({ submissionId: submission.id, status: "queued" }, 202);
          const settled = await submission.wait(context);
          let answer: { entryId: number; text: string } | undefined;
          if (settled.answer !== undefined) {
            const entry = await root.commit(
              (tx) => tx.entry(AssistantEntry, settled.answer!),
              context,
            );
            const text = ((entry?.model ?? []) as unknown as { content?: unknown }[])
              .map((message) => {
                const content = (message as { content?: unknown }).content;
                if (typeof content === "string") return content;
                if (Array.isArray(content))
                  return (content as { type: string; text?: string }[])
                    .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
                    .join("");
                return "";
              })
              .filter((t) => t.length > 0)
              .join("\n");
            answer = { entryId: settled.answer, text };
          }
          return json(
            {
              submissionId: submission.id,
              status: settled.status,
              ...(answer ? { answer } : {}),
              ...(settled.status === "unanswered" && "reason" in settled
                ? { reason: (settled as { reason?: string }).reason }
                : {}),
            },
            settled.status === "done" ? 200 : 202,
          );
        }
      }
      return fail(404, "not_found", `no route ${method} ${path}`);
    }

    // Device scope. The hub reads the device tree FROM here: monitor.ts follows /v1/events and
    // only applies frames of `type: "tree"`. A stream without them leaves the device online but
    // with no sessions, which the dashboard renders as an empty device.
    if (path === "/v1/events" && method === "GET") {
      const sse = new Sse({ kind: "device" });
      // `at: 0` on purpose: the frame must be byte-stable between polls, or sendIfChanged would
      // republish an unchanged tree every tick just because the clock moved.
      const push = async () => {
        if (sse.closed) return;
        sse.sendIfChanged("tree", {
          type: "tree",
          tree: {
            uid: this.ctx.id.toString(),
            name: "cloudflare-do",
            sessions: [await this.#sessionSummary()],
            at: 0,
          },
        });
      };
      await push();
      // pi-durable exposes no change feed for the device-wide view, so the tree is republished on
      // a timer. There is one session here; this is cheap and keeps every client correct.
      const timer = setInterval(() => void push(), 5000);
      sse.onClose(() => clearInterval(timer));
      return sse.response();
    }

    return fail(404, "not_found", `no route ${method} ${path}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // /healthz is open, like dpi-backend; everything else goes to the object that owns the run.
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName("root"));
    return stub.fetch(request);
  },
};
