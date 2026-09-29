import type { Request } from "express";
import type { PrivacyPreferences } from "@workspace/domain/profile";
import type { NewSecurityEvent, SecurityEventKind } from "./activity";
import { deviceLabel } from "./signIns";

// Security activity shown on the applicant's profile: sign-ins, password and
// email changes, failed password checks, two-step changes, and signing out
// other devices. Entries are stored with the change they describe (Effects).
// While the account's "save my activity logs" switch is off, an entry keeps
// only what happened and when: no device, IP address, or location.

/** Where a request came from, as far as this server can tell. */
export type RequestOrigin = { device: string; ip: string | null; location: string | null };

/**
 * City and country from the proxy's visitor-location headers. Only read when
 * GEO_HEADERS=cloudflare (Cloudflare adds cf-ipcountry, and cf-ipcity with the
 * "Add visitor location headers" managed transform); otherwise a client could
 * send the headers itself. Informational only, never used to decide anything.
 */
export function requestLocation(req: { get(name: string): string | undefined }, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env["GEO_HEADERS"] !== "cloudflare") return null;
  const clean = (v: string | undefined) => v?.replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 60) || null;
  const country = clean(req.get("cf-ipcountry"))?.toUpperCase() ?? null;
  const city = clean(req.get("cf-ipcity"));
  // XX: unknown, T1: Tor.
  const knownCountry = country && country !== "XX" && country !== "T1" ? country : null;
  return [city, knownCountry].filter(Boolean).join(", ") || null;
}

export const requestOrigin = (req: Request, env: NodeJS.ProcessEnv = process.env): RequestOrigin =>
  ({ device: deviceLabel(req.get("user-agent")), ip: req.ip ?? null, location: requestLocation(req, env) });

/** One security event, with the origin kept only while activity logging is on. */
export function securityEvent(userId: string, kind: SecurityEventKind, privacy: PrivacyPreferences, origin: RequestOrigin | null, now: Date): NewSecurityEvent {
  const keep = privacy.activityLogging && origin;
  return { userId, kind, device: keep ? origin.device : null, ip: keep ? origin.ip : null, location: keep ? origin.location : null, at: now.toISOString() };
}
