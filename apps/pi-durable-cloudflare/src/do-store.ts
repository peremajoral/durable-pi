// The Durable Object's own store. routes.ts and streams.ts are shared verbatim with the Node
// backend; what cannot be shared is the bookkeeping behind them, and this is that bookkeeping.
//
// Every pi-durable import goes through ../../dpi-backend/src/harness.ts rather than the package, so
// the harness this store builds is the same module instance streams.ts brand-checks. See that file.
//
// A Durable Object has no filesystem, no shell and no writable cwd, so the parts of the Node store
// that need one - browsing directories, durable job runs, the workspace document - answer an
// `unavailable` fault instead of pretending. Everything else is the same behaviour over
// ctx.storage.sql: one device, one session, one root agent, which is what a DO id already is.
import type { Conversation, Harness, ToolRegistration } from "@earendil-works/pi-durable";
import {
  BACKGROUND_CONTEXT as agentCtx,
  Harness as HarnessClass,
  InboxDoc,
  createModels,
  createRegistry,
  installFaux,
  fauxModels,
  lastAssistantText,
  messageText,
  ollamaModels,
  ollamaProvider,
  openDurableObjectSqliteStorage,
  toMarkdown,
  toTranscript,
  withAbortSignal,
  type ConversationRecord,
} from "../../dpi-backend/src/harness.ts";
import { ApiFault } from "../../dpi-backend/src/errors.ts";
import { WRITE_TOOLS, type DeviceStore, type SessionRow } from "../../dpi-backend/src/device-store.ts";
import {
  DEFAULT_COMPACTION,
  type AgentDetail,
  type AgentRef,
  type AgentSummary,
  type CompactionSettings,
  type DeviceInfo,
  type DeviceTree,
  type InboxItem,
  type ModelInfo,
  type Page,
  type SessionSummary,
  type TaskNode,
  type ThinkingLevel,
  type UsageTotals,
  type WireEntry,
} from "../../dpi-sdk/src/api.ts";

const DEVICE_VERSION = "1.3.0";

/** The model this device runs: the same deterministic, free one the Node device uses with faux. */
const MODEL_ID = fauxModels[0].id;
const PROVIDER = "faux";

/** A capability this device does not have. A formed fault of the contract's own kind, not a crash. */
const unavailable = (what: string) => new ApiFault("unavailable", `${what} is not available on this device`);

/** Signature of one method of the shared contract, taken from the contract itself: a stub cannot
 *  drift from the interface it is standing in for, because it is typed by that interface. */
type Fn<K extends keyof DeviceStore> = DeviceStore[K] extends (...args: any[]) => any ? DeviceStore[K] : never;
type Args<K extends keyof DeviceStore> = Parameters<Fn<K>>;
type Result<K extends keyof DeviceStore> = ReturnType<Fn<K>>;

/** Opaque to clients, who only hand it back. web atob/btoa rather than Node's Buffer, so this file
 *  bundles into a Worker. */
const encodeCursor = (cursor: unknown) => (cursor === undefined ? undefined : btoa(JSON.stringify(cursor)));
const decodeCursor = (cursor?: string): Record<string, any> | undefined => {
  if (!cursor) return undefined;
  try {
    return JSON.parse(atob(cursor)) as Record<string, any>;
  } catch {
    throw new ApiFault("invalid", "Invalid cursor");
  }
};

interface Env {
  DPI_TOKEN?: string;
  DPI_DEVICE_NAME?: string;
  DPI_MODEL?: string;
  /** "faux" (default) or "ollama": the endpoint in DPI_OLLAMA_BASE_URL, OpenAI-compatible. */
  DPI_PROVIDER?: string;
  DPI_OLLAMA_BASE_URL?: string;
  OLLAMA_API_KEY?: string;
}

/** A task as pi-durable's task graph reports it, before it is mapped to the wire shape. */
type RawTask = {
  id: number;
  kind: string;
  conversationId?: number;
  owner?: number;
  background?: boolean;
  abortRequested?: boolean;
  state: { status: string; phase?: string; on?: readonly number[]; policy?: string };
  conversations?: readonly number[];
};

export class DoStore implements DeviceStore {
  /** Sessions whose harness is open. streams.ts reads it to tell a live session from a dead one. */
  readonly opened = new Map<string, any>();
  readonly startedAt = Date.now();
  /** The provider, set once: a faux handle that re-arms is what makes a second turn possible. */
  readonly models = createModels();

  /** What this device actually runs, decided in #installProvider and reported everywhere. */
  #provider: string = PROVIDER;
  #modelId: string = MODEL_ID;
  #modelInfo?: ModelInfo[];

  #sql: SqlStorage;
  #name: string;
  #listeners = new Set<() => void>();
  #harness?: Promise<Harness>;
  #session?: SessionRow;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.#sql = ctx.storage.sql;
    this.#name = env.DPI_DEVICE_NAME ?? "cloudflare-do";
  }

  /** Open the storage, the harness and this device's one session. The DO's fetch awaits it, so no
   *  route ever runs against a half-built store. */
  async ready(): Promise<void> {
    await this.#root();
  }

  // ------------------------------------------------------------ catalog

  #catalog() {
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,name TEXT NOT NULL,cwd TEXT NOT NULL,
        dbPath TEXT NOT NULL UNIQUE,createdAt INTEGER NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_names(sessionId TEXT NOT NULL,conversationId INTEGER NOT NULL,
        name TEXT NOT NULL,PRIMARY KEY(sessionId,conversationId))`,
    );
  }

  list(): SessionRow[] {
    this.#catalog();
    return [...this.#sql.exec("SELECT * FROM sessions ORDER BY createdAt")] as unknown as SessionRow[];
  }

  /** A UUID or a case-insensitive unique name, exactly as the Node store resolves one. */
  resolveSession(ref: string): SessionRow {
    const rows = [
      ...this.#sql.exec("SELECT * FROM sessions WHERE id=? OR name=? COLLATE NOCASE", ref, ref),
    ] as unknown as SessionRow[];
    if (!rows.length) throw new ApiFault("not_found", `No session ${ref}`);
    if (rows.length > 1) throw new ApiFault("ambiguous", `Session name ${ref} is not unique`);
    return rows[0];
  }

  /** Names a person gave to conversations, which live in this device's catalog, not the harness. */
  #names(sessionId: string): Map<number, string> {
    this.#catalog();
    const rows = [
      ...this.#sql.exec("SELECT conversationId,name FROM conversation_names WHERE sessionId=?", sessionId),
    ] as unknown as { conversationId: number; name: string }[];
    return new Map(rows.map((row) => [Number(row.conversationId), String(row.name)]));
  }

  // ------------------------------------------------------------ device

  #fauxModelList(): ModelInfo[] {
    return fauxModels.map((m) => ({
      id: m.id,
      provider: PROVIDER,
      name: m.name,
      tier: "free",
      icon: "flask",
      contextWindow: 128000,
      reasoning: false,
      cost: { input: 0, output: 0 },
    }));
  }

  deviceInfo(): DeviceInfo {
    return {
      uid: this.ctx.id.toString(),
      name: this.#name,
      hostname: "durable-object",
      platform: "workerd",
      apiVersion: 1,
      durableVersion: DEVICE_VERSION,
      startedAt: this.startedAt,
      startDirs: ["/"],
      models: this.#modelInfo ?? this.#fauxModelList(),
      defaultModel: this.#modelId,
      storage: {
        dataDir: "durable-object-sqlite",
        catalogPath: "durable-object-sqlite",
        appStatePath: "durable-object-sqlite",
      },
      // What this device can actually do: a client reads this instead of assuming a filesystem.
      capabilities: ["events"],
    };
  }

  async tree(): Promise<DeviceTree> {
    const sessions = await Promise.all(this.list().map((row) => this.sessionSummary(row)));
    return { uid: this.ctx.id.toString(), name: this.#name, sessions, at: Date.now() };
  }

  // ------------------------------------------------------------ change feed

  subscribe(fn: () => void) {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  notify = () => {
    for (const fn of this.#listeners) fn();
  };

  // ------------------------------------------------------------ the harness

  /** This device's one session: a DO id is already a single addressable thing. */
  async #root(): Promise<SessionRow> {
    if (this.#session) return this.#session;
    this.#catalog();
    const existing = this.list()[0];
    if (existing) {
      // Its model is made to match this device's provider in #open, which is also where the choice
      // is made: creating a row here cannot know it yet.
      this.#session = existing;
      await this.#open(existing);
      return existing;
    }
    const created: SessionRow = {
      id: crypto.randomUUID(),
      name: this.#name,
      cwd: "/",
      dbPath: `do://${this.ctx.id.toString()}`,
      createdAt: Date.now(),
      model: MODEL_ID,
      provider: PROVIDER,
    };
    this.#sql.exec(
      "INSERT INTO sessions VALUES(?,?,?,?,?,?,?)",
      created.id,
      created.name,
      created.cwd,
      created.dbPath,
      created.createdAt,
      created.model,
      created.provider,
    );
    this.#session = created;
    await this.#open(created);
    return created;
  }

  /** The provider this device runs: the fake one by default, a real one when configured.
   *
   *  "ollama" is any OpenAI-compatible endpoint (DPI_OLLAMA_BASE_URL, local headroom by default).
   *  A deployed Worker cannot reach a loopback URL, so this is the local `wrangler dev` path: a
   *  deploy needs a provider Cloudflare itself can reach, and that is what DPI_PROVIDER selects. */
  async #installProvider(): Promise<void> {
    if ((this.env.DPI_PROVIDER ?? "faux") !== "ollama") {
      installFaux(this.models);
      return;
    }
    const models = await ollamaModels();
    if (!models.length) throw unavailable("The ollama endpoint this device was pointed at listed no models");
    this.models.setProvider(ollamaProvider(models));
    this.#provider = "ollama";
    this.#modelId = models.some((m) => m.id === this.env.DPI_MODEL) ? this.env.DPI_MODEL! : models[0].id;
    this.#modelInfo = models.map((m) => ({
      id: m.id,
      provider: this.#provider,
      name: m.name,
      tier: "local",
      icon: "cpu",
      contextWindow: m.contextWindow ?? 0,
      reasoning: !!m.reasoning,
      cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0 },
    }));
  }

  /** Built once and kept as a promise: the DO's fetch awaits ready(), never a route. */
  #open(row: SessionRow): Promise<Harness> {
    this.#harness ??= (async () => {
      await this.#installProvider();
      const storage = await openDurableObjectSqliteStorage(this.ctx.storage as never);
      const harness = await HarnessClass.open(
        storage,
        {
          models: this.models,
          registry: createRegistry(),
          settings: { documentRetentionMs: 0 },
        },
        agentCtx,
      );
      const spec = { provider: this.#provider, modelId: this.#modelId };
      const root = await harness.root(agentCtx, { agent: { model: spec, thinkingLevel: "off" } });
      // A conversation created under a different provider keeps that model, and a submission then
      // settles `unanswered: no_model` or quietly runs the model this device no longer uses.
      const current = (await root.agent(agentCtx)).model;
      if (current?.provider !== spec.provider || current?.modelId !== spec.modelId)
        await root.configure({ model: spec }, agentCtx);
      // The catalog row is what the tree and every session summary report: keep it in step.
      if (row.model !== this.#modelId || row.provider !== this.#provider) {
        this.#sql.exec("UPDATE sessions SET model=?,provider=? WHERE id=?", this.#modelId, this.#provider, row.id);
        row.model = this.#modelId;
        row.provider = this.#provider;
      }
      this.opened.set(row.id, { harness, root });
      harness.resume();
      return harness;
    })();
    return this.#harness;
  }

  /** Synchronous, as the shared contract declares it: ready() has already opened the session. */
  harness(row: SessionRow): Harness {
    const open = this.opened.get(row.id)?.harness as Harness | undefined;
    if (!open) throw unavailable(`Session ${row.id}`);
    return open;
  }

  async resolveAgent(...args: Args<"resolveAgent">): Promise<Awaited<Result<"resolveAgent">>> {
    const [sessionRef, agentRef] = args;
    const row = this.resolveSession(sessionRef);
    const h = this.harness(row);
    const root = await h.root(agentCtx);
    if (agentRef === "main" || agentRef === String(root.id)) return { row, h, c: root };
    const id = Number(agentRef);
    const conversation = Number.isSafeInteger(id) ? await h.conversation(id as never, agentCtx) : undefined;
    if (!conversation) throw new ApiFault("not_found", `No agent ${agentRef}`);
    return { row, h, c: conversation as Conversation };
  }

  // ------------------------------------------------------------ sessions and agents

  async sessionSummary(row: SessionRow): Promise<SessionSummary> {
    const agents = await this.agents(row);
    return {
      id: row.id,
      name: row.name,
      cwd: row.cwd,
      model: `${row.provider}/${row.model}`,
      createdAt: row.createdAt,
      dbPath: row.dbPath,
      busy: agents.some((a) => a.busy),
      agents,
    };
  }

  async create(...args: Args<"create">): Promise<Awaited<Result<"create">>> {
    // A Durable Object is addressed by id and holds one session, so a create returns that same
    // session. 201 tells the client the request was honoured, which is what it asked.
    const [body] = args;
    const row = await this.#root();
    const name = (body as { name?: unknown } | undefined)?.name;
    if (typeof name === "string" && name.trim()) {
      const trimmed = name.trim().slice(0, 100);
      this.#sql.exec("UPDATE sessions SET name=? WHERE id=?", trimmed, row.id);
      row.name = trimmed;
      this.notify();
    }
    return this.sessionSummary(row);
  }

  async rename(...args: Args<"rename">): Promise<Awaited<Result<"rename">>> {
    const [row, name] = args;
    if (typeof name !== "string" || !name.trim()) throw new ApiFault("invalid", "name is required");
    const trimmed = name.trim().slice(0, 100);
    this.#sql.exec("UPDATE sessions SET name=? WHERE id=?", trimmed, row.id);
    row.name = trimmed;
    this.notify();
    return this.sessionSummary(row);
  }

  compactionOf(..._args: Args<"compactionOf">): Result<"compactionOf"> {
    return DEFAULT_COMPACTION as CompactionSettings;
  }

  // ------------------------------------------------------------ idempotency

  #requests() {
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,route TEXT NOT NULL,status INTEGER NOT NULL,
        body TEXT NOT NULL,createdAt INTEGER NOT NULL)`,
    );
  }

  /** A repeated Idempotency-Key replays the first answer. Same route identity as the Node store:
   *  method plus path, so reusing a key on a different route stores nothing and replays nothing. */
  replay(...args: Args<"replay">): Result<"replay"> {
    const [key, route] = args;
    this.#requests();
    const row = [...this.#sql.exec("SELECT route,status,body FROM requests WHERE key=?", key)][0] as
      | { route: string; status: number; body: string }
      | undefined;
    if (!row || row.route !== route) return undefined as Result<"replay">;
    return { status: row.status, body: JSON.parse(row.body) } as Result<"replay">;
  }

  remember(...args: Args<"remember">): Result<"remember"> {
    const [key, route, status, body] = args;
    this.#requests();
    this.#sql.exec(
      "INSERT OR REPLACE INTO requests VALUES(?,?,?,?,?)",
      key,
      route,
      status,
      JSON.stringify(body),
      Date.now(),
    );
    this.#sql.exec("DELETE FROM requests WHERE createdAt < ?", Date.now() - 24 * 3600_000);
    return undefined as Result<"remember">;
  }

  // ------------------------------------------------------------ agents

  /** Every conversation of this device, paged to the end. pi-durable hands them out in pages. */
  async #scanAll(h: Harness): Promise<ConversationRecord[]> {
    return h.commit(async (tx) => {
      let page = await tx.scanConversations({}, 1000);
      const records = [...page.items];
      while (page.next) {
        page = await tx.scanConversations({}, 1000, page.next);
        records.push(...page.items);
      }
      return records;
    }, agentCtx);
  }

  #agentRef(record: ConversationRecord, names: Map<number, string>): AgentRef {
    const id = record.id;
    const named = names.get(id);
    const kind = record.parent ? ("fork" as const) : record.owner ? ("subagent" as const) : ("root" as const);
    return {
      id,
      name: named ?? (kind === "root" ? "main" : kind === "fork" ? `Fork #${id}` : `Subagent ${id}`),
      named: named !== undefined,
      kind,
      ...(record.parent ? { parentId: record.parent.conversationId, forkedAt: record.parent.at } : {}),
      ...(record.owner ? { ownerAgentId: record.owner.conversationId, ownerTaskId: record.owner.taskId } : {}),
    };
  }

  async agents(...args: Args<"agents">): Promise<Awaited<Result<"agents">>> {
    const [row, tasks] = args;
    const h = this.harness(row);
    const [records, live] = await Promise.all([this.#scanAll(h), tasks ? Promise.resolve(tasks) : this.liveTasks(h)]);
    const names = this.#names(row.id);
    return records.map((record) => {
      const own = live.filter((t) => t.conversationId === record.id);
      return {
        ...this.#agentRef(record, names),
        busy: own.some((t) => !t.background),
        background: own.filter((t) => t.background).length,
      };
    });
  }

  async agentSummary(...args: Args<"agentSummary">): Promise<Awaited<Result<"agentSummary">>> {
    const [row, c] = args;
    const agents = await this.agents(row);
    return (
      agents.find((a) => a.id === c.id) ?? {
        id: c.id as number,
        name: "agent",
        named: false,
        kind: "fork" as const,
        busy: false,
        background: 0,
      }
    );
  }

  /** The agent's own config, plus every tool its extensions register, as the model would see them. */
  async #toolsOf(c: Conversation) {
    const agent = await c.agent(agentCtx);
    const all = new Map<string, ToolRegistration>();
    for (const extension of agent.extensions) for (const tool of extension.tools ?? []) all.set(tool.name, tool);
    return { agent, all: [...all.values()], offered: new Set(agent.tools.map((t) => t.name)) };
  }

  async agentDetail(...args: Args<"agentDetail">): Promise<Awaited<Result<"agentDetail">>> {
    const [row, c] = args;
    const { agent, all, offered } = await this.#toolsOf(c);
    const writers = all.filter((t) => WRITE_TOOLS.has(t.name));
    const detail: AgentDetail = {
      ...(await this.agentSummary(row, c)),
      sessionId: row.id,
      config: {
        model: agent.model,
        thinkingLevel: agent.thinkingLevel as ThinkingLevel | undefined,
        instructions: agent.instructions,
        cwd: agent.cwd,
        readOnly: writers.length > 0 && writers.every((t) => !offered.has(t.name)),
      },
      tools: all.map((t) => ({
        name: t.name,
        description: t.description,
        replay: t.replay === "unsafe" ? ("unsafe" as const) : ("safe" as const),
        parameters: JSON.parse(JSON.stringify(t.parameters ?? null)),
        writes: WRITE_TOOLS.has(t.name),
        offered: offered.has(t.name),
      })),
      extensions: agent.extensions.map((e) => e.name),
    };
    return detail;
  }

  setAgentName(...args: Args<"setAgentName">): Result<"setAgentName"> {
    const [row, agentId, name] = args;
    if (typeof name !== "string" || !name.trim()) throw new ApiFault("invalid", "name is required");
    this.#catalog();
    this.#sql.exec(
      "INSERT OR REPLACE INTO conversation_names VALUES(?,?,?)",
      row.id,
      agentId,
      name.trim().slice(0, 100),
    );
    this.notify();
    return undefined as Result<"setAgentName">;
  }

  async preview(...args: Args<"preview">): Promise<Awaited<Result<"preview">>> {
    const [row, agentId] = args;
    const h = this.opened.get(row.id)?.harness as Harness | undefined;
    if (!h) return undefined;
    const c = await h.conversation(agentId as never, agentCtx);
    if (!c) return undefined;
    return lastAssistantText(await this.activeEntries(c as Conversation))?.slice(0, 200);
  }

  // ------------------------------------------------------------ entries

  async entries(...args: Args<"entries">): Promise<Awaited<Result<"entries">>> {
    const [c, cursor, limit] = args;
    const page = await c.entries({}, Math.min(Math.max(limit, 1), 2000), decodeCursor(cursor), agentCtx);
    return { items: page.items as unknown as WireEntry[], next: encodeCursor(page.next) } as Page<WireEntry>;
  }

  async activeEntries(...args: Args<"activeEntries">): Promise<Awaited<Result<"activeEntries">>> {
    const [c] = args;
    const view = await c.viewState(agentCtx);
    try {
      return JSON.parse(JSON.stringify(view.value.entries)) as WireEntry[];
    } finally {
      view.dispose();
    }
  }

  async transcript(...args: Args<"transcript">): Promise<Awaited<Result<"transcript">>> {
    const [c, format] = args;
    const items = toTranscript(await this.activeEntries(c));
    return (format === "markdown" ? { format: "markdown", text: toMarkdown(items) } : { format: "json", items }) as Awaited<
      Result<"transcript">
    >;
  }

  async inbox(...args: Args<"inbox">): Promise<Awaited<Result<"inbox">>> {
    const [h, c] = args;
    const doc = await h.snapshot(InboxDoc, c.id as never, agentCtx);
    return (doc?.items ?? []).map((item): InboxItem => {
      if (item.mode === "write") return { id: item.id as number, mode: "write", content: "Context update" };
      const content = item.content as unknown;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((b: { type?: string; text?: string }) => (b.type === "text" ? b.text : "")).join("")
            : undefined;
      return { id: item.id as number, mode: item.mode as InboxItem["mode"], content: text };
    });
  }

  async usage(...args: Args<"usage">): Promise<Awaited<Result<"usage">>> {
    const [h] = args;
    return JSON.parse(JSON.stringify(await h.usage(agentCtx))) as UsageTotals;
  }

  // ------------------------------------------------------------ tasks

  async liveTasks(...args: Args<"liveTasks">): Promise<Awaited<Result<"liveTasks">>> {
    const [h] = args;
    const graph = await h.taskGraph(agentCtx);
    try {
      return await this.labelTasks(
        h,
        Object.values(graph.value.tasks as Record<string, unknown>).map((t) => this.taskNode(t)),
      );
    } finally {
      graph.dispose();
    }
  }

  taskNode(...args: Args<"taskNode">): Result<"taskNode"> {
    const [raw] = args;
    const n = raw as RawTask;
    return {
      id: n.id,
      kind: n.kind,
      ...(n.conversationId === undefined ? {} : { conversationId: n.conversationId }),
      ...(n.owner === undefined ? {} : { owner: n.owner }),
      background: !!n.background,
      ...(n.abortRequested === undefined ? {} : { aborting: n.abortRequested }),
      state: {
        status: n.state.status,
        ...(n.state.phase === undefined ? {} : { phase: n.state.phase }),
        ...(n.state.on === undefined ? {} : { on: [...n.state.on] }),
        ...(n.state.policy === undefined ? {} : { policy: n.state.policy }),
      },
      conversations: [...(n.conversations ?? [])],
    } as Result<"taskNode">;
  }

  /** A task keeps the label pi-durable gives it: this device runs no durable jobs and registers no
   *  extensions of its own, so there is nothing here to resolve one against. */
  async labelTasks(...args: Args<"labelTasks">): Promise<Awaited<Result<"labelTasks">>> {
    return args[1];
  }

  async tasks(...args: Args<"tasks">): Promise<Awaited<Result<"tasks">>> {
    const [h, status, limit] = args;
    const all = await h.commit(async (tx) => {
      let page = await tx.scanTasks({}, 500);
      const items = [...page.items];
      while (page.next) {
        page = await tx.scanTasks({}, 500, page.next);
        items.push(...page.items);
      }
      return items.slice(-2000);
    }, agentCtx);
    const wanted = all.filter((t) => (status === "terminal" ? t.state.status === "terminal" : t.state.status !== "terminal"));
    return wanted
      .slice(-Math.min(Math.max(limit, 1), 200))
      .reverse()
      .map((t) => ({
        id: t.id as number,
        kind: (t as { kind?: string }).kind ?? "task",
        ...((t as { conversationId?: number }).conversationId === undefined
          ? {}
          : { conversationId: (t as { conversationId?: number }).conversationId }),
        state: JSON.parse(JSON.stringify(t.state)),
      })) as Awaited<Result<"tasks">>;
  }

  async abortTask(...args: Args<"abortTask">): Promise<Awaited<Result<"abortTask">>> {
    const [h, taskId] = args;
    const task = await h.getTask(taskId as never, agentCtx);
    if (!task) throw new ApiFault("not_found", `No task ${taskId}`);
    return { status: await h.abortTask(task.id, agentCtx) } as Awaited<Result<"abortTask">>;
  }

  async inspect(...args: Args<"inspect">): Promise<Awaited<Result<"inspect">>> {
    return (await args[0].inspect(agentCtx)) as Awaited<Result<"inspect">>;
  }

  // ------------------------------------------------------------ not here yet
  //
  // Each of these is a method the contract declares and this device cannot honour yet. Typed by the
  // interface they stand in for, so filling one in cannot silently change its shape.

  createAgent(..._args: Args<"createAgent">): Result<"createAgent"> {
    throw unavailable("Creating an agent");
  }
  archive(..._args: Args<"archive">): Result<"archive"> {
    throw unavailable("Archiving a session");
  }
  async send(...args: Args<"send">): Promise<Awaited<Result<"send">>> {
    const [c, input] = args;
    const body = input as { content?: unknown; whenBusy?: unknown; requestId?: unknown };
    if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 100000)
      throw new ApiFault("invalid", "content must be a message under 100,000 characters");
    const whenBusy = (body.whenBusy ?? "followUp") as "steer" | "followUp" | "reject";
    if (!["steer", "followUp", "reject"].includes(whenBusy))
      throw new ApiFault("invalid", "whenBusy must be followUp, steer or reject");
    if (typeof body.requestId !== "string" || !body.requestId || body.requestId.length > 128)
      throw new ApiFault("invalid", "requestId is required (≤128 chars) so retries never submit twice");
    return (await c.submit(
      { type: "input", content: body.content, requestId: body.requestId, whenBusy },
      agentCtx,
    )) as Awaited<Result<"send">>;
  }

  /** Waits for a submission, then hands back the answer text: the same shape the Node store
   *  reports, so a client cannot tell which device it asked. */
  async settled(...args: Args<"settled">): Promise<Awaited<Result<"settled">>> {
    const [h, submissionId, waitMs, signal] = args;
    const submission = await h.submission(submissionId as never, agentCtx);
    if (!submission) throw new ApiFault("not_found", `No submission ${submissionId}`);
    const wait = waitMs ?? 0;
    let record = await submission.status(agentCtx);
    if (wait > 0 && record.status !== "done" && record.status !== "unanswered") {
      const timeout = AbortSignal.timeout(Math.min(wait, 300_000));
      const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
      try {
        record = await submission.wait(withAbortSignal(stop, agentCtx));
      } catch (e) {
        // A client that walked away is not an error: report whatever the record says now.
        if (!stop.aborted) throw e;
      }
    }
    if (record.status === "done" && record.answer !== undefined) {
      const entry = await h.commit((tx) => tx.entry(record.answer as never), agentCtx);
      const text = (entry?.model ?? []).map((m) => messageText(m as never)).join("").trim();
      return {
        submissionId,
        status: "done",
        answer: { entryId: record.answer as number, text },
      } as Awaited<Result<"settled">>;
    }
    if (record.status === "unanswered")
      return { submissionId, status: "unanswered", reason: record.reason } as Awaited<Result<"settled">>;
    return {
      submissionId,
      status: record.status === "queued" ? "queued" : "pending",
    } as Awaited<Result<"settled">>;
  }

  async withdraw(...args: Args<"withdraw">): Promise<Awaited<Result<"withdraw">>> {
    const [h, c, submissionId] = args;
    return { status: await h.abortSubmission(submissionId as never, agentCtx, c.id) } as Awaited<
      Result<"withdraw">
    >;
  }

  async abort(...args: Args<"abort">): Promise<Awaited<Result<"abort">>> {
    const [c, background] = args;
    await c.abort(agentCtx, { background });
    return { ok: true } as Awaited<Result<"abort">>;
  }

  async compact(...args: Args<"compact">): Promise<Awaited<Result<"compact">>> {
    const [c, instructions] = args;
    const note = typeof instructions === "string" && instructions.trim() ? instructions : undefined;
    return { taskId: (await c.compact(note, agentCtx)) as number } as Awaited<Result<"compact">>;
  }

  async reset(...args: Args<"reset">): Promise<Awaited<Result<"reset">>> {
    const [c, note] = args;
    await c.reset(typeof note === "string" && note.trim() ? note : undefined, agentCtx);
    return { ok: true } as Awaited<Result<"reset">>;
  }
  configure(..._args: Args<"configure">): Result<"configure"> {
    throw unavailable("Configuring an agent");
  }
  extensionsOf(..._args: Args<"extensionsOf">): Result<"extensionsOf"> {
    throw unavailable("Extensions");
  }
  setExtension(..._args: Args<"setExtension">): Result<"setExtension"> {
    throw unavailable("Extensions");
  }
  fork(..._args: Args<"fork">): Result<"fork"> {
    throw unavailable("Forking");
  }
  agentDoc(..._args: Args<"agentDoc">): Result<"agentDoc"> {
    throw unavailable("Agent documents");
  }
  deviceDoc(..._args: Args<"deviceDoc">): Result<"deviceDoc"> {
    throw unavailable("Device documents");
  }
  browse(..._args: Args<"browse">): Result<"browse"> {
    throw unavailable("Browsing the filesystem");
  }
  setCompaction(..._args: Args<"setCompaction">): Result<"setCompaction"> {
    throw unavailable("Compaction settings");
  }
  demoState(..._args: Args<"demoState">): Result<"demoState"> {
    throw unavailable("The demo extension");
  }
  startJob(..._args: Args<"startJob">): Result<"startJob"> {
    throw unavailable("Durable job runs");
  }
  approveJob(..._args: Args<"approveJob">): Result<"approveJob"> {
    throw unavailable("Durable job runs");
  }
}
