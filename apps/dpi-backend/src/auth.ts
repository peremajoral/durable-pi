// Device token auth. Constant-time compare of `Authorization: Bearer <token>`, or `X-DPI-Token`
// for proxies that strip Authorization. WebCrypto, not node:crypto: the same middleware then runs
// on this Node server and inside a Cloudflare Durable Object.
import { createMiddleware } from "hono/factory";

const encoder = new TextEncoder();
const sha256 = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

/** Length-independent, no early exit: the compare itself must not leak the token. */
const equal = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

export function bearerAuth(token: string) {
  const expected = crypto.subtle.digest("SHA-256", encoder.encode(token));
  return createMiddleware(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ")
      ? header.slice(7).trim()
      : (c.req.header("x-dpi-token") ?? "").trim();
    const ok = presented !== "" && equal(await sha256(presented), new Uint8Array(await expected));
    if (!ok)
      return c.json(
        { error: { code: "unauthorized", message: "Missing or invalid device token" } },
        401,
        { "WWW-Authenticate": 'Bearer realm="dpi"' },
      );
    await next();
  });
}
