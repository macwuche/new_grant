import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPassword, completeCredentialReset, getAvatar, getMe, getProfile, listSecurityEvents, removeAvatar, reportPasswordChanged, reportSecurityEvent,
  reportSignIn, setAuthTokenGetter, setBaseUrl, setPrivacy, updateProfile, uploadAvatar,
} from "@workspace/api-client-react";
import { adoptServerProfile } from "@workspace/domain/sync";
import { createSeedState, seedGrants, seedTreasury } from "@workspace/domain/seed";
import { createApp } from "./app";
import type { AuthUser, TokenVerifier } from "./lib/auth";
import { memoryActivity } from "./lib/activity";
import { memoryApplicationRepo } from "./lib/applicationRepo";
import { memoryDocumentRepo } from "./lib/documentRepo";
import { memoryOutbox } from "./lib/email";
import { memoryEmailSettingsRepo } from "./lib/emailSettings";
import { memoryFileStore } from "./lib/fileStore";
import { memoryInboxRepo } from "./lib/inbox";
import { memoryMoneyRepo } from "./lib/moneyRepo";
import { memoryProfileRepo } from "./lib/profileRepo";
import { memoryProgramRepo } from "./lib/programRepo";
import { memorySignInRepo } from "./lib/signIns";
import { memoryStaffRepo } from "./lib/staffRepo";
import sharp from "sharp";

// The profile center's wiring: the portal's own generated client (the same
// functions ProfilePage.tsx calls, through the same customFetch) against the
// real API router, so a path, method, body encoding, or response parsing
// mismatch between the two sides fails here. Supabase is faked at the HTTP level.

const USERS: Record<string, AuthUser> = {
  "tok-ada": { id: "77777777-7777-4777-8777-777777777777", email: "ada@example.com", emailConfirmed: true, metadata: { full_name: "Ada Obi", country: "Nigeria", sector: "Agriculture" } },
  "tok-ben": { id: "88888888-8888-4888-8888-888888888888", email: "ben@example.com", emailConfirmed: true, metadata: { full_name: "Ben Hale" } },
};
const verifier: TokenVerifier = async token => USERS[token] ?? null;

let server: Server;
let token: string | null = "tok-ada";
let supabasePassword = "right-password";
const supabaseCalls: string[] = [];
const supabaseFetch = (async (url: string, init: RequestInit = {}) => {
  const path = new URL(url).pathname;
  supabaseCalls.push(`${init.method ?? "GET"} ${path}`);
  if (path === "/auth/v1/token") {
    const { password } = JSON.parse(String(init.body)) as { password: string };
    return password === supabasePassword
      ? Response.json({ access_token: "throwaway", refresh_token: "r" })
      : Response.json({ error_code: "invalid_credentials" }, { status: 400 });
  }
  if (path === "/auth/v1/logout") return new Response(null, { status: 204 });
  return Response.json({ message: "not found" }, { status: 404 });
}) as unknown as typeof fetch;

/** A real 1×1 PNG. */
// A real picture: uploads are rebuilt from their pixels (lib/imageRebuild.ts).
const PNG = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 128, b: 255, alpha: 1 } } }).png().toBuffer();

beforeEach(async () => {
  const outbox = memoryOutbox();
  const activity = memoryActivity({ outbox, recipient: () => undefined });
  const profiles = memoryProfileRepo([], activity);
  const programs = memoryProgramRepo(seedGrants(), activity);
  const money = memoryMoneyRepo(profiles, { treasury: seedTreasury(), lockdown: null }, activity);
  server = createApp({
    verifier, staffRepo: memoryStaffRepo([], activity), programRepo: programs, profileRepo: profiles,
    applicationRepo: memoryApplicationRepo(programs, [], activity, money), activityRepo: activity, moneyRepo: money,
    documentRepo: memoryDocumentRepo(activity), fileStore: memoryFileStore(), emailOutbox: outbox, emailSettings: memoryEmailSettingsRepo(activity),
    inbox: memoryInboxRepo(), signIns: memorySignInRepo(activity), fetchImpl: supabaseFetch,
    supabaseAuth: { url: "https://proj.supabase.co", anonKey: "anon-key" },
  }, []).listen(0);
  await new Promise(r => server.once("listening", r));
  // Exactly how the portal is configured: relative /api/... URLs and a bearer token from the session.
  setBaseUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  token = "tok-ada";
  setAuthTokenGetter(() => token);
  supabasePassword = "right-password";
  supabaseCalls.length = 0;
});
afterEach(async () => {
  setBaseUrl(null); setAuthTokenGetter(null);
  await new Promise(r => server.close(r));
});

/** Status and body of a rejected client call. */
async function failure(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  // The portal's apiError() reads these two fields of the client's ApiError.
  expect(err).toMatchObject({ name: "ApiError", status: expect.any(Number) });
  const e = err as { status: number; data: { error?: string; fieldErrors?: Record<string, string> } | null };
  return { status: e.status, data: e.data };
}

describe("profile center wiring: portal client ↔ API", () => {
  it("loads the profile the page starts from, and the portal adopts it", async () => {
    await getMe();
    const profile = await getProfile();
    expect(profile).toMatchObject({ name: "Ada Obi", email: "ada@example.com", displayName: "", telegram: "", privacy: { activityLogging: true, unusualActivityEmail: true } });
    expect(profile.avatarUpdatedAt ?? null).toBeNull();
    const adopted = adoptServerProfile(createSeedState(), profile);
    expect(adopted.ok && adopted.state.profile).toMatchObject({ name: "Ada Obi", email: "ada@example.com", privacy: { activityLogging: true, unusualActivityEmail: true } });
  });

  it("saves personal details, and returns the shared rule's field errors to the form", async () => {
    const saved = await updateProfile({ name: "Ada Obi", phone: "+234 803 555 0100", address: "", displayName: "Ada", telegram: "@ada_obi", birthDate: "1990-04-02" });
    // Stored without the "@" (the shared rule normalises it); the page adds it back when showing the row.
    expect(saved).toMatchObject({ displayName: "Ada", telegram: "ada_obi", phone: "+234 803 555 0100", birthDate: "1990-04-02" });
    expect(await getProfile()).toMatchObject({ displayName: "Ada", telegram: "ada_obi" });
    const adopted = adoptServerProfile(createSeedState(), saved);
    expect(adopted.ok && adopted.state.profile).toMatchObject({ displayName: "Ada", telegram: "ada_obi", birthDate: "1990-04-02" });

    const bad = await failure(updateProfile({ name: "Ada Obi", phone: "12", address: "", displayName: "Ada", telegram: "@ab", birthDate: "2999-01-01" }));
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.data?.fieldErrors ?? {}).sort()).toEqual(["birthDate", "phone", "telegram"]);
  });

  it("uploads a photo as raw bytes, reads it back as a Blob, and removes it", async () => {
    const file = new File([PNG], "me.png", { type: "image/png" });
    const saved = await uploadAvatar(file);
    expect(saved.avatarUpdatedAt).toEqual(expect.any(String));
    const blob = await getAvatar();
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
    const back = Buffer.from(await blob.arrayBuffer());
    expect(createHash("sha256").update(back).digest("hex")).toBe(createHash("sha256").update(PNG).digest("hex"));
    // Another applicant can't see it.
    token = "tok-ben";
    expect((await failure(getAvatar())).status).toBe(404);
    token = "tok-ada";

    expect((await failure(uploadAvatar(new File(["not an image"], "x.txt", { type: "text/plain" })))).status).toBe(415);
    expect((await failure(uploadAvatar(new File([Buffer.alloc(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" })))).status).toBe(413);

    const removed = await removeAvatar();
    expect(removed.avatarUpdatedAt ?? null).toBeNull();
    expect((await failure(getAvatar())).status).toBe(404);
  });

  it("saves the privacy switches", async () => {
    const saved = await setPrivacy({ activityLogging: false, unusualActivityEmail: false });
    expect(saved.privacy).toEqual({ activityLogging: false, unusualActivityEmail: false });
    expect((await getProfile()).privacy).toEqual({ activityLogging: false, unusualActivityEmail: false });
    const adopted = adoptServerProfile(createSeedState(), saved);
    expect(adopted.ok && adopted.state.profile.privacy).toEqual({ activityLogging: false, unusualActivityEmail: false });
  });

  it("checks the current password with Supabase, and records what the page reports, newest first", async () => {
    await reportSignIn({ deviceId: "0f5c2b8e-1d4a-4c7e-9b3a-6e2f8d1c4a55" });
    expect(await checkPassword({ password: "right-password" })).toMatchObject({ message: "Password confirmed." });
    expect(supabaseCalls).toEqual(["POST /auth/v1/token", "POST /auth/v1/logout"]);
    const wrong = await failure(checkPassword({ password: "nope" }));
    expect(wrong.status).toBe(400);
    expect(wrong.data?.fieldErrors?.["currentPassword"]).toBe("That isn't your current password.");

    await reportPasswordChanged();
    expect(await reportSecurityEvent({ kind: "email_change_requested" })).toEqual({ recorded: true });
    expect(await reportSecurityEvent({ kind: "signed_out_others" })).toEqual({ recorded: true });
    // Two-step "on" is refused while the verified session has no authenticator.
    expect(await reportSecurityEvent({ kind: "two_step_on" })).toEqual({ recorded: false });

    const events = await listSecurityEvents();
    expect(events.map(e => e.kind)).toEqual(["signed_out_others", "email_change_requested", "password_changed", "failed_password_check", "new_device_sign_in"]);
    for (const e of events) expect(e).toMatchObject({ at: expect.any(String), device: expect.any(String) });
    token = "tok-ben";
    expect(await listSecurityEvents()).toEqual([]);
  });

  it("refuses a credential-reset completion nobody asked for with a readable error", async () => {
    const res = await failure(completeCredentialReset({ kind: "password" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.data?.error).toEqual(expect.any(String));
  });

  it("sends the page's calls unauthenticated only as 401s", async () => {
    token = null;
    for (const call of [getProfile, listSecurityEvents, getAvatar, () => setPrivacy({ activityLogging: true, unusualActivityEmail: true })]) {
      expect((await failure(call())).status).toBe(401);
    }
  });
});
