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

/** The token a request presents, or "" when it presents none. */
export const presentedToken = (request: Request) => {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return (request.headers.get("x-dpi-token") ?? "").trim();
};

/** False for an empty token on either side, so a device with no DPI_TOKEN set stays shut. */
export async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  if (!presented || !expected) return false;
  return equal(await sha256(presented), await sha256(expected));
}

/** The one 401. A host that checks the token before booting its store answers exactly this. */
export const unauthorized = () =>
  new Response(JSON.stringify({ error: { code: "unauthorized", message: "Missing or invalid device token" } }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "WWW-Authenticate": 'Bearer realm="dpi"',
    },
  });

export function bearerAuth(token: string) {
  return createMiddleware(async (c, next) => {
    if (!(await tokenMatches(presentedToken(c.req.raw), token))) return unauthorized();
    await next();
  });
}
