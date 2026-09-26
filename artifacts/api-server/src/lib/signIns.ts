import { createHash } from "node:crypto";
import type { Effects } from "./activity";
import { appName, appUrl, renderEmail, type NewEmail } from "./email";

// Sign-in alerts. After a completed sign-in (two-step included) the portal
// reports it with a random id its browser keeps. A device is known once an
// account has signed in from it; only the hash of account id + device id is
// stored. Applicants see every sign-in in the app and get an email for a new
// device; staff get an email for a new device.

export interface SignInRepo {
  /**
   * Records the sign-in and writes the effects `effects(isNewDevice)` builds in
   * the same transaction. Resolves to whether the device was new.
   */
  record(userId: string, deviceHash: string, label: string, now: Date, effects: (isNew: boolean) => Effects): Promise<boolean>;
}

export const deviceHash = (userId: string, deviceId: string) => createHash("sha256").update(`${userId}:${deviceId}`).digest("hex");

/** "Chrome on Windows" from a User-Agent header; good enough to recognise, never used to decide anything. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "an unknown system";
  return `${browser} on ${os}`;
}

const when = (now: Date) => `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const from = (label: string, ip: string | null) => `${label}${ip ? `, IP address ${ip}` : ""}`;

/** The applicant's notification: every sign-in in the app; emailed (always, as a security notice) only for a new device. */
export function applicantSignInNotice(applicantId: string, isNew: boolean, label: string, ip: string | null, now: Date) {
  return isNew
    ? { applicantId, at: now.toISOString(), href: "/settings", title: "New device signed in",
        body: `Your account was signed in from a new device: ${from(label, ip)}, at ${when(now)}. If this wasn't you, reset your password now and contact the grant team.` }
    : { applicantId, at: now.toISOString(), href: "/settings", title: "Signed in", body: `Signed in from ${from(label, ip)}.`, email: false as const };
}

/** A staff member's new-device email. */
export function staffSignInEmail(staff: { email: string; name: string }, label: string, ip: string | null, now: Date): NewEmail {
  const base = appUrl();
  const { text, html } = renderEmail({
    greeting: `Hello ${staff.name},`,
    paragraphs: [
      `Your ${appName()} staff account was signed in from a new device: ${from(label, ip)}, at ${when(now)}.`,
      "If this wasn't you, reset your password from the staff sign-in page now and tell a super admin.",
    ],
    ...(base ? { action: { label: "Go to staff sign-in", href: `${base}/admin/login` } } : {}),
    footer: "You're receiving this because a staff account was used on a device it hadn't been used on before.",
  });
  return { kind: "security", to: staff.email, subject: `New sign-in to your ${appName()} staff account`, text, html };
}

/** In-memory repo for tests. */
export function memorySignInRepo(activity: { write(effects: Effects): void }): SignInRepo {
  const seen = new Set<string>();
  return {
    record: async (userId, hash, _label, _now, effects) => {
      const key = `${userId}:${hash}`;
      const isNew = !seen.has(key);
      seen.add(key);
      activity.write(effects(isNew));
      return isNew;
    },
  };
}
