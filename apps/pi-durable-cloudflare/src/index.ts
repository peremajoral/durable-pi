// Durable Pi DEVICE network: the pi-durable harness inside a Cloudflare Durable Object, speaking the
// same /v1 contract as the Node backend because it mounts the same app rather than a second copy.
//
// Nothing about the contract lives here. createApp() is the one implementation and DoStore is the
// only part a Durable Object has of its own.
import { DurableObject } from "cloudflare:workers";
import type { Hono } from "hono";
import { createApp } from "../../dpi-backend/src/app.ts";
import { presentedToken, tokenMatches, unauthorized } from "../../dpi-backend/src/auth.ts";
import { DoStore } from "./do-store.ts";

interface Env {
  SESSIONS: DurableObjectNamespace<Session>;
  DPI_TOKEN?: string;
  DPI_DEVICE_NAME?: string;
  DPI_MODEL?: string;
}

export class Session extends DurableObject<Env> {
  #app: Hono;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const store = new DoStore(ctx, env);
    this.#app = createApp(store, env.DPI_TOKEN ?? "");
    // The documented idiom for object initialization: every request waits for this, and it runs
    // once. A failure resets the object instead of caching a rejected promise for its lifetime.
    ctx.blockConcurrencyWhile(() => store.ready());
  }

  async fetch(request: Request): Promise<Response> {
    // Checked in the worker before the object is woken, and again here: the object must not depend
    // on its front door for its own safety. Same predicate and same 401 body as createApp installs.
    if (!(await tokenMatches(presentedToken(request), this.env.DPI_TOKEN ?? ""))) return unauthorized();
    return this.#app.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Answered here so a liveness probe never wakes the Durable Object.
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    // And checked here so a request with a bad token never wakes it either.
    if (!(await tokenMatches(presentedToken(request), env.DPI_TOKEN ?? ""))) return unauthorized();
    return env.SESSIONS.get(env.SESSIONS.idFromName("root")).fetch(request);
  },
};
