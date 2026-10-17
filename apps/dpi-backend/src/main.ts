// dpi-backend: one device of the Durable Agent Network.
// Hono over @hono/node-server, so the router in routes.ts is the same code a Cloudflare Durable
// Object mounts. Nothing in the request path is express-specific.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { networkInterfaces } from "node:os";
import { Server } from "node:http";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { bearerAuth } from "./auth.js";
import { faultBody, toFault } from "./errors.js";
import { v1 } from "./routes.js";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const config = loadConfig();
const store = await Store.open({
  dataDir: config.dataDir,
  startDirs: config.startDirs,
  name: config.name,
  provider: config.provider,
});

const app = new Hono();
app.get("/healthz", (c) => c.json({ ok: true }));

// /v1 behind the device token. A sub-app so the guard is registered before the routes it guards.
const secured = new Hono();
secured.use("*", bearerAuth(config.token));
secured.route("/", v1(store));
app.route("/v1", secured);

app.notFound(() => json({ error: { code: "not_found", message: "Route not found" } }, 404));
app.onError((err, c) => {
  const fault = toFault(err, `${c.req.method} ${c.req.path}`);
  if (c.res.headers.get("content-type")?.startsWith("text/event-stream")) return c.res;
  return json(faultBody(fault), fault.status);
});

// ServerType also covers http2, which these options cannot produce.
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
  console.log(`dpi-backend "${config.name}" (uid ${store.uid}) on http://${config.host}:${config.port}`);
  console.log(`data: ${config.dataDir}  start dirs: ${config.startDirs.join(", ")}  provider: ${config.provider}`);
  if (config.host === "0.0.0.0")
    for (const addresses of Object.values(networkInterfaces()))
      for (const a of addresses ?? [])
        if (a.family === "IPv4" && !a.internal) console.log(`LAN: http://${a.address}:${config.port}`);
});
if (server instanceof Server) server.keepAliveTimeout = 65_000;

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  server.close();
  if (server instanceof Server) server.closeAllConnections();
  await store.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
