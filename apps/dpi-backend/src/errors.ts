// Errors. One shape for every host: { error: { code, message } } with a status per code.
// The mapping is host-independent, so the Cloudflare device answers the same codes as this one.
import { ConversationBusy } from "@earendil-works/pi-durable";
import type { ErrorCode } from "../../dpi-sdk/src/api.js";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  invalid: 400,
  busy: 409,
  conflict: 409,
  ambiguous: 409,
  unavailable: 503,
  internal: 500,
  offline: 503,
};

export class ApiFault extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const invalid = (message: string) => new ApiFault("invalid", message);
export const notFound = (message: string) => new ApiFault("not_found", message);

/** Anything thrown on a request becomes an ApiFault, so no host leaks its own error shape. */
export function toFault(err: unknown, where = ""): ApiFault {
  if (err instanceof ApiFault) return err;
  if (err instanceof ConversationBusy)
    return new ApiFault("busy", "The agent is busy and the input asked to be rejected while busy");
  if (err instanceof SyntaxError) return invalid("Body must be valid JSON");
  const message = err instanceof Error ? err.message : String(err);
  if (/App State changed while you were editing/.test(message)) return new ApiFault("conflict", message);
  if (
    /^(Field|Invalid|Use a JSON Pointer|Increment|The state root|State path|Parent must|Value must|Reserved field|App State must|State is too)/.test(
      message,
    )
  )
    return invalid(message);
  console.error(`[dpi-backend] ${where}:`, err instanceof Error ? err.stack : err);
  return new ApiFault("internal", message || "Internal error");
}

export const faultBody = (fault: ApiFault) => ({ error: { code: fault.code, message: fault.message } });
