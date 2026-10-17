// The whole device HTTP surface, assembled in one place: `/healthz`, the token guard, `/v1` and the
// error shape. Both hosts mount exactly this - the Node server in main.ts, the Cloudflare Durable
// Object in apps/pi-durable-cloudflare - so "the same contract" is a shared function rather than a
// promise two implementations have to keep.
import { Hono } from "hono";
import { bearerAuth } from "./auth.js";
import type { DeviceStore } from "./device-store.js";
import { faultBody, toFault } from "./errors.js";
import { v1 } from "./routes.js";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export function createApp(store: DeviceStore, token: string) {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));

  // /v1 behind the device token. A sub-app so the guard is registered before the routes it guards.
  const secured = new Hono();
  secured.use("*", bearerAuth(token));
  secured.route("/", v1(store));
  app.route("/v1", secured);

  app.notFound(() => json({ error: { code: "not_found", message: "Route not found" } }, 404));
  app.onError((err, c) => {
    const fault = toFault(err, `${c.req.method} ${c.req.path}`);
    // A stream already wrote its own status and headers: an error must not overwrite them mid-flight.
    if (c.res.headers.get("content-type")?.startsWith("text/event-stream")) return c.res;
    return json(faultBody(fault), fault.status);
  });
  return app;
}
