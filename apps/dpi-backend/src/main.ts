// dpi-backend: one device of the Durable Agent Network.
// Hono over @hono/node-server, so the router in routes.ts is the same code a Cloudflare Durable
// Object mounts. Nothing in the request path is express-specific.
//
// This file is a host, not the app: it opens the Node store, mounts createApp() and serves it.
import { serve } from "@hono/node-server";
import { networkInterfaces } from "node:os";
import { Server } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";

const config = loadConfig();
const store = await Store.open({
  dataDir: config.dataDir,
  startDirs: config.startDirs,
  name: config.name,
  provider: config.provider,
});

const app = createApp(store, config.token);

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
