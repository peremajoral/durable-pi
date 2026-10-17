// Replays the stored response for a repeated `Idempotency-Key` on create routes.
import { createMiddleware } from "hono/factory";
import type { Store } from "./store.js";

export function idempotent(store: Store) {
  return createMiddleware(async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (!key) return next();
    if (key.length > 128)
      return c.json({ error: { code: "invalid", message: "Idempotency-Key too long" } }, 400);
    // Same route identity the express version stored: method plus path, no query.
    const route = `${c.req.method} ${c.req.path}`;
    const stored = store.replay(key, route);
    if (stored) return c.json(stored.body, stored.status as 200, { "Idempotent-Replay": "true" });
    await next();
    if (c.res.status >= 400) return;
    const body = await c.res
      .clone()
      .json()
      .catch(() => undefined);
    if (body !== undefined) store.remember(key, route, c.res.status, body);
  });
}
