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
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as agentCtx, Harness as HarnessClass, createModels, createRegistry, openDurableObjectSqliteStorage } from "../../dpi-backend/src/harness.ts";
import type { DeviceStore, SessionRow } from "../../dpi-backend/src/device-store.ts";
import { ApiFault } from "../../dpi-backend/src/errors.ts";
import { DEFAULT_COMPACTION, type CompactionSettings, type DeviceInfo, type DeviceTree, type SessionSummary } from "../../dpi-sdk/src/api.ts";

const DEVICE_VERSION = "1.3.0";

/** A capability this device does not have. A formed fault of the contract's own kind, not a crash. */
const unavailable = (what: string) => new ApiFault("unavailable", `${what} is not available on this device`);

/** Signature of one method of the shared contract, taken from the contract itself: a stub cannot
 *  drift from the interface it is standing in for, because it is typed by that interface. */
type Fn<K extends keyof DeviceStore> = DeviceStore[K] extends (...args: any[]) => any ? DeviceStore[K] : never;
type Args<K extends keyof DeviceStore> = Parameters<Fn<K>>;
type Result<K extends keyof DeviceStore> = ReturnType<Fn<K>>;

interface Env {
  DPI_TOKEN?: string;
  DPI_DEVICE_NAME?: string;
  DPI_MODEL?: string;
}

export class DoStore implements DeviceStore {
  /** Sessions whose harness is open. streams.ts reads it to tell a live session from a dead one. */
  readonly opened = new Map<string, any>();
  readonly startedAt = Date.now();

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
        dbPath TEXT NOT NULL UNIQUE,createdAt INTEGER NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL)`,
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

  // ------------------------------------------------------------ device

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
      models: [],
      defaultModel: this.env.DPI_MODEL ?? "",
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
      model: this.env.DPI_MODEL ?? "",
      provider: "faux",
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

  /** Built once and kept as a promise: the DO's fetch awaits ready(), never a route. */
  #open(row: SessionRow): Promise<Harness> {
    this.#harness ??= (async () => {
      const storage = await openDurableObjectSqliteStorage(this.ctx.storage as never);
      const harness = await HarnessClass.open(
        storage,
        {
          models: createModels(),
          registry: createRegistry(),
          settings: { documentRetentionMs: 0 },
        },
        agentCtx,
      );
      const root = await harness.root(agentCtx);
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
    const h = this.harness(row);
    const root = await h.root(agentCtx);
    return {
      id: row.id,
      name: row.name,
      cwd: row.cwd,
      model: `${row.provider}/${row.model}`,
      createdAt: row.createdAt,
      dbPath: row.dbPath,
      busy: false,
      agents: [{ id: root.id as number, name: "main", named: true, kind: "root", busy: false, background: 0 }],
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

  // ------------------------------------------------------------ not here yet
  //
  // Each of these is a method the contract declares and this device cannot honour yet. Typed by the
  // interface they stand in for, so filling one in cannot silently change its shape.

  createAgent(..._args: Args<"createAgent">): Result<"createAgent"> {
    throw unavailable("Listing agents");
  }
  agents(..._args: Args<"agents">): Result<"agents"> {
    throw unavailable("Listing agents");
  }
  archive(..._args: Args<"archive">): Result<"archive"> {
    throw unavailable("Archiving a session");
  }
  agentSummary(..._args: Args<"agentSummary">): Result<"agentSummary"> {
    throw unavailable("Reading an agent");
  }
  agentDetail(..._args: Args<"agentDetail">): Result<"agentDetail"> {
    throw unavailable("Reading an agent");
  }
  setAgentName(..._args: Args<"setAgentName">): Result<"setAgentName"> {
    throw unavailable("Renaming an agent");
  }
  preview(..._args: Args<"preview">): Result<"preview"> {
    throw unavailable("Previewing an agent");
  }
  entries(..._args: Args<"entries">): Result<"entries"> {
    throw unavailable("Reading entries");
  }
  activeEntries(..._args: Args<"activeEntries">): Result<"activeEntries"> {
    throw unavailable("Reading active entries");
  }
  transcript(..._args: Args<"transcript">): Result<"transcript"> {
    throw unavailable("Transcripts");
  }
  send(..._args: Args<"send">): Result<"send"> {
    throw unavailable("Submitting a message");
  }
  settled(..._args: Args<"settled">): Result<"settled"> {
    throw unavailable("Waiting for a submission");
  }
  withdraw(..._args: Args<"withdraw">): Result<"withdraw"> {
    throw unavailable("Withdrawing a submission");
  }
  abort(..._args: Args<"abort">): Result<"abort"> {
    throw unavailable("Aborting");
  }
  inbox(..._args: Args<"inbox">): Result<"inbox"> {
    throw unavailable("Reading the inbox");
  }
  liveTasks(..._args: Args<"liveTasks">): Result<"liveTasks"> {
    throw unavailable("Live tasks");
  }
  tasks(..._args: Args<"tasks">): Result<"tasks"> {
    throw unavailable("Task history");
  }
  taskNode(..._args: Args<"taskNode">): Result<"taskNode"> {
    throw unavailable("Tasks");
  }
  labelTasks(..._args: Args<"labelTasks">): Result<"labelTasks"> {
    throw unavailable("Tasks");
  }
  abortTask(..._args: Args<"abortTask">): Result<"abortTask"> {
    throw unavailable("Aborting a task");
  }
  inspect(..._args: Args<"inspect">): Result<"inspect"> {
    throw unavailable("Inspection");
  }
  usage(..._args: Args<"usage">): Result<"usage"> {
    throw unavailable("Usage totals");
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
  compact(..._args: Args<"compact">): Result<"compact"> {
    throw unavailable("Compaction");
  }
  reset(..._args: Args<"reset">): Result<"reset"> {
    throw unavailable("Resetting a conversation");
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
