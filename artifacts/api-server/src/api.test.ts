import { createHmac } from "node:crypto";
import { memorySignInRepo } from "./lib/signIns";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { ApiDeps } from "./routes";
import type { AuthUser, TokenVerifier } from "./lib/auth";
import { seedGrants } from "@workspace/domain/seed";
import { memoryProfileRepo, type ProfileRepo } from "./lib/profileRepo";
import { ensureSeedPrograms, memoryProgramRepo, type ProgramRepo } from "./lib/programRepo";
import { memoryApplicationRepo, type ApplicationRepo } from "./lib/applicationRepo";
import { memoryActivity } from "./lib/activity";
import { memoryDocumentRepo, type DocumentRepo } from "./lib/documentRepo";
import { memoryFileStore } from "./lib/fileStore";
import { appUrl, deliverBatch, memoryOutbox, resendMailer, RETRY_MINUTES, staffInviteEmail, unconfiguredMailer } from "./lib/email";
import { hookEmails } from "./lib/authEmails";
import { memoryEmailSettingsRepo } from "./lib/emailSettings";
import { memoryInboxRepo } from "./lib/inbox";
import { memoryMoneyRepo } from "./lib/moneyRepo";
import { seedTreasury } from "@workspace/domain/seed";
import { ensureInitialSuperAdmin, memoryStaffRepo, type StaffRecord, type StaffRepo } from "./lib/staffRepo";

// Tokens in these tests are fake: the stub verifier maps them to users.
// Staff sign in with two-step (aal2 and a verified authenticator), as the API requires.
const TWO_STEP = { aal: "aal2" as const, factors: [{ id: "factor-1", createdAt: "2025-01-01T00:00:00.000Z" }] };
const USERS: Record<string, AuthUser> = {
  "tok-super": { id: "11111111-1111-4111-8111-111111111111", email: "sam@example.org", emailConfirmed: true, ...TWO_STEP },
  "tok-finance": { id: "22222222-2222-4222-8222-222222222222", email: "jordan@example.org", emailConfirmed: true, ...TWO_STEP },
  "tok-applicant": { id: "33333333-3333-4333-8333-333333333333", email: "alex@example.com", emailConfirmed: true },
  "tok-unconfirmed": { id: "44444444-4444-4444-8444-444444444444", email: "riley@example.org", emailConfirmed: false },
  "tok-riley": { id: "55555555-5555-4555-8555-555555555555", email: "riley@example.org", emailConfirmed: true, ...TWO_STEP },
  // Maya's account in other sessions: from the reset-password email, and with two-step sign-in.
  "tok-maya-recovery": { id: "66666666-6666-4666-8666-666666666666", email: "maya@example.com", emailConfirmed: true, amr: [{ method: "recovery", timestamp: Date.parse("2030-01-01T00:00:00Z") / 1000 }], updatedAt: "2030-01-01T00:05:00Z" },
  "tok-maya-new-factor": { id: "66666666-6666-4666-8666-666666666666", email: "maya@example.com", emailConfirmed: true, aal: "aal2", factors: [{ id: "factor-new", createdAt: "2030-01-01T00:00:00.000Z" }] },
  "tok-maya-old-factor": { id: "66666666-6666-4666-8666-666666666666", email: "maya@example.com", emailConfirmed: true, aal: "aal2", factors: [{ id: "factor-old", createdAt: "2025-01-01T00:00:00.000Z" }] },
  "tok-maya-code-needed": { id: "66666666-6666-4666-8666-666666666666", email: "maya@example.com", emailConfirmed: true, aal: "aal1", factors: [{ id: "factor-old", createdAt: "2025-01-01T00:00:00.000Z" }] },
  "tok-super-password-only": { id: "11111111-1111-4111-8111-111111111111", email: "sam@example.org", emailConfirmed: true },
  "tok-finance-code-needed": { id: "22222222-2222-4222-8222-222222222222", email: "jordan@example.org", emailConfirmed: true, aal: "aal1", factors: [{ id: "factor-1", createdAt: "2025-01-01T00:00:00.000Z" }] },
  "tok-maya": {
    id: "66666666-6666-4666-8666-666666666666", email: "maya@example.com", emailConfirmed: true,
    metadata: { full_name: "  Maya Okafor ", phone: "+44 20 7946 0000", country: "United Kingdom", sector: "Creative industries", birth_date: "1990-04-02", role: "super" },
  },
};
const verifier: TokenVerifier = async token => USERS[token] ?? null;

const SEED: StaffRecord[] = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", email: "sam@example.org", name: "Sam Rivera", role: "super", active: true, authUserId: USERS["tok-super"]!.id },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", email: "jordan@example.org", name: "Jordan Lee", role: "finance", active: true, authUserId: USERS["tok-finance"]!.id },
  { id: "aaaaaaaa-0000-4000-8000-000000000003", email: "riley@example.org", name: "Riley Chen", role: "compliance", active: true, authUserId: null },
];

let server: Server;
let base: string;
let repo: StaffRepo;
let programs: ProgramRepo;
let profiles: ProfileRepo;
let applications: ApplicationRepo;
let activity: ReturnType<typeof memoryActivity>;
let money: ReturnType<typeof memoryMoneyRepo>;
let documents: DocumentRepo;
let files: ReturnType<typeof memoryFileStore>;
let outbox: ReturnType<typeof memoryOutbox>;
let emailSettings: ReturnType<typeof memoryEmailSettingsRepo>;
let inbox: ReturnType<typeof memoryInboxRepo>;
/** Fake Resend and Supabase: tests set `providerReplies` (by "METHOD path") and read `providerCalls`. */
let providerCalls: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
let providerReplies: Record<string, { status: number; body: unknown }> = {};
const providerFetch = (async (url: string, init: RequestInit = {}) => {
  const method = init.method ?? "GET";
  providerCalls.push({ method, url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null });
  const path = new URL(url).pathname;
  const reply = providerReplies[`${method} ${path}`] ?? { status: 404, body: { message: "not found" } };
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

async function start(v: TokenVerifier | null = verifier, limits: ApiDeps["limits"] = {}) {
  outbox = memoryOutbox();
  const people: { peek(id: string): { email: string; name: string; emailNotifications: boolean } | undefined } = { peek: () => undefined };
  activity = memoryActivity({ outbox, recipient: id => people.peek(id) });
  repo = memoryStaffRepo(SEED, activity);
  programs = memoryProgramRepo(seedGrants(), activity);
  const profileRepo = memoryProfileRepo([], activity);
  people.peek = profileRepo.peek;
  profiles = profileRepo;
  money = memoryMoneyRepo(profiles, { treasury: seedTreasury(), lockdown: null }, activity);
  applications = memoryApplicationRepo(programs, [], activity, money);
  documents = memoryDocumentRepo(activity);
  emailSettings = memoryEmailSettingsRepo(activity);
  inbox = memoryInboxRepo();
  providerCalls = []; providerReplies = {};
  files = memoryFileStore();
  server = createApp({ verifier: v, staffRepo: repo, programRepo: programs, profileRepo: profiles, applicationRepo: applications, activityRepo: activity, moneyRepo: money, documentRepo: documents, fileStore: files, emailOutbox: outbox, emailSettings, inbox, signIns: memorySignInRepo(activity), fetchImpl: providerFetch, limits, supabaseAuth: { url: "https://proj.supabase.co", anonKey: "anon-key" } }, ["https://app.example.org"]).listen(0);
  await new Promise(r => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}
const call = (path: string, token?: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
  ...init, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on JSON bodies
const json = async (res: globalThis.Response): Promise<any> => res.json();
const patch = (id: string, body: unknown, token = "tok-super") => call(`/staff/${id}`, token, { method: "PATCH", body: JSON.stringify(body) });

beforeEach(() => start());
afterEach(() => new Promise(r => server.close(r)));

describe("authentication", () => {
  it("keeps the health check public", async () => {
    expect((await call("/healthz")).status).toBe(200);
  });

  it("rejects missing, malformed, and unknown tokens with 401", async () => {
    expect((await call("/me")).status).toBe(401);
    expect((await call("/me", undefined, { headers: { authorization: "Basic abc" } })).status).toBe(401);
    expect((await call("/me", "tok-forged")).status).toBe(401);
  });

  it("answers 503 when sign-in isn't configured", async () => {
    await new Promise(r => server.close(r));
    await start(null);
    expect((await call("/me", "tok-super")).status).toBe(503);
  });

  it("treats a failing verifier as an invalid session", async () => {
    await new Promise(r => server.close(r));
    await start(async () => { throw new Error("network down"); });
    expect((await call("/me", "tok-super")).status).toBe(401);
  });
});

describe("GET /me", () => {
  it("returns applicants with no staff record and no permissions", async () => {
    const body = await json(await call("/me", "tok-applicant"));
    expect(body).toEqual({ user: USERS["tok-applicant"], staff: null, permissions: [], twoStep: { level: "aal1", enrolled: false, requiredForStaff: true } });
  });

  it("returns staff with their role's permissions", async () => {
    const body = await json(await call("/me", "tok-finance"));
    expect(body.staff).toMatchObject({ name: "Jordan Lee", role: "finance", linked: true });
    expect(body.permissions).toEqual(["payments.process", "treasury.manage", "notes.add"]);
  });

  it("links a pending staff record only after the email is confirmed", async () => {
    expect((await json(await call("/me", "tok-unconfirmed"))).staff).toBeNull();
    expect((await repo.findByEmail("riley@example.org"))!.authUserId).toBeNull();
    const body = await json(await call("/me", "tok-riley"));
    expect(body.staff).toMatchObject({ role: "compliance", linked: true });
    expect((await repo.findByEmail("riley@example.org"))!.authUserId).toBe(USERS["tok-riley"]!.id);
  });

  it("gives disabled staff no permissions", async () => {
    await repo.update(SEED[1]!.id, { active: false });
    expect((await json(await call("/me", "tok-finance"))).permissions).toEqual([]);
  });
});

describe("staff management", () => {
  it("is limited to roles with staff.manage", async () => {
    expect((await call("/staff", "tok-applicant")).status).toBe(403);
    expect((await call("/staff", "tok-finance")).status).toBe(403);
    const list = await json(await call("/staff", "tok-super"));
    expect(list.map((m: { name: string }) => m.name)).toEqual(["Sam Rivera", "Jordan Lee", "Riley Chen"]);
  });

  it("blocks disabled super admins", async () => {
    await repo.create({ email: "second@example.org", name: "Second Super", role: "super" });
    await repo.update(SEED[0]!.id, { active: false });
    expect((await call("/staff", "tok-super")).status).toBe(403);
  });

  it("adds staff, rejecting duplicates and bad input", async () => {
    const created = await call("/staff", "tok-super", { method: "POST", body: JSON.stringify({ email: "Avery@Example.org", name: "Avery Taylor", role: "reviewer" }) });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({ email: "avery@example.org", role: "reviewer", active: true, linked: false });
    expect((await call("/staff", "tok-super", { method: "POST", body: JSON.stringify({ email: "avery@example.org", name: "Dup", role: "reviewer" }) })).status).toBe(409);
    expect((await call("/staff", "tok-super", { method: "POST", body: JSON.stringify({ email: "nope", name: "X", role: "boss" }) })).status).toBe(400);
    expect((await call("/staff", "tok-super", { method: "POST", body: JSON.stringify({ email: "a@b.co", name: "Extra Field", role: "support", admin: true }) })).status).toBe(400);
  });

  it("changes roles and access with the shared rules", async () => {
    const res = await patch(SEED[2]!.id, { role: "reviewer" });
    expect(res.status).toBe(200);
    expect((await json(res)).role).toBe("reviewer");
    expect((await patch(SEED[1]!.id, { active: false })).status).toBe(200);
  });

  it("refuses to remove the last super admin or disable yourself", async () => {
    const demote = await patch(SEED[0]!.id, { role: "finance" });
    expect(demote.status).toBe(400);
    expect((await json(demote)).error).toMatch(/super admin must remain/);
    expect((await patch(SEED[0]!.id, { active: false })).status).toBe(400);
  });

  it("validates the id and body, and ignores client-supplied roles for the caller", async () => {
    expect((await patch("not-a-uuid", { role: "super" })).status).toBe(404);
    expect((await patch("aaaaaaaa-0000-4000-8000-000000000099", { role: "super" })).status).toBe(404);
    expect((await patch(SEED[2]!.id, {})).status).toBe(400);
    expect((await patch(SEED[2]!.id, { role: "owner" })).status).toBe(400);
    expect((await call("/staff", "tok-finance", { headers: { "x-role": "super" } })).status).toBe(403);
  });
});

describe("CORS", () => {
  it("allows listed and same-host origins only", async () => {
    const allowed = await call("/healthz", undefined, { headers: { origin: "https://app.example.org" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example.org");
    const other = await call("/healthz", undefined, { headers: { origin: "https://evil.example.com" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("initial super admin", () => {
  it("is created only when no staff exist", async () => {
    const empty = memoryStaffRepo();
    expect(await ensureInitialSuperAdmin(empty, "Owner@Example.org", "Owner")).toMatchObject({ email: "owner@example.org", role: "super" });
    expect(await ensureInitialSuperAdmin(empty, "other@example.org", "Other")).toBeNull();
  });
});

// A valid new program; the deadline is always about three months out.
const newProgram = (overrides: Record<string, unknown> = {}) => ({
  name: "Rural Makers", summary: "Tools and training for rural workshops.", focus: "Rural makers",
  maxFunding: 5000, minimumRequest: 500, budget: 50000, deadline: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
  minimumTier: 1, requirements: ["Workshop photos"], requiresRegistration: false, questions: [], approvalDays: 7, commissionRate: 0, ...overrides,
});
const post = (path: string, body: unknown, token = "tok-super") => call(path, token, { method: "POST", body: JSON.stringify(body) });
const put = (path: string, body: unknown, token = "tok-super") => call(path, token, { method: "PUT", body: JSON.stringify(body) });

// Documents: identity checks need an uploaded document, and submissions need a file for every requirement.
const PDF = Buffer.from("%PDF-1.7\n% test document\n");
const upload = (token: string, query: string, bytes: Buffer = PDF, name = "scan.pdf") => fetch(`${base}/documents?${query}`, {
  method: "POST", body: new Uint8Array(bytes), headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
});
/** Uploads an identity document, then submits the identity details. */
const identityCheck = async (body: unknown, token = "tok-super") => { await upload(token, "purpose=identity"); return post("/profile/identity", body, token); };
/** Submits an application the way the portal does: saved as a draft first, with a file uploaded for each program requirement. */
async function submitApp(body: { grantId: string; draftId?: string; application: unknown }, token = "tok-super") {
  let draftId = body.draftId;
  if (!draftId) {
    const saved = await post("/applications/save", { grantId: body.grantId, application: body.application }, token);
    if (saved.status !== 200) return saved;
    draftId = ((await saved.json()) as { application: { id: string } }).application.id;
  }
  const programsList = (await (await call("/programs", token)).json()) as { id: string; requirements: string[] }[];
  const have = (await (await call("/documents/mine", token)).json()) as { applicationId: string; requirement: string }[];
  for (const r of programsList.find(p => p.id === body.grantId)?.requirements ?? []) {
    if (!have.some(d => d.applicationId === draftId && d.requirement === r)) await upload(token, `purpose=application&applicationId=${draftId}&requirement=${encodeURIComponent(r)}`);
  }
  return post("/applications/submit", { ...body, draftId }, token);
}
const program = async (id: string, token = "tok-super") => (await json(await call("/programs", token))).find((g: { id: string }) => g.id === id);

describe("grant programs", () => {
  it("hides drafts from applicants but shows them to staff", async () => {
    const applicant = (await json(await call("/programs", "tok-applicant"))).map((g: { id: string }) => g.id);
    const staff = (await json(await call("/programs", "tok-finance"))).map((g: { id: string }) => g.id);
    expect(applicant).not.toContain("space");
    expect(staff).toContain("space");
    expect(staff).toHaveLength(5);
  });

  it("lets only programs.manage change programs", async () => {
    expect((await post("/programs", newProgram(), "tok-applicant")).status).toBe(403);
    expect((await post("/programs", newProgram(), "tok-finance")).status).toBe(403);
    const version = (await program("momentum")).updatedAt;
    expect((await post("/programs/momentum/close", { version }, "tok-finance")).status).toBe(403);
    expect((await program("momentum")).status).toBe("Open");
  });

  it("creates a draft with a server id and records who created it", async () => {
    const res = await post("/programs", newProgram());
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.program).toMatchObject({ id: "PRG-3001", status: "Draft", name: "Rural Makers" });
    expect(body.program.changeLog).toEqual([expect.objectContaining({ by: "Sam Rivera", summary: "Created as draft." })]);
    expect(await program("PRG-3001", "tok-applicant")).toBeUndefined();
  });

  it("runs the shared validation rules and reports field errors", async () => {
    const res = await post("/programs", newProgram({ name: "x", minimumRequest: 9000 }));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.fieldErrors).toMatchObject({ name: expect.any(String), maxFunding: expect.any(String) });
    const duplicate = await json(await post("/programs", newProgram({ name: "business momentum" })));
    expect(duplicate.fieldErrors.name).toMatch(/already uses this name/);
  });

  it("rejects edits made against an outdated version", async () => {
    const before = await program("creative");
    const edited = { ...newProgram(), name: before.name, summary: "A clearer summary for makers and studios." };
    const ok = await put("/programs/creative", { version: before.updatedAt, program: edited });
    expect(ok.status).toBe(200);
    const saved = (await json(ok)).program;
    expect(saved.updatedAt).not.toBe(before.updatedAt);
    expect(saved.changeLog.at(-1).summary).toMatch(/^Edited /);
    const again = await put("/programs/creative", { version: before.updatedAt, program: { ...edited, summary: "Another summary entirely." } });
    expect(again.status).toBe(409);
    expect((await program("creative")).summary).toBe("A clearer summary for makers and studios.");
  });

  it("stores only if the version is unchanged, even when two writes race", async () => {
    const grant = await program("green");
    const first = await programs.update({ ...grant, summary: "First writer wins the race.", updatedAt: new Date(Date.now() + 1000).toISOString() }, grant.updatedAt);
    const second = await programs.update({ ...grant, summary: "Second writer loses the race." }, grant.updatedAt);
    expect([first, second]).toEqual(["ok", "stale"]);
  });

  it("publishes, closes, and reopens, following the status rules", async () => {
    let version = (await program("space")).updatedAt;
    let res = await post("/programs/space/publish", { version });
    expect(res.status).toBe(200);
    expect((await json(res)).program.status).toBe("Open");
    version = (await program("space")).updatedAt;
    expect((await post("/programs/space/publish", { version })).status).toBe(400);
    res = await post("/programs/space/close", { version });
    expect((await json(res)).program.status).toBe("Closed");
    version = (await program("space")).updatedAt;
    res = await post("/programs/space/publish", { version });
    expect((await json(res)).message).toMatch(/active again/);
  });

  it("deletes unused drafts only", async () => {
    const open = await program("momentum");
    expect((await post("/programs/momentum/delete", { version: open.updatedAt })).status).toBe(400);
    const draft = await program("space");
    const res = await post("/programs/space/delete", { version: draft.updatedAt });
    expect(res.status).toBe(200);
    expect(await program("space")).toBeUndefined();
  });

  it("answers 404 for unknown programs and 400 for missing versions", async () => {
    expect((await post("/programs/nope/close", { version: "2026-01-01T00:00:00.000Z" })).status).toBe(404);
    expect((await post("/programs/momentum/close", {})).status).toBe(400);
    expect((await post("/programs/bad%20id/close", { version: "x" })).status).toBe(404);
  });

  it("seeds the sample catalog only into an empty table", async () => {
    const empty = memoryProgramRepo();
    expect(await ensureSeedPrograms(empty, seedGrants())).toBe(5);
    expect(await ensureSeedPrograms(empty, seedGrants())).toBe(0);
    expect(await empty.list()).toHaveLength(5);
  });
});

describe("applicant profile", () => {
  it("is created on first use from the sign-up details, ignoring anything else in them", async () => {
    const res = await call("/profile", "tok-maya");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ name: "Maya Okafor", email: "maya@example.com", phone: "+44 20 7946 0000", country: "United Kingdom", tier: 1, identityVerified: false, address: "" });
    expect(body).not.toHaveProperty("role");
    expect((await json(await call("/me", "tok-maya"))).staff).toBeNull();
  });

  it("falls back to the email's name when there are no sign-up details", async () => {
    expect((await json(await call("/profile", "tok-applicant"))).name).toBe("alex");
  });

  it("saves valid edits, never the email, and reports invalid fields", async () => {
    const bad = await call("/profile", "tok-maya", { method: "PATCH", body: JSON.stringify({ name: "M", phone: "12", address: "x" }) });
    expect(bad.status).toBe(400);
    // The address is optional since the profile center (29 Sep 2026), but a given one must be complete.
    expect(Object.keys((await json(bad)).fieldErrors).sort()).toEqual(["address", "name", "phone"]);
    const ok = await call("/profile", "tok-maya", { method: "PATCH", body: JSON.stringify({ name: "Maya O.", phone: "+44 20 7946 0001", address: "1 High Street, Leeds", email: "evil@example.com" }) });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ name: "Maya O.", address: "1 High Street, Leeds", email: "maya@example.com" });
  });

  it("keeps each person's profile separate", async () => {
    await call("/profile", "tok-maya", { method: "PATCH", body: JSON.stringify({ name: "Maya O.", phone: "+44 20 7946 0001", address: "1 High Street, Leeds" }) });
    const alex = await json(await call("/profile", "tok-applicant"));
    expect(alex).toMatchObject({ name: "alex", email: "alex@example.com", address: "" });
  });

  it("requires a sign-in", async () => {
    expect((await call("/profile")).status).toBe(401);
  });
});

describe("account controls and identity checks", () => {
  const MAYA = USERS["tok-maya"]!.id;
  const act = (path: string, body: unknown = {}, token = "tok-super") => post(`/applicants/${MAYA}/${path}`, body, token);
  const maya = async (token = "tok-maya") => json(await call("/profile", token));
  const identity = { documentType: "Passport", documentNumber: "AB 1234-5678", nameOnDocument: "Maya Okafor" };
  beforeEach(async () => { await call("/profile", "tok-maya"); });

  it("starts every applicant active, unverified, and at Tier 1", async () => {
    expect((await maya()).account).toEqual({ status: "Active", passwordResetRequired: false, twoFactorResetRequired: false, kyc: { status: "Not submitted" },
      permissions: { depositKyc: false, emailNotifications: true, cardApplications: true, grantApplications: true, clearBalanceForPayouts: false } });
  });

  it("keeps only the last four characters of the document number", async () => {
    const res = await identityCheck(identity, "tok-maya");
    expect(res.status).toBe(200);
    const { account } = await json(res);
    expect(account.kyc).toMatchObject({ status: "Pending", documentType: "Passport", documentLast4: "5678", nameOnDocument: "Maya Okafor" });
    expect(JSON.stringify(account)).not.toContain("1234");
    expect((await identityCheck(identity, "tok-maya")).status).toBe(400);
  });

  it("lets only kyc.review approve, and marks the applicant verified", async () => {
    await identityCheck(identity, "tok-maya");
    expect((await act("identity/approve", {}, "tok-finance")).status).toBe(403);
    expect((await act("identity/approve", {}, "tok-applicant")).status).toBe(403);
    const res = await act("identity/approve");
    expect(res.status).toBe(200);
    expect((await json(res)).applicant.profile).toMatchObject({ identityVerified: true, account: { kyc: { status: "Verified", reviewedBy: "Sam Rivera" } } });
    expect((await maya()).identityVerified).toBe(true);
  });

  it("needs a reason to reject, and lets the applicant resubmit", async () => {
    await identityCheck(identity, "tok-maya");
    const short = await act("identity/reject", { reason: "No." });
    expect(short.status).toBe(400);
    expect((await json(short)).fieldErrors.reason).toBeDefined();
    expect((await act("identity/reject", { reason: "The name doesn't match the document." })).status).toBe(200);
    expect((await maya()).account.kyc).toMatchObject({ status: "Rejected", rejectionReason: "The name doesn't match the document." });
    expect((await identityCheck(identity, "tok-maya")).status).toBe(200);
  });

  it("asks a verified applicant to verify again", async () => {
    await identityCheck(identity, "tok-maya");
    await act("identity/approve");
    expect((await act("identity/reverify", { reason: "The passport on file has expired." })).status).toBe(200);
    expect(await maya()).toMatchObject({ identityVerified: false, account: { kyc: { status: "Not submitted" } } });
  });

  it("changes tiers with a reason, only with accounts.tier", async () => {
    expect((await act("tier", { tier: 2, reason: "Trading history confirmed." }, "tok-finance")).status).toBe(403);
    expect((await act("tier", { tier: 2, reason: "" })).status).toBe(400);
    expect((await act("tier", { tier: 4, reason: "Trading history confirmed." })).status).toBe(400);
    expect((await act("tier", { tier: 2, reason: "Trading history confirmed." })).status).toBe(200);
    expect((await maya()).tier).toBe(2);
  });

  it("locks and unlocks, recording who locked it", async () => {
    expect((await act("lock", { reason: "Suspicious deposit pattern." })).status).toBe(200);
    expect((await maya()).account).toMatchObject({ status: "Locked", lockReason: "Suspicious deposit pattern.", lockedBy: "Sam Rivera" });
    expect((await act("lock", { reason: "Suspicious deposit pattern." })).status).toBe(400);
    expect((await act("unlock")).status).toBe(200);
    const after = (await maya()).account;
    expect(after.status).toBe("Active");
    expect(after).not.toHaveProperty("lockReason");
  });

  it("enforces a required password reset until the applicant proves it with the reset email", async () => {
    expect((await act("credential-reset", { kind: "password" })).status).toBe(200);
    expect((await maya()).account.passwordResetRequired).toBe(true);
    const blocked = await call("/applications/mine", "tok-maya");
    expect(blocked.status).toBe(403);
    expect((await json(blocked)).code).toBe("password_reset_required");
    expect((await call("/notifications", "tok-maya")).status).toBe(200);
    const unproven = await post("/profile/credential-reset", { kind: "password" }, "tok-maya");
    expect(unproven.status).toBe(400);
    expect((await json(unproven)).error).toMatch(/Forgot password/);
    expect((await post("/profile/credential-reset", { kind: "password" }, "tok-maya-recovery")).status).toBe(200);
    expect((await maya()).account.passwordResetRequired).toBe(false);
    expect((await call("/applications/mine", "tok-maya")).status).toBe(200);
    expect((await post("/profile/credential-reset", { kind: "password" }, "tok-maya")).status).toBe(400);
  });

  it("enforces a required two-step reset until a new authenticator is set up", async () => {
    expect((await act("credential-reset", { kind: "twoFactor" })).status).toBe(200);
    expect((await json(await call("/money/mine", "tok-maya"))).code).toBe("two_factor_reset_required");
    expect((await post("/profile/credential-reset", { kind: "twoFactor" }, "tok-maya")).status).toBe(400);
    expect((await post("/profile/credential-reset", { kind: "twoFactor" }, "tok-maya-old-factor")).status).toBe(400);
    expect((await post("/profile/credential-reset", { kind: "twoFactor" }, "tok-maya-new-factor")).status).toBe(200);
    expect((await maya("tok-maya-new-factor")).account.twoFactorResetRequired).toBe(false);
  });

  it("shows the directory to active staff only", async () => {
    expect((await call("/applicants", "tok-applicant")).status).toBe(403);
    const res = await call("/applicants", "tok-finance");
    expect(res.status).toBe(200);
    expect((await json(res)).map((a: { id: string }) => a.id)).toContain(MAYA);
  });

  it("refuses staff actions on their own applicant account", async () => {
    await call("/profile", "tok-super");
    const res = await post(`/applicants/${USERS["tok-super"]!.id}/tier`, { tier: 3, reason: "Promoting myself for testing." });
    expect(res.status).toBe(403);
  });

  it("answers 404 for unknown applicants", async () => {
    expect((await post("/applicants/00000000-0000-4000-8000-000000000999/unlock", {})).status).toBe(404);
    expect((await post("/applicants/not-a-uuid/unlock", {})).status).toBe(404);
  });

  it("lets compliance switch account permissions, enforced on the applicant and shown to them", async () => {
    expect((await act("permissions", { key: "depositKyc", value: true }, "tok-finance")).status).toBe(403);
    expect((await act("permissions", { key: "somethingElse", value: true }, "tok-riley")).status).toBe(400);
    // Retired 3 Oct 2026: payouts always need a verified identity, so there's no switch.
    expect((await act("permissions", { key: "payoutKyc", value: false }, "tok-riley")).status).toBe(400);
    const changed = await json(await act("permissions", { key: "depositKyc", value: true }, "tok-riley"));
    expect(changed.applicant.profile.account.permissions).toMatchObject({ depositKyc: true });
    expect(changed.applicant.profile.account.permissions).not.toHaveProperty("payoutKyc");
    expect((await act("permissions", { key: "depositKyc", value: true }, "tok-riley")).status).toBe(400);
    expect((await json(await post("/money/deposits", { amount: 50, method: "bank" }, "tok-maya"))).error).toMatch(/Verify your identity/);
    expect((await json(await call("/notifications", "tok-maya")))[0]).toMatchObject({ title: "Account settings changed" });
    // Email copies are the same setting the applicant controls in Settings.
    await act("permissions", { key: "emailNotifications", value: false }, "tok-riley");
    expect((await json(await call("/profile/email-preference", "tok-maya"))).enabled).toBe(false);
    await put("/profile/email-preference", { enabled: true }, "tok-maya");
    expect((await maya()).account.permissions.emailNotifications).toBe(true);
    const entry = (await json(await call("/audit", "tok-super"))).events.find((e: { summary: string }) => e.summary.startsWith("Identity check for deposits"));
    expect(entry.changes).toEqual(expect.arrayContaining([{ field: "permissions.depositKyc", before: "false", after: "true" }]));
  });

  it("stores account changes only if the record is unchanged", async () => {
    const record = (await profiles.get(MAYA))!;
    const first = await profiles.saveAccount(MAYA, { tier: 2 }, record.updatedAt);
    const second = await profiles.saveAccount(MAYA, { tier: 3 }, record.updatedAt);
    expect(first).not.toBe("stale");
    expect(second).toBe("stale");
  });
});

describe("applications and review", () => {
  const MAYA = USERS["tok-maya"]!.id;
  const ALEX = USERS["tok-applicant"]!.id;
  const creative = { businessName: "Okafor Studio", requestedAmount: 4000, registrationNumber: "", purpose: "A kiln and a year of glaze materials for the studio.", checklist: ["Portfolio link", "Project budget", "Professional reference"], answers: {} };
  const verify = async (token: string, id: string) => {
    await call("/profile", token);
    await identityCheck({ documentType: "Passport", documentNumber: "AB12345678", nameOnDocument: "Test Person" }, token);
    await post(`/applicants/${id}/identity/approve`, {});
  };
  const submit = (body: { grantId: string; draftId?: string; application: unknown }, token = "tok-maya") => submitApp(body, token);
  const mine = async (token = "tok-maya") => json(await call("/applications/mine", token));
  const queued = async (id: string) => (await json(await call("/applications", "tok-super"))).find((a: { id: string }) => a.id === id);
  const decide = (id: string, path: string, body: Record<string, unknown>, token = "tok-super") => post(`/applications/${id}/${path}`, body, token);

  it("lets an unverified applicant apply (identity is only needed for payouts)", async () => {
    await call("/profile", "tok-maya");
    const res = await post("/applications/save", { grantId: "creative", application: creative }, "tok-maya");
    expect(res.status).toBe(200);
    expect((await json(res)).application).toMatchObject({ status: "Draft" });
  });

  it("hides inactive plans from applicants, except from those with an application on them", async () => {
    await call("/profile", "tok-maya");
    expect((await post("/applications/save", { grantId: "creative", application: creative }, "tok-maya")).status).toBe(200);
    const ids = async (token: string) => (await json(await call("/programs", token))).map((g: { id: string }) => g.id);
    expect(await ids("tok-applicant")).toContain("creative");
    expect((await post("/programs/creative/close", { version: (await program("creative")).updatedAt })).status).toBe(200);
    expect(await ids("tok-applicant")).not.toContain("creative");
    expect(await ids("tok-maya")).toContain("creative");
    expect(await ids("tok-super")).toContain("creative");
  });

  it("keeps drafts private to the applicant, and submits with validation", async () => {
    await verify("tok-maya", MAYA);
    const draft = await json(await post("/applications/save", { grantId: "creative", application: { ...creative, purpose: "short" } }, "tok-maya"));
    expect(draft.application).toMatchObject({ id: "APP-5001", status: "Draft", applicantId: MAYA });
    expect(await queued("APP-5001")).toBeUndefined();
    const incomplete = await submit({ grantId: "creative", draftId: "APP-5001", application: { ...creative, purpose: "short" } });
    expect(incomplete.status).toBe(400);
    expect((await json(incomplete)).fieldErrors.purpose).toBeDefined();
    const ok = await json(await submit({ grantId: "creative", draftId: "APP-5001", application: creative }));
    expect(ok.application.status).toBe("Submitted");
    expect((await queued("APP-5001")).status).toBe("Submitted");
    const second = await submit({ grantId: "creative", application: creative });
    expect((await json(second)).error).toMatch(/already have an application/);
  });

  it("never shows staff-only fields to the applicant", async () => {
    await verify("tok-maya", MAYA);
    const { application } = await json(await submit({ grantId: "creative", application: creative }));
    await decide(application.id, "notes", { text: "Portfolio looks strong." });
    await decide(application.id, "start-review", { version: application.updatedAt });
    expect((await queued(application.id)).internalNotes).toHaveLength(1);
    const own = (await mine()).find((a: { id: string }) => a.id === application.id);
    expect(own).toMatchObject({ internalNotes: [], reviewer: null, escalation: null, status: "Under review" });
    expect(await mine("tok-applicant")).toEqual([]);
  });

  it("runs the review loop with permissions and version checks", async () => {
    await verify("tok-maya", MAYA);
    const { application } = await json(await submit({ grantId: "creative", application: creative }));
    expect((await decide(application.id, "start-review", { version: application.updatedAt }, "tok-finance")).status).toBe(403);
    const started = await json(await decide(application.id, "start-review", { version: application.updatedAt }));
    expect(started.application).toMatchObject({ status: "Under review", reviewer: "Sam Rivera" });
    expect((await decide(application.id, "approve", { version: application.updatedAt, award: 4000 })).status).toBe(409);
    let v = started.application.updatedAt;
    expect((await decide(application.id, "request-changes", { version: v, message: "Too short" })).status).toBe(400);
    expect((await decide(application.id, "request-changes", { version: v, message: "Please add a quote for the kiln." })).status).toBe(200);
    const resubmitted = await json(await submit({ grantId: "creative", draftId: application.id, application: { ...creative, purpose: `${creative.purpose} Quote attached.` } }));
    expect(resubmitted.application.status).toBe("Submitted");
    v = (await json(await decide(application.id, "start-review", { version: resubmitted.application.updatedAt }))).application.updatedAt;
    expect((await decide(application.id, "approve", { version: v, award: 4500 })).status).toBe(400);
    const approved = await json(await decide(application.id, "approve", { version: v, award: 3500 }));
    expect(approved.application).toMatchObject({ status: "Approved", awardedAmount: 3500 });
    expect((await mine()).find((a: { id: string }) => a.id === application.id).history.at(-1).note).toMatch(/Approved for \$3,500/);
  });

  it("blocks approval while escalated, until compliance clears it", async () => {
    await verify("tok-maya", MAYA);
    const { application } = await json(await submit({ grantId: "creative", application: creative }));
    const v = (await json(await decide(application.id, "start-review", { version: application.updatedAt }))).application.updatedAt;
    expect((await decide(application.id, "escalate", { reason: "Reference email bounced." })).status).toBe(200);
    expect((await json(await decide(application.id, "approve", { version: v, award: 1000 }))).error).toMatch(/escalated/);
    expect((await decide(application.id, "clear-escalation", { resolution: "Reference confirmed by phone." })).status).toBe(200);
    expect((await decide(application.id, "approve", { version: v, award: 1000 })).status).toBe(200);
  });

  it("locks criteria after the first submission and keeps the budget above awards", async () => {
    await verify("tok-maya", MAYA);
    const { application } = await json(await submit({ grantId: "creative", application: creative }));
    const v = (await json(await decide(application.id, "start-review", { version: application.updatedAt }))).application.updatedAt;
    await decide(application.id, "approve", { version: v, award: 4000 });
    const grant = await program("creative");
    const { id: _id, status: _status, updatedAt, changeLog: _log, ...input } = grant;
    const tier = await json(await put("/programs/creative", { version: updatedAt, program: { ...input, minimumTier: 2 } }));
    expect(tier.fieldErrors.minimumTier).toMatch(/Locked/);
    const budget = await json(await put("/programs/creative", { version: updatedAt, program: { ...input, budget: 3000, maxFunding: 3000 } }));
    expect(budget.fieldErrors).toMatchObject({ budget: expect.stringMatching(/already awarded/) });
  });

  it("never lets two approvals spend the same budget", async () => {
    await verify("tok-maya", MAYA);
    await verify("tok-applicant", ALEX);
    const deadline = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const created = await json(await post("/programs", { name: "Tight Budget", summary: "A program with room for one award.", focus: "Testing", maxFunding: 6000, minimumRequest: 100, budget: 10000, deadline, minimumTier: 1, requirements: ["A plan"], requiresRegistration: false, questions: [], approvalDays: 5, commissionRate: 0 }));
    await post(`/programs/${created.program.id}/publish`, { version: created.program.updatedAt });
    const input = { ...creative, requestedAmount: 6000, checklist: ["A plan"] };
    const a = (await json(await submit({ grantId: created.program.id, application: input }))).application;
    const b = (await json(await submit({ grantId: created.program.id, application: input }, "tok-applicant"))).application;
    const va = (await json(await decide(a.id, "start-review", { version: a.updatedAt }))).application.updatedAt;
    const vb = (await json(await decide(b.id, "start-review", { version: b.updatedAt }))).application.updatedAt;
    const results = await Promise.all([decide(a.id, "approve", { version: va, award: 6000 }), decide(b.id, "approve", { version: vb, award: 6000 })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
  });

  it("refuses reviews of your own application", async () => {
    await verify("tok-super", USERS["tok-super"]!.id).catch(() => {});
    // A super admin can't approve their own identity check, so place their application directly.
    await applications.withProgram("creative", async scope => scope.saveApplication({
      id: "APP-9001", applicantId: USERS["tok-super"]!.id, grantId: "creative", status: "Submitted", ...creative,
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", submittedAt: "2026-09-01T00:00:00.000Z",
      reviewer: null, awardedAmount: null, commissionRate: 5, history: [], internalNotes: [], escalation: null,
    }));
    const res = await decide("APP-9001", "start-review", { version: "2026-09-01T00:00:00.000Z" });
    expect(res.status).toBe(403);
    expect((await decide("APP-9001", "notes", { text: "Looks fine to me." })).status).toBe(403);
  });

  it("lets only the owner delete a draft, and never a submitted application", async () => {
    await verify("tok-maya", MAYA);
    const draft = (await json(await post("/applications/save", { grantId: "creative", application: creative }, "tok-maya"))).application;
    expect((await post(`/applications/${draft.id}/delete`, {}, "tok-applicant")).status).toBe(404);
    expect((await post(`/applications/${draft.id}/delete`, {}, "tok-maya")).status).toBe(200);
    expect(await mine()).toEqual([]);
    const sent = (await json(await submit({ grantId: "creative", application: creative }))).application;
    expect((await post(`/applications/${sent.id}/delete`, {}, "tok-maya")).status).toBe(400);
  });

  it("keeps the review queue to staff", async () => {
    expect((await call("/applications", "tok-applicant")).status).toBe(403);
  });
});

describe("notifications, team activity, and the audit log", () => {
  const MAYA = USERS["tok-maya"]!.id;
  const input = { businessName: "Okafor Studio", requestedAmount: 4000, registrationNumber: "", purpose: "A kiln and a year of glaze materials for the studio.", checklist: ["Portfolio link", "Project budget", "Professional reference"], answers: {} };
  const verifyMaya = async () => {
    await call("/profile", "tok-maya");
    await identityCheck({ documentType: "Passport", documentNumber: "AB12345678", nameOnDocument: "Maya Okafor" }, "tok-maya");
    await post(`/applicants/${MAYA}/identity/approve`, {});
  };
  const notes = async (token = "tok-maya") => json(await call("/notifications", token));
  const feed = async (token = "tok-super") => json(await call("/staff-feed", token));

  it("notifies only the applicant concerned, and lets only them mark it read", async () => {
    await verifyMaya();
    const { application } = await json(await submitApp({ grantId: "creative", application: input }, "tok-maya"));
    const v = (await json(await post(`/applications/${application.id}/start-review`, { version: application.updatedAt }))).application.updatedAt;
    await post(`/applications/${application.id}/approve`, { version: v, award: 3000 });
    const mine = await notes();
    expect(mine.map((n: { title: string }) => n.title)).toEqual(["Creative Practice was approved", "Creative Practice is under review", "Creative Practice application received", "Identity verified", "Identity check in progress"]);
    expect(await notes("tok-applicant")).toEqual([]);
    expect((await post(`/notifications/${mine[0].id}/read`, {}, "tok-applicant")).status).toBe(404);
    expect((await post(`/notifications/${mine[0].id}/read`, {}, "tok-maya")).status).toBe(200);
    expect((await notes())[0].read).toBe(true);
    expect((await json(await post("/notifications/read-all", {}, "tok-maya"))).message).toMatch(/4 notifications/);
  });

  it("tells applicants holding drafts when a program closes", async () => {
    await verifyMaya();
    await post("/applications/save", { grantId: "creative", application: input }, "tok-maya");
    await post("/programs/creative/close", { version: (await program("creative")).updatedAt });
    expect((await notes())[0]).toMatchObject({ title: "Creative Practice is no longer active", href: expect.stringMatching(/^\/applications\/APP-/) });
  });

  it("feeds applicant actions to staff, with each person's own read state", async () => {
    await verifyMaya();
    await submitApp({ grantId: "creative", application: input }, "tok-maya");
    const items = await feed();
    expect(items.map((e: { title: string }) => e.title)).toEqual(["New application APP-5001", "Identity check submitted"]);
    expect((await call("/staff-feed", "tok-applicant")).status).toBe(403);
    await post(`/staff-feed/${items[0].id}/read`, {});
    expect((await feed())[0].read).toBe(true);
    expect((await feed("tok-finance"))[0].read).toBe(false);
  });

  it("audits staff actions with who, where, and field-level changes", async () => {
    await call("/profile", "tok-maya");
    await post(`/applicants/${MAYA}/tier`, { tier: 2, reason: "Trading history confirmed." });
    await post("/staff", { email: "casey@example.org", name: "Casey Brooks", role: "support" });
    expect((await call("/audit", "tok-finance")).status).toBe(403);
    const log = await json(await call("/audit", "tok-super"));
    expect(log.chain).toEqual({ intact: true, checked: 2 });
    const [staffAdd, tier] = log.events;
    expect(tier).toMatchObject({ action: "Change account tier", staffName: "Sam Rivera", role: "super", target: MAYA, applicantId: MAYA, ip: expect.stringContaining("127.0.0.1") });
    expect(tier.changes).toContainEqual({ field: "tier", before: "1", after: "2" });
    expect(staffAdd).toMatchObject({ action: "Add staff member", target: "casey@example.org" });
  });

  it("doesn't audit refused actions", async () => {
    await call("/profile", "tok-maya");
    await post(`/applicants/${MAYA}/tier`, { tier: 1, reason: "Already tier one, so this fails." });
    expect((await json(await call("/audit", "tok-super"))).events).toEqual([]);
  });

  it("detects an edited audit entry", async () => {
    await call("/profile", "tok-maya");
    await post(`/applicants/${MAYA}/lock`, { reason: "Suspicious deposit pattern." });
    await post(`/applicants/${MAYA}/unlock`, {});
    const [, first] = (await json(await call("/audit", "tok-super"))).events;
    activity.tamper(Number(first.id.slice(3)), "Nothing happened here.");
    expect((await json(await call("/audit", "tok-super"))).chain).toEqual({ intact: false, checked: 2, brokenAt: first.id });
  });
});

describe("money", () => {
  const MAYA = USERS["tok-maya"]!.id;
  const input = { businessName: "Okafor Studio", requestedAmount: 4000, registrationNumber: "", purpose: "A kiln and a year of glaze materials for the studio.", checklist: ["Portfolio link", "Project budget", "Professional reference"], answers: {} };
  const mine = async () => json(await call("/money/mine", "tok-maya"));
  const entry = async (id: string) => (await mine()).transactions.find((t: { id: string }) => t.id === id);
  const deposit = (amount: number) => post("/money/deposits", { amount, method: "bank" }, "tok-maya");
  /** Maya verified, awarded `award` on Creative Practice, with a confirmed deposit. */
  const fund = async (award: number, deposited = 100) => {
    await call("/profile", "tok-maya");
    await identityCheck({ documentType: "Passport", documentNumber: "AB12345678", nameOnDocument: "Maya Okafor" }, "tok-maya");
    await post(`/applicants/${MAYA}/identity/approve`, {});
    const { application } = await json(await submitApp({ grantId: "creative", application: { ...input, requestedAmount: award } }, "tok-maya"));
    const v = (await json(await post(`/applications/${application.id}/start-review`, { version: application.updatedAt }))).application.updatedAt;
    await post(`/applications/${application.id}/approve`, { version: v, award });
    const d = (await json(await deposit(deposited))).money.transactions.find((t: { type: string; status: string }) => t.type === "Deposit" && t.status === "Pending");
    await post(`/money/deposits/${d.id}/confirm`, {}, "tok-finance");
  };
  const BANK = { "bank-name": "Meridian Bank", "account-name": "Maya Okafor", "account-number": "123456789" };
  const withdraw = (amount: number) => post("/money/withdrawals", { amount, channel: "bank", details: BANK }, "tok-maya");

  it("starts with no cards and no entries, and hides who changed the settings", async () => {
    const m = await mine();
    expect(m.transactions).toEqual([]);
    expect(m.cards).toMatchObject({ virtual: null, physical: { status: "Not requested" } });
    expect(m.treasury.changeLog).toEqual([]);
  });

  it("takes deposits through announce, confirm, and the pending limit", async () => {
    await call("/profile", "tok-maya");
    expect((await deposit(1)).status).toBe(400);
    const d = (await json(await deposit(50))).money.transactions[0];
    expect(d).toMatchObject({ type: "Deposit", status: "Pending", amount: 50, reference: expect.stringMatching(/^ARC-\d+$/) });
    await deposit(60); await deposit(70);
    expect((await json(await deposit(80))).error).toMatch(/3 deposits waiting/);
    expect((await post(`/money/deposits/${d.id}/confirm`, {}, "tok-applicant")).status).toBe(403);
    expect((await post(`/money/deposits/${d.id}/confirm`, {}, "tok-finance")).status).toBe(200);
    expect((await post(`/money/deposits/${d.id}/confirm`, {}, "tok-finance")).status).toBe(400);
    expect(await entry(d.id)).toMatchObject({ status: "Completed", processedBy: "Jordan Lee" });
    expect((await json(await call("/notifications", "tok-maya")))[0].title).toBe("Deposit received");
  });

  it("credits approved awards to the ledger on the server, once", async () => {
    await fund(3000);
    const grants = (await mine()).transactions.filter((t: { type: string }) => t.type === "Grant");
    expect(grants).toMatchObject([{ amount: 3000, status: "Completed", description: expect.stringMatching(/Creative Practice award \(APP-/) }]);
  });

  it("pays out within the grant balance, with the fee fixed at request time", async () => {
    await fund(3000);
    expect((await json(await withdraw(3500))).error).toMatch(/up to \$3,000/);
    const res = await json(await withdraw(1000));
    const w = res.money.transactions.find((t: { type: string }) => t.type === "Withdrawal");
    expect(w).toMatchObject({ amount: -1000, status: "Pending", destination: "Bank transfer · Meridian Bank", source: "grant" });
    expect(w.payoutDetails).toEqual([
      { fieldId: "bank-name", label: "Bank name", value: "Meridian Bank" }, { fieldId: "account-name", label: "Account holder name", value: "Maya Okafor" },
      { fieldId: "account-number", label: "Account number", value: "123456789" },
    ]);
    expect(w.fee).toBeGreaterThan(0);
    expect((await post(`/money/withdrawals/${w.id}/paid`, {}, "tok-finance")).status).toBe(200);
    expect((await json(await call("/notifications", "tok-maya")))[0].title).toBe("Payout sent");
  });

  it("never lets two payout requests spend the same grant balance", async () => {
    await fund(3000);
    const results = await Promise.all([withdraw(2000), withdraw(2000)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
  });

  it("needs two different staff members for large payouts, compared by id", async () => {
    await fund(3000);
    const w = (await json(await withdraw(2600))).money.transactions.find((t: { type: string }) => t.type === "Withdrawal");
    expect(w.dualControl).toBe(true);
    expect((await json(await post(`/money/withdrawals/${w.id}/paid`, {}, "tok-finance"))).error).toMatch(/release approval/);
    expect((await post(`/money/withdrawals/${w.id}/release`, {}, "tok-finance")).status).toBe(403);
    expect((await post(`/money/withdrawals/${w.id}/release`, {})).status).toBe(200);
    expect((await entry(w.id)).releaseApproval).toMatchObject({ by: "Sam Rivera", byId: SEED[0]!.id });
    expect((await json(await post(`/money/withdrawals/${w.id}/paid`, {}))).error).toMatch(/different staff member/);
    expect((await post(`/money/withdrawals/${w.id}/paid`, {}, "tok-finance")).status).toBe(200);
  });

  it("freezes payouts during a lockdown, but still lets finance mark them failed", async () => {
    await fund(3000);
    const w = (await json(await withdraw(500))).money.transactions.find((t: { type: string }) => t.type === "Withdrawal");
    expect((await post("/money/lockdown", { reason: "Suspected account takeover." }, "tok-finance")).status).toBe(403);
    expect((await post("/money/lockdown", { reason: "Suspected account takeover." })).status).toBe(200);
    expect((await json(await call("/notifications", "tok-maya")))[0].title).toBe("Payouts paused");
    expect((await withdraw(100)).status).toBe(400);
    expect((await post(`/money/withdrawals/${w.id}/paid`, {}, "tok-finance")).status).toBe(400);
    expect((await post(`/money/withdrawals/${w.id}/failed`, { reason: "Held during the security check." }, "tok-finance")).status).toBe(200);
    expect((await post("/money/lockdown/end", {})).status).toBe(200);
    expect((await json(await call("/audit", "tok-super"))).events.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["Start system lockdown", "End system lockdown", "Mark payout failed"]));
  });

  it("lets finance change settings with a version check, and has no application fee any more", async () => {
    const settings = await json(await call("/money/settings", "tok-finance"));
    const { updatedAt, changeLog: _log, ...treasury } = settings.treasury;
    expect(treasury).not.toHaveProperty("applicationFee");
    expect((await put("/money/settings", { version: updatedAt, treasury: { ...treasury, physicalCardFee: 10 } }, "tok-applicant")).status).toBe(403);
    expect((await put("/money/settings", { version: updatedAt, treasury: { ...treasury, applicationFee: 10 } }, "tok-finance")).status).toBe(400);
    expect((await put("/money/settings", { version: updatedAt, treasury: { ...treasury, physicalCardFee: 10 } }, "tok-finance")).status).toBe(200);
    expect((await put("/money/settings", { version: updatedAt, treasury: { ...treasury, physicalCardFee: 20 } }, "tok-finance")).status).toBe(409);
  });

  it("charges nothing at submission, then takes the plan's commission from the deposit balance on approval, below zero if need be", async () => {
    await call("/profile", "tok-maya");
    await identityCheck({ documentType: "Passport", documentNumber: "AB12345678", nameOnDocument: "Maya Okafor" }, "tok-maya");
    await post(`/applicants/${MAYA}/identity/approve`, {});
    const { application } = await json(await submitApp({ grantId: "creative", application: input }, "tok-maya"));
    expect(application.commissionRate).toBeNull();
    expect((await mine()).transactions).toEqual([]);
    const v = (await json(await post(`/applications/${application.id}/start-review`, { version: application.updatedAt }))).application.updatedAt;
    const approved = await json(await post(`/applications/${application.id}/approve`, { version: v, award: 3000 }));
    expect(approved.message).toMatch(/\$150\.00 commission taken from their deposit balance/);
    expect(approved.application.commissionRate).toBe(5);
    const m = await mine();
    expect(m.transactions.map((t: { type: string; amount: number }) => [t.type, t.amount]).sort()).toEqual([["Commission", -150], ["Grant", 3000]]);
    expect(new Set(m.transactions.map((t: { id: string }) => t.id)).size).toBe(2);
    expect(m.transactions.every((t: { id: string }) => /^TX-\d+$/.test(t.id))).toBe(true);
    const notes = await json(await call("/notifications", "tok-maya"));
    expect(notes.some((n: { body: string }) => /5% commission \(\$150\.00\) has been taken from your deposit balance/.test(n.body))).toBe(true);
  });

  describe("cards", () => {
    const address = { name: "Maya Okafor", line1: "12 Canal Street", city: "London", postalCode: "E1 6AN", country: "United Kingdom" };
    const message = "Your card is on its way with Royal Mail: https://track.example/RM4471";
    const holder = async (token = "tok-finance") => json(await call(`/money/card-holders/${MAYA}`, token));
    /** Maya with a confirmed deposit, so she can pay the card fees. */
    const funded = async (amount = 200) => {
      await call("/profile", "tok-maya");
      const d = (await json(await deposit(amount))).money.transactions[0];
      await post(`/money/deposits/${d.id}/confirm`, {}, "tok-finance");
    };

    it("starts without cards: the virtual card comes first, then a physical card", async () => {
      await funded();
      expect((await mine()).cards.virtual).toBeNull();
      expect((await json(await post("/money/cards/physical", address, "tok-maya"))).error).toMatch(/virtual card first/);
      const created = await json(await post("/money/cards/virtual", {}, "tok-maya"));
      expect(created.money.cards.virtual).toMatchObject({ lastFour: expect.stringMatching(/^\d{4}$/), frozen: false });
      expect((await post("/money/cards/virtual", {}, "tok-maya")).status).toBe(400);
    });

    it("runs an application through approval with a message that is always emailed, then activation", async () => {
      await funded();
      await put("/profile/email-preference", { enabled: false }, "tok-maya");
      await post("/money/cards/virtual", {}, "tok-maya");
      expect((await post("/money/cards/physical", { ...address, city: "" }, "tok-maya")).status).toBe(400);
      expect((await post("/money/cards/physical", address, "tok-maya")).status).toBe(200);
      expect((await json(await call("/notifications", "tok-maya")))[0].title).toBe("Physical card application received");
      expect((await call("/money/card-holders", "tok-maya")).status).toBe(403);
      const listed = (await json(await call("/money/card-holders", "tok-finance"))).find((h: { applicantId: string }) => h.applicantId === MAYA);
      expect(listed.cards.physical).toMatchObject({ status: "Requested", shippingAddress: { city: "London" } });
      expect(JSON.stringify(listed)).not.toContain('"pin"');

      expect((await post(`/money/card-holders/${MAYA}/approve`, { message }, "tok-riley")).status).toBe(403);
      const approved = await json(await post(`/money/card-holders/${MAYA}/approve`, { message, trackingRef: "RM4471" }, "tok-finance"));
      expect(approved.holder.cards.physical).toMatchObject({ status: "Shipped", shippingMessage: message, trackingRef: "RM4471", shippedBy: "Jordan Lee" });
      expect((await json(await call("/notifications", "tok-maya")))[0]).toMatchObject({ title: "Your physical card is on its way", body: message });
      expect(outbox.rows.some(r => r.to === "maya@example.com" && r.subject === "Your physical card is on its way" && r.text.includes("RM4471"))).toBe(true); // email copies are off

      const lastFour = approved.holder.cards.physical.lastFour;
      expect((await post("/money/cards/physical/activate", { lastFour }, "tok-maya")).status).toBe(200);
      const audit = (await json(await call("/audit", "tok-super"))).events.find((e: { action: string }) => e.action === "Approve physical card");
      expect(audit).toMatchObject({ target: MAYA, applicantId: MAYA, staffName: "Jordan Lee" });
      expect(audit.changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: "cards.physical.status", before: "Requested", after: "Shipped" })]));
    });

    it("refunds the fee when an application is declined", async () => {
      await funded();
      await post("/money/cards/virtual", {}, "tok-maya");
      const fee = (await json(await post("/money/cards/physical", address, "tok-maya"))).money.transactions.find((t: { type: string }) => t.type === "Card fee");
      expect((await post(`/money/card-holders/${MAYA}/decline`, { reason: "We can't ship to this address yet" }, "tok-finance")).status).toBe(200);
      expect(await entry(fee.id)).toMatchObject({ status: "Cancelled" });
      expect((await mine()).cards.physical).toMatchObject({ status: "Declined", declineReason: "We can't ship to this address yet" });
    });

    it("moves money onto the card within the funding rules staff set", async () => {
      await funded(200);
      await post("/money/cards/virtual", {}, "tok-maya");
      expect((await json(await post("/money/cards/fund", { amount: 50, source: "grant" }, "tok-maya"))).error).toMatch(/deposit balance only/);
      expect((await post("/money/cards/fund", { amount: 180, source: "deposit" }, "tok-maya")).status).toBe(400); // the $25 reserve stays
      expect((await post("/money/cards/fund", { amount: 100, source: "deposit" }, "tok-maya")).status).toBe(200);
      expect((await holder()).balance).toBe(100);

      expect((await post(`/applicants/${MAYA}/card-settings`, { funding: "both", kycRequired: false }, "tok-finance")).status).toBe(403);
      const changed = await json(await post(`/applicants/${MAYA}/card-settings`, { funding: "both", kycRequired: true }, "tok-riley"));
      expect(changed.applicant.profile.account.cardSettings).toEqual({ funding: "both", kycRequired: true });
      expect((await json(await call("/profile", "tok-maya"))).account.cardSettings).toEqual({ funding: "both", kycRequired: true });
      expect((await holder()).settings).toEqual({ funding: "both", kycRequired: true });
    });

    it("lets finance fund with or without a balance and deduct to a balance or out", async () => {
      await funded(200);
      await post(`/money/card-holders/${MAYA}/virtual`, {}, "tok-finance");
      expect((await post(`/money/card-holders/${MAYA}/fund`, { amount: 60, source: "none", reason: "Goodwill credit for the delay" }, "tok-riley")).status).toBe(403);
      expect((await post(`/money/card-holders/${MAYA}/fund`, { amount: 60, source: "none", reason: "short" }, "tok-finance")).status).toBe(400);
      expect((await json(await post(`/money/card-holders/${MAYA}/fund`, { amount: 60, source: "none", reason: "Goodwill credit for the delay" }, "tok-finance"))).holder.balance).toBe(60);
      expect((await json(await post(`/money/card-holders/${MAYA}/fund`, { amount: 150, source: "deposit", reason: "Moving the deposit onto the card" }, "tok-finance"))).holder.balance).toBe(210);
      expect((await post(`/money/card-holders/${MAYA}/deduct`, { amount: 500, destination: "none", reason: "Correction of a duplicate credit" }, "tok-finance")).status).toBe(400);
      expect((await json(await post(`/money/card-holders/${MAYA}/deduct`, { amount: 10, destination: "none", reason: "Correction of a duplicate credit" }, "tok-finance"))).holder.balance).toBe(200);
      expect((await json(await post(`/money/card-holders/${MAYA}/deduct`, { amount: 50, destination: "deposit", reason: "Returning unused card money" }, "tok-finance"))).holder.balance).toBe(150);
      const moves = (await mine()).transactions.filter((t: { type: string }) => t.type.startsWith("Card "));
      expect(moves.map((t: { type: string; counterpart: string; amount: number }) => [t.type, t.counterpart, t.amount])).toEqual(expect.arrayContaining([
        ["Card top-up", "none", 60], ["Card top-up", "deposit", 150], ["Card deduction", "none", -10], ["Card deduction", "deposit", -50],
      ]));
      expect((await json(await call("/notifications", "tok-maya")))[0].body).toContain("Returning unused card money");
    });

    it("lets compliance freeze with a note the applicant sees when they try to unfreeze", async () => {
      await call("/profile", "tok-maya");
      await post("/money/cards/virtual", {}, "tok-maya");
      expect((await post(`/money/card-holders/${MAYA}/freeze`, { card: "virtual", frozen: true, reason: "Unusual activity on the card" }, "tok-finance")).status).toBe(403);
      expect((await post(`/money/card-holders/${MAYA}/freeze`, { card: "virtual", frozen: true, reason: "Unusual activity on the card" }, "tok-riley")).status).toBe(200);
      expect((await json(await post("/money/cards/freeze", {}, "tok-maya"))).error).toBe("The grant team froze this card: Unusual activity on the card. It stays frozen until they lift the freeze.");
      expect((await post(`/money/card-holders/${MAYA}/freeze`, { card: "virtual", frozen: false }, "tok-riley")).status).toBe(200);
      expect((await post("/money/cards/freeze", {}, "tok-maya")).status).toBe(200);
    });

    it("lets finance issue cards for someone who never opened their money pages, but not their own", async () => {
      await call("/profile", "tok-maya");
      expect((await holder()).cards.virtual).toBeNull();
      expect((await json(await post(`/money/card-holders/${MAYA}/physical`, { address, message }, "tok-finance"))).error).toMatch(/virtual card/);
      await post(`/money/card-holders/${MAYA}/virtual`, {}, "tok-finance");
      const issued = await json(await post(`/money/card-holders/${MAYA}/physical`, { address, message }, "tok-finance"));
      expect(issued.holder.cards.physical).toMatchObject({ status: "Shipped", issuedBy: "Jordan Lee" });
      expect((await mine()).transactions.filter((t: { type: string }) => t.type === "Card fee")).toEqual([]);
      await call("/profile", "tok-super");
      expect((await post(`/money/card-holders/${USERS["tok-super"]!.id}/virtual`, {})).status).toBe(403);
      expect((await post("/money/card-holders/99999999-9999-4999-8999-999999999999/virtual", {})).status).toBe(404);
    });
  });

  it("lets finance credit and debit the grant, deposit, and card balances with a category and reason", async () => {
    await fund(1000, 100);
    const adjust = (body: Record<string, unknown>, token = "tok-finance") => post(`/money/card-holders/${MAYA}/adjust`, { target: "grant", direction: "credit", amount: 250, category: "Correction", reason: "Award was entered short", ...body }, token);
    expect((await adjust({}, "tok-riley")).status).toBe(403);
    expect((await adjust({ reason: "short" })).status).toBe(400);
    expect((await adjust({ amount: -5 })).status).toBe(400);
    expect((await adjust({ category: "Bonus" })).status).toBe(400);
    expect((await adjust({})).status).toBe(200);
    expect((await json(await adjust({ target: "deposit", direction: "debit", amount: 5000 }))).error).toMatch(/deposit balance holds/);
    expect((await adjust({ target: "deposit", direction: "debit", amount: 40, category: "Deposit manual override" })).status).toBe(200);
    expect((await json(await adjust({ target: "card", amount: 30, category: "Card fee refund" }))).error).toMatch(/virtual card/);
    await post(`/money/card-holders/${MAYA}/virtual`, {}, "tok-finance");
    expect((await json(await adjust({ target: "card", amount: 30, category: "Card fee refund" }))).holder.balance).toBe(30);
    const m = await mine();
    const adjustments = m.transactions.filter((t: { category?: string }) => t.category);
    expect(adjustments.map((t: { type: string; amount: number; category: string }) => [t.type, t.amount, t.category])).toEqual(expect.arrayContaining([
      ["Grant adjustment", 250, "Correction"], ["Deposit adjustment", -40, "Deposit manual override"], ["Card top-up", 30, "Card fee refund"],
    ]));
    const notices = await json(await call("/notifications", "tok-maya"));
    expect(notices.some((n: { title: string; body: string }) => n.title === "Balance adjusted by the grant team" && n.body.includes("taken from your deposit balance: Award was entered short"))).toBe(true);
    const entry = (await json(await call("/audit", "tok-super"))).events.find((e: { action: string; summary: string }) => e.action === "Adjust balance" && e.summary.includes("added to the grant balance"));
    expect(entry.changes).toEqual(expect.arrayContaining([{ field: "balances.grant", before: "1000", after: "1250" }]));
  });

  it("keeps each applicant to their own money, and staff off their own", async () => {
    await call("/profile", "tok-maya");
    const d = (await json(await deposit(50))).money.transactions[0];
    expect((await post(`/money/deposits/${d.id}/cancel`, {}, "tok-applicant")).status).toBe(400);
    expect(await entry(d.id)).toMatchObject({ status: "Pending" });
    await call("/profile", "tok-super");
    const own = (await json(await post("/money/deposits", { amount: 50, method: "bank" }, "tok-super"))).money.transactions[0];
    expect((await post(`/money/deposits/${own.id}/confirm`, {})).status).toBe(403);
  });
});

describe("withdrawal methods", () => {
  const MAYA = USERS["tok-maya"]!.id;
  const settings = async (token = "tok-finance") => json(await call("/money/settings", token));
  const version = async () => (await settings()).treasury.updatedAt as string;
  const paypal = (patch: Record<string, unknown> = {}) => ({
    name: "PayPal", enabled: true, min: 20, max: 1500, feeRate: 0.02, feeFixed: 1, feeCap: 0, processingTime: "Within 24 hours",
    instructions: "Use the email of a verified PayPal account.", photoUrl: "", source: "both", formTitle: "PayPal account",
    fields: [
      { label: "PayPal email", type: "email", required: true, placeholder: "you@example.com", help: "", options: [] },
      { label: "Account type", type: "select", required: true, placeholder: "", help: "", options: ["Personal", "Business"] },
    ],
    ...patch,
  });
  const create = async (patch: Record<string, unknown> = {}, token = "tok-finance") => post("/money/methods", { version: await version(), method: paypal(patch) }, token);
  const edit = async (id: string, patch: Record<string, unknown>, token = "tok-finance") => put(`/money/methods/${id}`, { version: await version(), method: paypal(patch) }, token);
  const upload = (id: string, bytes: Buffer, token = "tok-finance") => fetch(`${base}/money/methods/${id}/photo`, { method: "PUT", body: new Uint8Array(bytes), headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" } });
  const photoOf = async (id: string) => (await settings()).treasury.channels.find((c: { id: string }) => c.id === id).photoUrl as string;
  const ANSWERS = { "paypal-email": "maya@example.com", "account-type": "Personal" };
  const withdraw = (body: Record<string, unknown>) => post("/money/withdrawals", body, "tok-maya");
  /** Maya verified, awarded `award`, with `deposited` confirmed in her deposit balance. */
  const fund = async (award: number, deposited: number) => {
    await call("/profile", "tok-maya");
    await identityCheck({ documentType: "Passport", documentNumber: "AB12345678", nameOnDocument: "Maya Okafor" }, "tok-maya");
    await post(`/applicants/${MAYA}/identity/approve`, {});
    const app = { businessName: "Okafor Studio", requestedAmount: award, registrationNumber: "", purpose: "A kiln and a year of glaze materials for the studio.", checklist: ["Portfolio link", "Project budget", "Professional reference"], answers: {} };
    const { application } = await json(await submitApp({ grantId: "creative", application: app }, "tok-maya"));
    const v = (await json(await post(`/applications/${application.id}/start-review`, { version: application.updatedAt }))).application.updatedAt;
    await post(`/applications/${application.id}/approve`, { version: v, award });
    const d = (await json(await post("/money/deposits", { amount: deposited, method: "bank" }, "tok-maya"))).money.transactions.find((t: { type: string }) => t.type === "Deposit");
    await post(`/money/deposits/${d.id}/confirm`, {}, "tok-finance");
  };

  it("lets finance and super admins add methods; others get 403, a stale version 409, and bad input field errors", async () => {
    const res = await create();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ id: "paypal", message: expect.stringMatching(/PayPal added/) });
    const added = body.settings.treasury.channels.find((c: { id: string }) => c.id === "paypal");
    expect(added.fields.map((f: { id: string }) => f.id)).toEqual(["paypal-email", "account-type"]);
    expect(body.settings.treasury.changeLog.at(-1)).toMatchObject({ by: "Jordan Lee", summary: "Added withdrawal method PayPal." });
    expect((await create({ name: "Skrill" }, "tok-super")).status).toBe(200);
    await call("/profile", "tok-maya");
    expect((await create({ name: "Payoneer" }, "tok-maya")).status).toBe(403);
    expect((await create({ name: "Payoneer" }, "tok-riley")).status).toBe(403);
    expect((await post("/money/methods", { version: "2020-01-01T00:00:00.000Z", method: paypal({ name: "Payoneer" }) }, "tok-finance")).status).toBe(409);
    const bad = await json(await create({ name: "Payoneer", min: 50, max: 10, photoUrl: "http://cdn.example.com/p.png" }));
    expect(bad.fieldErrors).toMatchObject({ max: "Must be at least the minimum.", photoUrl: "Use a secure link (https://)." });
    const dataUrl = await create({ name: "Payoneer", photoUrl: "data:image/png;base64,iVBORw0KGgo=" });
    expect([dataUrl.status, (await json(dataUrl)).fieldErrors?.photoUrl]).toEqual([400, expect.stringMatching(/photo button/)]);
    expect((await post("/money/methods", { version: await version(), method: { name: "Half a method" } }, "tok-finance")).status).toBe(400);
  });

  it("edits, hides, and deletes methods; applicants only see available ones, without the change log", async () => {
    await create();
    expect((await edit("paypal", { max: 2000 })).status).toBe(200);
    expect((await settings()).treasury.changeLog.at(-1).summary).toBe("Withdrawal method PayPal: limits.");
    expect((await edit("nope", { name: "Nope" })).status).toBe(404);
    await call("/profile", "tok-maya");
    const ids = async () => (await json(await call("/money/mine", "tok-maya"))).treasury.channels.map((c: { id: string }) => c.id);
    expect(await ids()).toContain("paypal");
    expect((await post("/money/methods/paypal/availability", { enabled: false }, "tok-finance")).status).toBe(200);
    expect(await ids()).not.toContain("paypal");
    expect((await settings()).treasury.channels.find((c: { id: string }) => c.id === "paypal").enabled).toBe(false);
    expect((await json(await call("/money/mine", "tok-maya"))).treasury.changeLog).toEqual([]);
    expect((await post("/money/methods/paypal/availability", { enabled: false }, "tok-finance")).status).toBe(400);
    expect((await post("/money/methods/paypal/availability", { enabled: true }, "tok-maya")).status).toBe(403);
    expect((await post("/money/methods/paypal/delete", {}, "tok-finance")).status).toBe(200);
    expect((await settings()).treasury.channels.map((c: { id: string }) => c.id)).not.toContain("paypal");
    expect((await post("/money/methods/paypal/delete", {}, "tok-finance")).status).toBe(404);
  });

  it("stores uploaded photos on the server, serves them publicly by method, and removes them when replaced or deleted", async () => {
    await create();
    expect((await upload("paypal", Buffer.from("not an image"))).status).toBe(415);
    expect((await upload("paypal", Buffer.alloc(0))).status).toBe(400);
    expect((await upload("paypal", Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))).status).toBe(413);
    await call("/profile", "tok-maya");
    expect((await upload("paypal", PNG, "tok-maya")).status).toBe(403);
    expect((await upload("paypal", PNG)).status).toBe(200);
    const url = await photoOf("paypal");
    expect(url).toMatch(/^\/api\/withdrawal-methods\/paypal\/photo\?v=[0-9a-f]{12}$/);
    expect(JSON.stringify(await settings())).not.toContain("photoFile");
    // Public: no token needed.
    const served = await fetch(`${base}${url.replace(/^\/api/, "")}`);
    expect([served.status, served.headers.get("content-type"), Buffer.from(await served.arrayBuffer()).equals(PNG)]).toEqual([200, "image/png", true]);
    const [first] = [...files.files.keys()];
    const other = Buffer.concat([PNG, Buffer.alloc(8, 2)]);
    expect((await upload("paypal", other)).status).toBe(200);
    expect(files.files.has(first!)).toBe(false); // the replaced photo is gone
    const [second] = [...files.files.keys()];
    files.files.set(second!, Buffer.from("changed on disk"));
    expect((await fetch(`${base}/withdrawal-methods/paypal/photo`)).status).toBe(404);
    expect((await post("/money/methods/paypal/photo/delete", {}, "tok-finance")).status).toBe(200);
    expect(await photoOf("paypal")).toBe("");
    expect(files.files.size).toBe(0);
    expect((await upload("paypal", PNG)).status).toBe(200);
    expect((await post("/money/methods/paypal/delete", {}, "tok-finance")).status).toBe(200);
    expect(files.files.size).toBe(0);
    expect((await fetch(`${base}/withdrawal-methods/paypal/photo`)).status).toBe(404);
    expect((await upload("paypal", PNG)).status).toBe(404);
  });

  it("takes requests with the method's form and the chosen balance, remembers the answers, and shows finance every answer", async () => {
    await fund(3000, 350); // creative takes a 5% commission on approval: $150 of the $350 deposit
    await create();
    const missing = await json(await withdraw({ amount: 100, channel: "paypal", source: "grant", details: {} }));
    expect(missing.fieldErrors).toEqual({ "details.paypal-email": "PayPal email is required.", "details.account-type": "Account type is required." });
    expect((await json(await withdraw({ amount: 100, channel: "paypal", details: ANSWERS }))).error).toMatch(/Choose the balance/);
    expect((await json(await withdraw({ amount: 180, channel: "paypal", source: "deposit", details: ANSWERS }))).error).toMatch(/up to \$175\.00 from your deposit balance/);
    expect((await json(await withdraw({ amount: 100, channel: "bank", source: "deposit", details: {} }))).error).toMatch(/grant balance only/);
    const ok = await json(await withdraw({ amount: 100, channel: "paypal", source: "deposit", details: { ...ANSWERS, stray: "ignored" } }));
    const w = ok.money.transactions.find((t: { type: string }) => t.type === "Withdrawal");
    expect(w).toMatchObject({ source: "deposit", fee: 3, destination: "PayPal · maya@example.com", payoutDetails: [{ fieldId: "paypal-email", label: "PayPal email", value: "maya@example.com" }, { fieldId: "account-type", label: "Account type", value: "Personal" }] });
    expect(ok.money.savedPayoutDetails).toEqual({ paypal: ANSWERS });
    const ledger = await json(await call("/money/ledger", "tok-finance"));
    expect(ledger.find((t: { id: string }) => t.id === w.id).payoutDetails).toEqual(w.payoutDetails);
    // Remembered after a reload, and the method can be deleted while the request is still payable.
    expect((await json(await call("/money/mine", "tok-maya"))).savedPayoutDetails.paypal).toEqual(ANSWERS);
    expect((await post("/money/methods/paypal/delete", {}, "tok-finance")).status).toBe(200);
    expect((await post(`/money/withdrawals/${w.id}/paid`, {}, "tok-finance")).status).toBe(200);
  });

  it("pays grant payouts while a commission leaves the deposit balance negative, unless staff switch on clearing it first", async () => {
    const BANK = { "bank-name": "Meridian Bank", "account-name": "Maya Okafor", "account-number": "123456789" };
    const grantPayout = () => withdraw({ amount: 100, channel: "bank", details: BANK });
    await fund(4000, 50); // creative takes 5% = $200 on approval, so the deposit balance ends below zero
    const balance = async () => {
      const txs = (await json(await call("/money/mine", "tok-maya"))).transactions as { type: string; amount: number; status: string; fee?: number }[];
      return txs.reduce((sum, t) => sum + (t.type === "Commission" ? t.amount : t.type === "Deposit" && t.status === "Completed" ? t.amount - (t.fee ?? 0) : 0), 0);
    };
    expect(await balance()).toBeLessThan(0);
    expect((await grantPayout()).status).toBe(200);
    expect((await post(`/applicants/${MAYA}/permissions`, { key: "clearBalanceForPayouts", value: true }, "tok-finance")).status).toBe(403);
    const switched = await post(`/applicants/${MAYA}/permissions`, { key: "clearBalanceForPayouts", value: true });
    expect(switched.status).toBe(200);
    expect((await json(switched)).applicant.profile.account.permissions.clearBalanceForPayouts).toBe(true);
    const held = await grantPayout();
    expect(held.status).toBe(400);
    expect((await json(held)).error).toMatch(/Add funds to bring it back to \$0\.00/);
    const d = (await json(await post("/money/deposits", { amount: 500, method: "bank" }, "tok-maya"))).money.transactions.find((t: { type: string; status: string }) => t.type === "Deposit" && t.status === "Pending");
    await post(`/money/deposits/${d.id}/confirm`, {}, "tok-finance");
    expect(await balance()).toBeGreaterThanOrEqual(0);
    expect((await grantPayout()).status).toBe(200);
  });

  it("has no payout-destination endpoints any more", async () => {
    await call("/profile", "tok-maya");
    expect((await post("/money/destinations", { channel: "bank", primary: "Meridian Bank", secondary: "123456789" }, "tok-maya")).status).toBe(404);
  });
});

describe("deposit methods and proof of payment", () => {
  const settings = async (token = "tok-finance") => json(await call("/money/settings", token));
  const version = async () => (await settings()).treasury.updatedAt as string;
  const paypal = (patch: Record<string, unknown> = {}) => ({
    name: "PayPal", enabled: true, min: 20, max: 1500, feeRate: 0.02, feeFixed: 1, feeCap: 0, processingTime: "Within 24 hours",
    instructions: "Send as friends and family.", photoUrl: "", receivingDetails: [{ label: "PayPal email", value: "funds@example.org" }], proof: "required",
    formTitle: "Sender details", fields: [{ label: "Your PayPal email", type: "email", required: true, placeholder: "", help: "", options: [] }],
    ...patch,
  });
  const create = async (patch: Record<string, unknown> = {}, token = "tok-finance") => post("/money/deposit-methods", { version: await version(), method: paypal(patch) }, token);
  const deposit = (body: Record<string, unknown>) => post("/money/deposits", body, "tok-maya");
  const pendingDeposit = (res: { money: { transactions: { type: string; status: string }[] } }) => res.money.transactions.find(t => t.type === "Deposit" && t.status === "Pending") as unknown as Record<string, unknown> & { id: string };
  const uploadProof = (id: string, bytes: Buffer, token = "tok-maya", name = "receipt.png") =>
    fetch(`${base}/money/deposits/${id}/proof`, { method: "PUT", body: new Uint8Array(bytes), headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) } });
  const uploadPhoto = (id: string, bytes: Buffer, token = "tok-finance") => fetch(`${base}/money/deposit-methods/${id}/photo`, { method: "PUT", body: new Uint8Array(bytes), headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" } });
  const ANSWERS = { "your-paypal-email": "maya@example.com" };

  it("starts with bank, mobile money, and a hidden USDT method; applicants see only the available ones", async () => {
    expect((await settings()).treasury.depositMethods.map((m: { id: string; enabled: boolean }) => [m.id, m.enabled])).toEqual([["bank", true], ["mobile", true], ["crypto", false]]);
    await call("/profile", "tok-maya");
    const mine = await json(await call("/money/mine", "tok-maya"));
    expect(mine.treasury.depositMethods.map((m: { id: string }) => m.id)).toEqual(["bank", "mobile"]);
    expect((await json(await deposit({ amount: 100, method: "crypto" }))).error).toMatch(/available deposit method/);
  });

  it("lets finance add, edit, hide, and delete methods with version checks; others get 403", async () => {
    const res = await create();
    expect(res.status).toBe(200);
    expect((await json(res)).settings.treasury.changeLog.at(-1)).toMatchObject({ by: "Jordan Lee", summary: "Added deposit method PayPal." });
    await call("/profile", "tok-maya");
    expect((await create({ name: "Skrill" }, "tok-maya")).status).toBe(403);
    expect((await create({ name: "Skrill" }, "tok-riley")).status).toBe(403);
    expect((await post("/money/deposit-methods", { version: "2020-01-01T00:00:00.000Z", method: paypal({ name: "Skrill" }) }, "tok-finance")).status).toBe(409);
    const bad = await json(await create({ name: "Skrill", receivingDetails: [] }));
    expect(bad.fieldErrors).toMatchObject({ receivingDetails: expect.stringMatching(/at least one line/) });
    expect((await put("/money/deposit-methods/paypal", { version: await version(), method: paypal({ max: 2000 }) }, "tok-finance")).status).toBe(200);
    expect((await settings()).treasury.changeLog.at(-1).summary).toBe("Deposit method PayPal: limits.");
    expect((await put("/money/deposit-methods/nope", { version: await version(), method: paypal() }, "tok-finance")).status).toBe(404);
    expect((await post("/money/deposit-methods/paypal/availability", { enabled: false }, "tok-finance")).status).toBe(200);
    expect((await json(await call("/money/mine", "tok-maya"))).treasury.depositMethods.map((m: { id: string }) => m.id)).not.toContain("paypal");
    expect((await post("/money/deposit-methods/paypal/delete", {}, "tok-finance")).status).toBe(200);
    expect((await post("/money/deposit-methods/paypal/delete", {}, "tok-finance")).status).toBe(404);
  });

  it("stores method photos on the server and serves them publicly", async () => {
    await create();
    expect((await uploadPhoto("paypal", Buffer.from("not an image"))).status).toBe(415);
    expect((await uploadPhoto("paypal", PNG)).status).toBe(200);
    const url = (await settings()).treasury.depositMethods.find((m: { id: string }) => m.id === "paypal").photoUrl as string;
    expect(url).toMatch(/^\/api\/deposit-methods\/paypal\/photo\?v=[0-9a-f]{12}$/);
    expect(JSON.stringify(await settings())).not.toContain("photoFile");
    const served = await fetch(`${base}${url.replace(/^\/api/, "")}`);
    expect([served.status, served.headers.get("content-type")]).toEqual([200, "image/png"]);
    // The withdrawal photo route doesn't serve deposit method photos.
    expect((await fetch(`${base}/withdrawal-methods/paypal/photo`)).status).toBe(404);
    expect((await post("/money/deposit-methods/paypal/delete", {}, "tok-finance")).status).toBe(200);
    expect(files.files.size).toBe(0);
  });

  it("takes deposits with the method's form and receiving details, and credits the amount less the charge", async () => {
    await create({ proof: "optional" });
    await call("/profile", "tok-maya");
    expect((await json(await deposit({ amount: 100, method: "paypal", details: {} }))).fieldErrors).toEqual({ "details.your-paypal-email": "Your PayPal email is required." });
    const d = pendingDeposit(await json(await deposit({ amount: 100, method: "paypal", details: ANSWERS })));
    expect(d).toMatchObject({ amount: 100, fee: 3, payTo: [{ label: "PayPal email", value: "funds@example.org" }], depositDetails: [{ fieldId: "your-paypal-email", value: "maya@example.com" }] });
    const ledger = await json(await call("/money/ledger", "tok-finance"));
    expect(ledger.find((t: { id: string }) => t.id === d.id).depositDetails).toEqual(d.depositDetails);
    const confirmed = await json(await post(`/money/deposits/${d.id}/confirm`, {}, "tok-finance"));
    expect(confirmed.message).toMatch(/\$97\.00 credited/);
    expect((await json(await call("/notifications", "tok-maya")))[0].body).toMatch(/\$97\.00 .* after the \$3\.00 charge/);
  });

  it("keeps proof of payment on the server: the owner uploads and removes it, finance opens it (audited), and confirming waits for it", async () => {
    await create();
    await call("/profile", "tok-maya");
    await call("/profile", "tok-applicant");
    const d = pendingDeposit(await json(await deposit({ amount: 100, method: "paypal", details: ANSWERS })));
    expect(d.proofRequired).toBe(true);
    expect((await json(await post(`/money/deposits/${d.id}/confirm`, {}, "tok-finance"))).error).toMatch(/needs proof of payment/);

    expect((await uploadProof(d.id, Buffer.from("<html>"))).status).toBe(415);
    expect((await uploadProof(d.id, Buffer.alloc(0))).status).toBe(400);
    expect((await uploadProof(d.id, PNG, "tok-applicant")).status).toBe(404);
    expect((await uploadProof(d.id, Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]))).status).toBe(413);
    const up = await uploadProof(d.id, PNG, "tok-maya", "my receipt.png");
    expect(up.status).toBe(200);
    const saved = await json(up);
    const proof = saved.money.transactions.find((t: { id: string }) => t.id === d.id).proof[0];
    expect(proof).toMatchObject({ id: saved.id, fileName: "my receipt.png", contentType: "image/png", sizeBytes: PNG.length });
    expect(files.files.has(`${USERS["tok-maya"]!.id}/${proof.id}`)).toBe(true);

    const open = (token: string) => call(`/money/deposits/${d.id}/proof/${proof.id}`, token);
    const own = await open("tok-maya");
    expect([own.status, Buffer.from(await own.arrayBuffer()).equals(PNG)]).toEqual([200, true]);
    expect((await open("tok-applicant")).status).toBe(404);
    expect((await open("tok-finance")).status).toBe(200);
    const [view] = (await json(await call("/audit", "tok-super"))).events;
    expect(view).toMatchObject({ action: "View deposit proof", target: d.id, applicantId: USERS["tok-maya"]!.id, staffName: "Jordan Lee" });
    expect(view.summary).toContain("my receipt.png");

    const second = await json(await uploadProof(d.id, JPEG, "tok-maya", "photo.jpg"));
    expect((await post(`/money/deposits/${d.id}/proof/${second.id}/delete`, {}, "tok-applicant")).status).toBe(404);
    expect((await post(`/money/deposits/${d.id}/proof/${second.id}/delete`, {}, "tok-maya")).status).toBe(200);
    expect(files.files.has(`${USERS["tok-maya"]!.id}/${second.id}`)).toBe(false);

    files.files.set(`${USERS["tok-maya"]!.id}/${proof.id}`, Buffer.from("changed on disk"));
    expect((await open("tok-maya")).status).toBe(500);
    files.files.set(`${USERS["tok-maya"]!.id}/${proof.id}`, PNG);
    expect((await post(`/money/deposits/${d.id}/confirm`, {}, "tok-finance")).status).toBe(200);
    expect((await uploadProof(d.id, PNG)).status).toBe(400);
  });

  it("needs two different staff members for large deposits, compared by id", async () => {
    await call("/profile", "tok-maya");
    const d = pendingDeposit(await json(await deposit({ amount: 3000, method: "bank" })));
    expect(d.dualControl).toBe(true);
    expect((await json(await post(`/money/deposits/${d.id}/confirm`, {}, "tok-finance"))).error).toMatch(/approval from a second staff member/);
    expect((await post(`/money/deposits/${d.id}/release`, {}, "tok-finance")).status).toBe(403);
    expect((await post(`/money/deposits/${d.id}/release`, {})).status).toBe(200);
    const ledger = await json(await call("/money/ledger", "tok-finance"));
    expect(ledger.find((t: { id: string }) => t.id === d.id).releaseApproval).toMatchObject({ by: "Sam Rivera", byId: SEED[0]!.id });
    expect((await json(await post(`/money/deposits/${d.id}/confirm`, {}))).error).toMatch(/different staff member must confirm/);
    expect((await post(`/money/deposits/${d.id}/confirm`, {}, "tok-finance")).status).toBe(200);
  });

  it("drops the old deposit limits from the money settings and adds the deposit two-person threshold", async () => {
    const t = (await settings()).treasury;
    expect(t).not.toHaveProperty("minDeposit");
    expect(t.depositDualControlThreshold).toBe(2500);
    const { channels: _c, depositMethods: _d, updatedAt, changeLog: _l, ...rest } = t;
    const res = await put("/money/settings", { version: updatedAt, treasury: { ...rest, depositDualControlThreshold: 0 } }, "tok-finance");
    expect(res.status).toBe(200);
    expect((await settings()).treasury.depositDualControlThreshold).toBe(0);
  });
});

describe("documents", () => {
  const MAYA = USERS["tok-maya"]!.id;
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("image")]);
  const identity = { documentType: "Passport", documentNumber: "AB12345678", nameOnDocument: "Maya Okafor" };
  const input = { businessName: "Okafor Studio", requestedAmount: 4000, registrationNumber: "", purpose: "A kiln and a year of glaze materials for the studio.", checklist: ["Portfolio link", "Project budget", "Professional reference"], answers: {} };
  const mineDocs = async (token = "tok-maya") => json(await call("/documents/mine", token));
  const file = (id: string, token: string) => call(`/documents/${id}/file`, token);

  it("accepts only PDF, JPEG, and PNG files up to 10 MB, typed by content", async () => {
    await call("/profile", "tok-maya");
    expect((await upload("tok-maya", "purpose=identity", Buffer.from("<html>not a scan</html>"), "scan.pdf")).status).toBe(415);
    expect((await upload("tok-maya", "purpose=identity", Buffer.alloc(0))).status).toBe(400);
    expect((await upload("tok-maya", "purpose=identity", Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]))).status).toBe(413);
    expect((await upload("tok-maya", "purpose=elsewhere")).status).toBe(400);
    const res = await upload("tok-maya", "purpose=identity", PNG, "../../etc/passport.pdf");
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ purpose: "identity", contentType: "image/png", fileName: "passport.pdf", sizeBytes: PNG.length });
    expect(files.files.size).toBe(1);
  });

  it("takes files for a plan's form fields and needs one for each required file field before submitting", async () => {
    await call("/profile", "tok-maya");
    await upload("tok-maya", "purpose=identity");
    await post("/profile/identity", identity, "tok-maya");
    await post(`/applicants/${MAYA}/identity/approve`, {});
    const questions = [
      { id: "", label: "Bank statement", type: "file", required: true },
      { id: "", label: "Extra document", type: "file", required: false },
      { id: "", label: "Tell us about your team", type: "textarea", required: true },
    ];
    const created = await json(await post("/programs", newProgram({ name: "Form Plan", requirements: [], questions, commissionRate: 2.5, approvalDays: 10 })));
    expect(created.program).toMatchObject({ approvalDays: 10, commissionRate: 2.5, questions: [{ id: "bank-statement", type: "file" }, { id: "extra-document" }, { id: "tell-us-about-your-team", type: "textarea" }] });
    await post(`/programs/${created.program.id}/publish`, { version: created.program.updatedAt });
    const application = { ...input, requestedAmount: 1000, checklist: [], answers: { "tell-us-about-your-team": "Two potters and an apprentice.", "bank-statement": "typed answers to file fields are dropped" } };
    const draft = (await json(await post("/applications/save", { grantId: created.program.id, application }, "tok-maya"))).application;
    expect(draft.answers).toEqual({ "tell-us-about-your-team": "Two potters and an apprentice." });
    const submit = () => post("/applications/submit", { grantId: created.program.id, draftId: draft.id, application }, "tok-maya");
    const missing = await submit();
    expect(missing.status).toBe(400);
    expect((await json(missing)).error).toBe("Upload a file for: Bank statement.");
    expect((await upload("tok-maya", `purpose=application&applicationId=${draft.id}&requirement=field:nope`)).status).toBe(400);
    expect((await upload("tok-maya", `purpose=application&applicationId=${draft.id}&requirement=${encodeURIComponent("field:bank-statement")}`)).status).toBe(201);
    const ok = await submit();
    expect(ok.status).toBe(200);
    expect((await json(ok)).application.commissionRate).toBeNull();
  });

  it("refuses files carrying scripts, programs, hidden archives, or PDF actions", async () => {
    await call("/profile", "tok-maya");
    const { deflateSync } = await import("node:zlib");
    const compressed = deflateSync(Buffer.from("<< /Type /Action /S /JavaScript /JS (app.alert(1)) >>"));
    const cases: [Buffer, RegExp][] = [
      [Buffer.from("%PDF-1.7\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n"), /JavaScript/],
      [Buffer.from("%PDF-1.7\n1 0 obj << /S /J#61vaScript >> endobj\n"), /JavaScript/],
      [Buffer.concat([Buffer.from("%PDF-1.7\n1 0 obj << /Filter /FlateDecode >>\nstream\n"), compressed, Buffer.from("\nendstream\nendobj\n")]), /JavaScript/],
      [Buffer.from("%PDF-1.7\n1 0 obj << /Type /Filespec /EF << /F 2 0 R >> /EmbeddedFile >> endobj\n"), /embedded file/],
      [Buffer.from("%PDF-1.7\ntrailer << /Encrypt 5 0 R >>\n"), /password-protected or encrypted/],
      [Buffer.concat([PNG, Buffer.from("<script>alert(1)</script>")]), /script/],
      [Buffer.concat([PNG, Buffer.from("<?php system($_GET['c']); ?>")]), /PHP/],
      [Buffer.concat([PNG, Buffer.from("PK\x03\x04payloadPK\x05\x06", "latin1")]), /hidden archive/],
      [Buffer.concat([PDF, Buffer.from("MZ This program cannot be run in DOS mode")]), /Windows program/],
    ];
    for (const [bytes, reason] of cases) {
      const res = await upload("tok-maya", "purpose=identity", bytes);
      expect(res.status).toBe(422);
      expect((await json(res)).error).toMatch(reason);
    }
    // A PDF that quotes markup as text is fine; so is a plain one.
    expect((await upload("tok-maya", "purpose=identity", Buffer.from("%PDF-1.7\n(<script> is an HTML tag) Tj\n"))).status).toBe(201);
    expect(files.files.size).toBe(1);
  });

  it("needs an uploaded document before an identity check, and keeps it while the check is open", async () => {
    await call("/profile", "tok-maya");
    const refused = await post("/profile/identity", identity, "tok-maya");
    expect(refused.status).toBe(400);
    expect((await json(refused)).fieldErrors.documents).toBeDefined();
    const doc = await json(await upload("tok-maya", "purpose=identity"));
    expect((await post("/profile/identity", identity, "tok-maya")).status).toBe(200);
    expect((await post(`/documents/${doc.id}/delete`, {}, "tok-maya")).status).toBe(409);
    expect((await upload("tok-maya", "purpose=identity")).status).toBe(409);
    await post(`/applicants/${MAYA}/identity/reject`, { reason: "The scan is too blurry to read." });
    expect((await post(`/documents/${doc.id}/delete`, {}, "tok-maya")).status).toBe(200);
    expect(await mineDocs()).toEqual([]);
    expect(files.files.size).toBe(0);
  });

  it("lets the owner and permitted staff open a document, audits staff views, and hides it from everyone else", async () => {
    await call("/profile", "tok-maya");
    const doc = await json(await upload("tok-maya", "purpose=identity", PDF, "passport scan.pdf"));
    const own = await file(doc.id, "tok-maya");
    expect(own.status).toBe(200);
    expect(Buffer.from(await own.arrayBuffer()).equals(PDF)).toBe(true);
    expect(own.headers.get("content-type")).toBe("application/pdf");
    expect(own.headers.get("x-content-type-options")).toBe("nosniff");
    expect(own.headers.get("cache-control")).toContain("no-store");
    expect(own.headers.get("content-disposition")).toContain("attachment");
    expect((await file(doc.id, "tok-applicant")).status).toBe(404);
    expect((await file(doc.id, "tok-finance")).status).toBe(404);
    expect((await call(`/documents?applicantId=${MAYA}`, "tok-finance").then(json))).toEqual([]);
    expect((await call(`/documents?applicantId=${MAYA}`, "tok-applicant")).status).toBe(403);
    expect((await call(`/documents?applicantId=${MAYA}`, "tok-super").then(json)).map((d: { id: string }) => d.id)).toEqual([doc.id]);
    expect((await file(doc.id, "tok-super")).status).toBe(200);
    const [view] = (await json(await call("/audit", "tok-super"))).events;
    expect(view).toMatchObject({ action: "View document", target: doc.id, applicantId: MAYA, staffName: "Sam Rivera" });
    expect(view.summary).toContain("passport scan.pdf");
  });

  it("detects a stored file that was changed or removed", async () => {
    await call("/profile", "tok-maya");
    const doc = await json(await upload("tok-maya", "purpose=identity"));
    const [key] = [...files.files.keys()];
    files.files.set(key!, Buffer.from("%PDF-1.7 altered"));
    expect((await file(doc.id, "tok-maya")).status).toBe(500);
    files.files.delete(key!);
    expect((await file(doc.id, "tok-maya")).status).toBe(500);
  });

  it("needs a file for every requirement before submitting, and freezes evidence once submitted", async () => {
    await call("/profile", "tok-maya");
    await identityCheck(identity, "tok-maya");
    await post(`/applicants/${MAYA}/identity/approve`, {});
    const draft = (await json(await post("/applications/save", { grantId: "creative", application: input }, "tok-maya"))).application;
    const q = (requirement: string, id = draft.id) => `purpose=application&applicationId=${id}&requirement=${encodeURIComponent(requirement)}`;
    expect((await upload("tok-maya", q("A letter from the Queen"))).status).toBe(400);
    expect((await upload("tok-applicant", q("Portfolio link"))).status).toBe(404);
    expect((await upload("tok-maya", "purpose=application")).status).toBe(400);
    const portfolio = await json(await upload("tok-maya", q("Portfolio link")));
    const missing = await post("/applications/submit", { grantId: "creative", draftId: draft.id, application: input }, "tok-maya");
    expect(missing.status).toBe(400);
    expect((await json(missing)).error).toMatch(/Project budget, Professional reference/);
    expect((await post("/applications/submit", { grantId: "creative", application: input }, "tok-applicant")).status).toBe(400);
    await upload("tok-maya", q("Project budget"));
    await upload("tok-maya", q("Professional reference"));
    expect((await post("/applications/submit", { grantId: "creative", draftId: draft.id, application: input }, "tok-maya")).status).toBe(200);
    expect((await post(`/documents/${portfolio.id}/delete`, {}, "tok-maya")).status).toBe(409);
    expect((await upload("tok-maya", q("Portfolio link"))).status).toBe(409);
    expect((await call(`/documents?applicationId=${draft.id}`, "tok-super").then(json))).toHaveLength(3);
    expect((await file(portfolio.id, "tok-super")).status).toBe(200);
  });

  it("removes a deleted draft's files", async () => {
    await call("/profile", "tok-maya");
    await identityCheck(identity, "tok-maya");
    await post(`/applicants/${MAYA}/identity/approve`, {});
    const draft = (await json(await post("/applications/save", { grantId: "creative", application: input }, "tok-maya"))).application;
    await upload("tok-maya", `purpose=application&applicationId=${draft.id}&requirement=${encodeURIComponent("Portfolio link")}`);
    expect(files.files.size).toBe(2);
    expect((await post(`/applications/${draft.id}/delete`, {}, "tok-maya")).status).toBe(200);
    expect((await mineDocs()).map((d: { purpose: string }) => d.purpose)).toEqual(["identity"]);
    expect(files.files.size).toBe(1);
  });
});

describe("email", () => {
  const MAYA = USERS["tok-maya"]!.id;
  const input = { businessName: "Okafor Studio", requestedAmount: 4000, registrationNumber: "", purpose: "A kiln and a year of glaze materials for the studio.", checklist: ["Portfolio link", "Project budget", "Professional reference"], answers: {} };

  it("queues an email copy of each notification, in the same write, unless the applicant turned them off", async () => {
    await call("/profile", "tok-maya");
    await identityCheck({ documentType: "Passport", documentNumber: "AB12345678", nameOnDocument: "Maya Okafor" }, "tok-maya");
    await post(`/applicants/${MAYA}/identity/approve`, {});
    const copy = outbox.rows.find(r => r.subject === "Identity verified")!;
    expect(copy).toMatchObject({ kind: "notification", to: "maya@example.com", status: "queued" });
    expect(copy.text).toContain("Hello Maya Okafor,");
    expect(copy.html).toContain("https://app.example.org/");
    expect((await json(await call("/profile/email-preference", "tok-maya"))).enabled).toBe(true);
    expect((await put("/profile/email-preference", { enabled: "no" }, "tok-maya")).status).toBe(400);
    expect((await json(await put("/profile/email-preference", { enabled: false }, "tok-maya"))).enabled).toBe(false);
    const before = outbox.rows.length;
    await submitApp({ grantId: "creative", application: input }, "tok-maya");
    const { application } = { application: (await json(await call("/applications", "tok-super")))[0] };
    await post(`/applications/${application.id}/start-review`, { version: application.updatedAt });
    expect((await json(await call("/notifications", "tok-maya")))[0].title).toMatch(/under review/);
    expect(outbox.rows.length).toBe(before);
  });

  it("emails the applicant about their own actions: deposits, payouts, applications, identity, cards, and password changes", async () => {
    await call("/profile", "tok-maya");
    const subjects = () => outbox.rows.filter(r => r.to === "maya@example.com").map(r => r.subject);
    await post("/money/deposits", { amount: 300, method: "bank" }, "tok-maya");
    expect(subjects()).toContain("Deposit pending");
    await identityCheck({ documentType: "Passport", documentNumber: "AB12345678", nameOnDocument: "Maya Okafor" }, "tok-maya");
    expect(subjects()).toContain("Identity check in progress");
    await post("/money/cards/virtual", {}, "tok-maya");
    expect(subjects()).toContain("Virtual card created");
    await post("/money/cards/freeze", {}, "tok-maya");
    expect(subjects()).toContain("Virtual card frozen");
    await post("/money/cards/freeze", {}, "tok-maya");
    expect(subjects()).toContain("Virtual card unfrozen");
    await post("/money/cards/limit", { card: "virtual", limit: 400 }, "tok-maya");
    expect(subjects()).toContain("Virtual card spending limit lowered");
    await post(`/applicants/${MAYA}/identity/approve`, {});
    await submitApp({ grantId: "creative", application: input }, "tok-maya");
    expect(subjects()).toContain("Creative Practice application received");
    // Security notices go out even with email copies turned off.
    await put("/profile/email-preference", { enabled: false }, "tok-maya");
    const before = outbox.rows.length;
    await post("/money/cards/freeze", {}, "tok-maya");
    expect(outbox.rows.length).toBe(before);
    expect((await post("/profile/password-changed", {}, "tok-maya")).status).toBe(200);
    expect(outbox.rows.at(-1)).toMatchObject({ subject: "Password changed", to: "maya@example.com" });
    expect((await json(await call("/notifications", "tok-maya")))[0].title).toBe("Password changed");
  });

  it("alerts on sign-ins: applicants in the app every time and by email for a new device; staff by email for a new device", async () => {
    const DEVICE = "0f5c2b8e-1d4a-4c7e-9b3a-6e2f8d1c4a55";
    const signIn = (token: string, deviceId: string) => call("/sign-ins", token, { method: "POST", body: JSON.stringify({ deviceId }), headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" } });
    expect((await signIn("tok-maya", "short")).status).toBe(400);
    await put("/profile/email-preference", { enabled: false }, "tok-maya");
    expect(await json(await signIn("tok-maya", DEVICE))).toEqual({ recorded: true, newDevice: true });
    const first = outbox.rows.filter(r => r.to === "maya@example.com" && r.subject === "New device signed in");
    expect(first).toHaveLength(1); // sent even with email copies off
    expect(first[0]!.text).toContain("Chrome on Windows");
    expect(await json(await signIn("tok-maya", DEVICE))).toEqual({ recorded: true, newDevice: false });
    const notes = (await json(await call("/notifications", "tok-maya"))).map((n: { title: string }) => n.title);
    expect(notes.slice(0, 2)).toEqual(["Signed in", "New device signed in"]);
    expect(outbox.rows.filter(r => r.to === "maya@example.com" && /sign/i.test(r.subject))).toHaveLength(1);

    expect(await json(await signIn("tok-super", DEVICE))).toEqual({ recorded: true, newDevice: true });
    expect(outbox.rows.at(-1)).toMatchObject({ kind: "security", to: "sam@example.org", subject: expect.stringContaining("staff account") });
    const count = outbox.rows.length;
    await signIn("tok-super", DEVICE);
    expect(outbox.rows.length).toBe(count);
    // The same browser id on another account is a new device there (ids are hashed per account).
    expect((await json(await signIn("tok-applicant", DEVICE))).newDevice).toBe(true);
  });

  it("emails new staff members how to sign in", async () => {
    await post("/staff", { email: "Casey@Example.org", name: "Casey <b>Brooks</b>", role: "reviewer" });
    const invite = outbox.rows.find(r => r.kind === "staff-invite")!;
    expect(invite).toMatchObject({ to: "casey@example.org", subject: expect.stringMatching(/grant team/) });
    expect(invite.text).toContain("Sam Rivera added you to the arc.fund grant team as Grant reviewer");
    expect(invite.html).toContain("Casey &lt;b&gt;Brooks&lt;/b&gt;");
    expect(invite.html).not.toContain("<b>Brooks");
  });

  it("shows delivery status to super admins only", async () => {
    await post("/staff", { email: "casey@example.org", name: "Casey Brooks", role: "reviewer" });
    expect((await call("/email/status", "tok-finance")).status).toBe(403);
    const status = await json(await call("/email/status", "tok-super"));
    expect(status).toMatchObject({ configured: false, from: null, counts: { queued: 1 } });
    expect(status.recent[0]).toMatchObject({ kind: "staff-invite", to: "casey@example.org", status: "queued" });
    expect(status.recent[0].html).toBeUndefined();
  });
});

describe("email delivery", () => {
  const email = { kind: "notification" as const, to: "maya@example.com", subject: "Hi", text: "t", html: "<p>h</p>" };
  const fakeResend = (responses: { status: number; body: unknown }[]) => {
    const calls: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const impl = (async (_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      const next = responses.shift()!;
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { calls, impl };
  };

  it("marks mail skipped when email isn't configured, so turning it on later sends no backlog", async () => {
    const box = memoryOutbox(); box.enqueue([email]);
    await deliverBatch(box, unconfiguredMailer, new Date());
    expect(box.rows[0]).toMatchObject({ status: "skipped", lastError: expect.stringMatching(/configured/) });
  });

  it("sends through Resend with an idempotency key per outbox row", async () => {
    const box = memoryOutbox(); box.enqueue([email]);
    const resend = fakeResend([{ status: 200, body: { id: "re_123" } }]);
    await deliverBatch(box, resendMailer("re_key", "arc.fund <grants@example.org>", undefined, resend.impl), new Date());
    expect(box.rows[0]).toMatchObject({ status: "sent", providerId: "re_123" });
    expect(resend.calls[0]!.headers).toMatchObject({ authorization: "Bearer re_key", "idempotency-key": "email-1" });
    expect(resend.calls[0]!.body).toMatchObject({ from: "arc.fund <grants@example.org>", to: ["maya@example.com"], subject: "Hi" });
  });

  it("retries rate limits and server errors with backoff, and gives up on bad requests and after the last retry", async () => {
    const box = memoryOutbox(); box.enqueue([email, { ...email, to: "not-an-address" }]);
    const resend = fakeResend([{ status: 500, body: { message: "down" } }, { status: 422, body: { message: "Invalid `to` field" } }]);
    const mailer = resendMailer("k", "a@example.org", undefined, resend.impl);
    const t0 = new Date("2026-09-26T12:00:00Z");
    await deliverBatch(box, mailer, t0);
    expect(box.rows[0]).toMatchObject({ status: "queued", attempts: 1, nextAttemptAt: t0.getTime() + RETRY_MINUTES[0]! * 60_000 });
    expect(box.rows[1]).toMatchObject({ status: "failed", lastError: expect.stringContaining("422") });
    expect(await deliverBatch(box, mailer, t0)).toBe(0);
    let at = t0.getTime();
    const failing = resendMailer("k", "a@example.org", undefined, (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch);
    for (let i = 0; i < RETRY_MINUTES.length; i++) { at = box.rows[0]!.nextAttemptAt; await deliverBatch(box, failing, new Date(at)); }
    expect(box.rows[0]).toMatchObject({ status: "failed", attempts: RETRY_MINUTES.length + 1 });
  });
});

describe("protections", () => {
  const restart = async (limits: ApiDeps["limits"]) => { await new Promise(r => server.close(r)); await start(verifier, limits); };

  it("sends security headers and never caches API responses", async () => {
    const res = await call("/me", "tok-super");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("limits each user's requests and changes, without affecting other users", async () => {
    await restart({ writes: { name: "writes", max: 2, windowMs: 60_000 } });
    await call("/profile", "tok-maya");
    const read = (await post("/notifications/read-all", {}, "tok-maya"));
    expect(read.status).toBe(200);
    expect(read.headers.get("ratelimit-remaining")).toBe("1");
    expect((await post("/notifications/read-all", {}, "tok-maya")).status).toBe(200);
    const limited = await post("/notifications/read-all", {}, "tok-maya");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await call("/notifications", "tok-maya")).status).toBe(200);
    expect((await post("/notifications/read-all", {}, "tok-applicant")).status).toBe(200);
  });

  it("slows down repeated failed sign-ins from one address, but not signed-in use", async () => {
    await restart({ anonymous: { name: "anonymous", max: 3, windowMs: 60_000 } });
    for (let i = 0; i < 5; i++) expect((await call("/me", "tok-super")).status).toBe(200);
    // Requests without any token (pages loading before sign-in) don't count.
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/me`)).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await call("/me", "tok-guess")).status).toBe(401);
    expect((await call("/me", "tok-guess")).status).toBe(429);
    expect((await call("/healthz")).status).toBe(200);
  });

  it("limits uploads per user", async () => {
    await restart({ uploads: { name: "uploads", max: 2, windowMs: 60_000 } });
    await call("/profile", "tok-maya");
    expect((await upload("tok-maya", "purpose=identity")).status).toBe(201);
    expect((await upload("tok-maya", "purpose=identity")).status).toBe(201);
    expect((await upload("tok-maya", "purpose=identity")).status).toBe(429);
  });
});

describe("two-step sign-in", () => {
  it("lets staff see who they are, but nothing else, until they sign in with a code", async () => {
    const me = await json(await call("/me", "tok-super-password-only"));
    expect(me).toMatchObject({ staff: { email: "sam@example.org" }, permissions: [], twoStep: { level: "aal1", enrolled: false, requiredForStaff: true } });
    const res = await call("/applications", "tok-super-password-only");
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("mfa_enrollment_required");
    expect((await json(await call("/applicants", "tok-finance-code-needed"))).code).toBe("mfa_required");
    expect((await call("/applications", "tok-super")).status).toBe(200);
  });

  it("doesn't let a staff session without two-step open documents as staff", async () => {
    await call("/profile", "tok-maya");
    const doc = await json(await upload("tok-maya", "purpose=identity"));
    expect((await call(`/documents/${doc.id}/file`, "tok-super-password-only")).status).toBe(404);
    expect((await call(`/documents/${doc.id}/file`, "tok-super")).status).toBe(200);
  });

  it("requires a code on every request once someone has set up two-step sign-in", async () => {
    await call("/profile", "tok-maya");
    const res = await call("/profile", "tok-maya-code-needed");
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("mfa_required");
    expect((await json(await call("/me", "tok-maya-code-needed"))).twoStep).toMatchObject({ level: "aal1", enrolled: true });
    expect((await call("/profile", "tok-maya-old-factor")).status).toBe(200);
  });

  it("can be switched off for staff (STAFF_MFA_REQUIRED=false)", async () => {
    await new Promise(r => server.close(r));
    server = createApp({ verifier, staffRepo: repo, programRepo: programs, profileRepo: profiles, applicationRepo: applications, activityRepo: activity, moneyRepo: money, documentRepo: documents, fileStore: files, emailOutbox: outbox, emailSettings, inbox, signIns: memorySignInRepo(activity), fetchImpl: providerFetch, staffMfa: false }, ["https://app.example.org"]).listen(0);
    await new Promise(r => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    expect((await call("/applications", "tok-super-password-only")).status).toBe(200);
  });
});

describe("email settings, domain, sign-up confirmation, webhook, and inbox", () => {
  const KEY = "re_test_1234567890abcd";
  const SECRET = `whsec_${Buffer.from("a-very-secret-signing-key-32byte").toString("base64")}`;
  const TOKEN = "sbp_0123456789abcdef0123456789abcdef";
  const sign = (body: string, id = "msg_1", ts = Math.floor(Date.now() / 1000)) => ({
    "svix-id": id, "svix-timestamp": String(ts),
    "svix-signature": `v1,${createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`,
  });
  const hook = (event: unknown, headers?: Record<string, string>) => {
    const body = JSON.stringify(event);
    return fetch(`${base}/email/webhook`, { method: "POST", body, headers: { "content-type": "application/json", ...(headers ?? sign(body)) } });
  };
  const configure = async () => {
    providerReplies["GET /domains"] = { status: 200, body: { data: [] } };
    return put("/email/settings", { resendKey: KEY, fromAddress: "Nova Bridge <grants@novabridgegrant.org>", inboxAddress: "info@novabridgegrant.org", webhookSecret: SECRET, appUrl: "https://app.example.org" });
  };

  it("lets only super admins save settings, checks the key with Resend, and never returns secrets", async () => {
    expect((await call("/email/settings", "tok-finance")).status).toBe(403);
    const bad = await put("/email/settings", { resendKey: "sk_live_nope", fromAddress: "not an address" });
    expect((await json(bad)).fieldErrors).toMatchObject({ resendKey: expect.any(String), fromAddress: expect.any(String) });
    providerReplies["GET /domains"] = { status: 401, body: { message: "API key is invalid" } };
    expect((await put("/email/settings", { resendKey: KEY })).status).toBe(400);
    const saved = await json(await configure());
    expect(saved).toMatchObject({ resendKey: { set: true, last4: "abcd", source: "settings" }, from: "Nova Bridge <grants@novabridgegrant.org>", sending: true, webhook: { url: "https://app.example.org/api/email/webhook", secretSet: true } });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect((await json(await call("/email/status", "tok-super"))).configured).toBe(true);
    const [entry] = (await json(await call("/audit", "tok-super"))).events;
    expect(entry).toMatchObject({ action: "Change email settings" });
    expect(JSON.stringify(entry)).not.toContain(KEY);
    expect((await json(await put("/email/settings", { resendKey: "" }))).resendKey.set).toBe(false);
  });

  it("switches sign-up email confirmation through the Supabase Management API", async () => {
    process.env["SUPABASE_URL"] ??= "https://tynjqjukramcmtotgfdw.supabase.co";
    const ref = /^https:\/\/([a-z0-9]+)\./.exec(process.env["SUPABASE_URL"]!)![1];
    expect((await put("/email/auth-settings", { emailConfirmation: false })).status).toBe(400);
    providerReplies[`GET /v1/projects/${ref}/config/auth`] = { status: 200, body: { mailer_autoconfirm: false } };
    expect((await json(await put("/email/settings", { supabaseToken: "sb_secret_0123456789abcdefghij" }))).fieldErrors.supabaseToken).toMatch(/project API key/);
    expect((await put("/email/settings", { supabaseToken: "has spaces in it 0123456789" })).status).toBe(400);
    expect((await put("/email/settings", { supabaseToken: TOKEN })).status).toBe(200);
    expect(await json(await call("/email/auth-settings", "tok-super"))).toMatchObject({ connected: true, emailConfirmation: true, hook: { enabled: false, supabaseUrl: null } });
    providerReplies[`PATCH /v1/projects/${ref}/config/auth`] = { status: 200, body: { mailer_autoconfirm: true } };
    expect(await json(await put("/email/auth-settings", { emailConfirmation: false }))).toMatchObject({ connected: true, emailConfirmation: false });
    const patchCall = providerCalls.find(c => c.method === "PATCH")!;
    expect(patchCall.body).toEqual({ mailer_autoconfirm: true });
    expect(patchCall.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect((await put("/email/auth-settings", { emailConfirmation: true }, "tok-finance")).status).toBe(403);
  });

  it("lets super admins rename the app for everyone, including emails and sign-in pages", async () => {
    const anon = await fetch(`${base}/branding`);
    expect(anon.status).toBe(200);
    expect(await json(anon)).toEqual({ appName: "arc.fund", isDefault: true, brandColor: null, emailColor: null, logoUrl: null, logoDarkUrl: null, faviconUrl: null });
    expect((await put("/branding", { appName: "Nova Bridge" }, "tok-finance")).status).toBe(403);
    expect((await put("/branding", { appName: "<b>Nova</b>" })).status).toBe(400);
    expect((await put("/branding", { appName: "x".repeat(41) })).status).toBe(400);
    expect(await json(await put("/branding", { appName: "  Nova   Bridge " }))).toMatchObject({ appName: "Nova Bridge", isDefault: false });
    expect(await json(await fetch(`${base}/branding`))).toMatchObject({ appName: "Nova Bridge", isDefault: false });
    const [entry] = (await json(await call("/audit", "tok-super"))).events;
    expect(entry).toMatchObject({ action: "Change application name" });
    const invite = staffInviteEmail({ email: "a@example.org", name: "A", roleLabel: "Finance" }, "Super", null);
    expect(invite.subject).toBe("You've been added to the Nova Bridge grant team");
    expect(invite.html).toContain(">Nova Bridge</div>");
    expect(hookEmails({ user: { email: "a@example.org" }, email_data: { email_action_type: "signup", token_hash: "h" } }, "https://ref.supabase.co")[0]!.subject).toBe("Confirm your Nova Bridge email");
    expect(await json(await put("/branding", { appName: "" }))).toMatchObject({ appName: "arc.fund", isDefault: true });
    expect(staffInviteEmail({ email: "a@example.org", name: "A", roleLabel: "Finance" }, "Super", null).subject).toContain("arc.fund");
  });

  describe("brand colours, logos, and favicon", () => {
    const LOGO = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
    const putImage = (path: string, bytes: Buffer, token = "tok-super") => fetch(`${base}${path}`, { method: "PUT", body: new Uint8Array(bytes), headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" } });
    const savedAppUrl = process.env["APP_URL"];
    beforeEach(() => { process.env["APP_URL"] = "https://grants.example.org"; });
    afterEach(async () => {
      if (savedAppUrl === undefined) delete process.env["APP_URL"]; else process.env["APP_URL"] = savedAppUrl;
      // Emails read the branding from module state, so leave the defaults for the other tests.
      await put("/branding/colors", { brandColor: null, emailColor: null });
      for (const path of ["/branding/logo", "/branding/logo-dark", "/branding/favicon"]) await post(`${path}/delete`, {});
    });

    it("lets super admins set the app and email colours for everyone, validated and audited", async () => {
      expect((await put("/branding/colors", { brandColor: "#123456" }, "tok-finance")).status).toBe(403);
      const bad = await put("/branding/colors", { brandColor: "red", emailColor: "#12345" });
      expect(bad.status).toBe(400);
      expect(Object.keys((await json(bad)).fieldErrors).sort()).toEqual(["brandColor", "emailColor"]);
      expect((await put("/branding/colors", {})).status).toBe(400);
      expect(await json(await put("/branding/colors", { brandColor: "#1d4ed8" }))).toMatchObject({ brandColor: "#1D4ED8", emailColor: null });
      // Only the colours sent change.
      expect(await json(await put("/branding/colors", { emailColor: "#0F766E" }))).toMatchObject({ brandColor: "#1D4ED8", emailColor: "#0F766E" });
      expect(await json(await fetch(`${base}/branding`))).toMatchObject({ brandColor: "#1D4ED8", emailColor: "#0F766E" });
      const [entry] = (await json(await call("/audit", "tok-super"))).events;
      expect(entry).toMatchObject({ action: "Change brand colours", changes: [{ field: "Email colour", before: "#1D1D1B (default)", after: "#0F766E" }] });
      // The email colour is the top bar and button; light colours get dark text.
      const light = staffInviteEmail({ email: "a@example.org", name: "A", roleLabel: "Finance" }, "Super", "https://grants.example.org");
      expect(light.html).toContain("border-top:6px solid #0F766E");
      expect(light.html).toContain("background:#0F766E;color:#FFFFFF");
      await put("/branding/colors", { emailColor: "#C9F35B" });
      expect(staffInviteEmail({ email: "a@example.org", name: "A", roleLabel: "Finance" }, "Super", "https://grants.example.org").html).toContain("background:#C9F35B;color:#1D2330");
      expect(await json(await put("/branding/colors", { brandColor: "", emailColor: null }))).toMatchObject({ brandColor: null, emailColor: null });
    });

    it("stores the logo, dark logo, and favicon on disk, serves them publicly, puts the logo in emails, and removes them", async () => {
      expect((await putImage("/branding/logo", LOGO, "tok-finance")).status).toBe(403);
      expect((await putImage("/branding/logo", Buffer.from("not an image"))).status).toBe(415);
      expect((await putImage("/branding/favicon", Buffer.concat([LOGO, Buffer.alloc(1024 * 1024)]))).status).toBe(413);
      expect((await putImage("/branding/logo", Buffer.concat([LOGO, Buffer.from("<script>alert(1)</script>")]))).status).toBe(422);
      const saved = await json(await putImage("/branding/logo", LOGO));
      expect(saved.logoUrl).toMatch(/^\/api\/branding\/logo\?v=[0-9a-f]{12}$/);
      expect(saved.logoDarkUrl).toBeNull();
      const anon = await fetch(`${base}/branding/logo`);
      expect(anon.status).toBe(200);
      expect(anon.headers.get("content-type")).toBe("image/png");
      expect(anon.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
      expect(Buffer.from(await anon.arrayBuffer()).equals(LOGO)).toBe(true);
      expect((await json(await putImage("/branding/logo-dark", WEBP))).logoDarkUrl).toMatch(/^\/api\/branding\/logo-dark\?v=/);
      expect((await json(await putImage("/branding/favicon", LOGO))).faviconUrl).toMatch(/^\/api\/branding\/favicon\?v=/);
      expect((await fetch(`${base}/branding/logo-dark`)).headers.get("content-type")).toBe("image/webp");
      // Emails show the (light-background) logo from the portal's address instead of the name.
      const invite = staffInviteEmail({ email: "a@example.org", name: "A", roleLabel: "Finance" }, "Super", "https://grants.example.org");
      expect(invite.html).toContain(`<img src="${appUrl()}${saved.logoUrl}" alt="arc.fund"`);
      const preview = await json(await post("/branding/email-preview", { emailColor: "#7c3aed" }));
      expect(preview).toMatchObject({ logoShown: true });
      expect(preview.html).toContain("border-top:6px solid #7C3AED");
      expect(preview.html).toContain(saved.logoUrl);
      expect((await post("/branding/email-preview", { emailColor: "purple" })).status).toBe(400);
      expect((await post("/branding/email-preview", {}, "tok-finance")).status).toBe(403);
      // Replacing keeps one file; removing goes back to the name.
      const replaced = await json(await putImage("/branding/logo", JPEG));
      expect(replaced.logoUrl).not.toBe(saved.logoUrl);
      expect(files.files.size).toBe(3);
      expect(await json(await post("/branding/logo/delete", {}))).toMatchObject({ logoUrl: null });
      expect((await fetch(`${base}/branding/logo`)).status).toBe(404);
      expect((await post("/branding/logo/delete", {})).status).toBe(404);
      expect(staffInviteEmail({ email: "a@example.org", name: "A", roleLabel: "Finance" }, "Super", null).html).not.toContain("<img");
      const actions = (await json(await call("/audit", "tok-super"))).events.map((e: { action: string }) => e.action);
      expect(actions).toEqual(expect.arrayContaining(["Change logo", "Change logo for dark backgrounds", "Change favicon", "Remove logo"]));
    });
  });

  it("shows whether sign-in emails go through the Send Email Hook and Resend", async () => {
    process.env["SUPABASE_URL"] ??= "https://tynjqjukramcmtotgfdw.supabase.co";
    const ref = /^https:\/\/([a-z0-9]+)\./.exec(process.env["SUPABASE_URL"]!)![1];
    const saved = process.env["SUPABASE_EMAIL_HOOK_SECRET"];
    delete process.env["SUPABASE_EMAIL_HOOK_SECRET"];
    // Without a token: the server's side only; Supabase's side is unknown.
    expect(await json(await call("/email/auth-settings", "tok-super"))).toMatchObject({ connected: false, emailConfirmation: null, hook: { secretSet: false, sending: false, enabled: null, supabaseUrl: null } });
    await configure();
    process.env["SUPABASE_EMAIL_HOOK_SECRET"] = "v1,whsec_c2VjcmV0";
    providerReplies[`GET /v1/projects/${ref}/config/auth`] = { status: 200, body: { mailer_autoconfirm: false, hook_send_email_enabled: true, hook_send_email_uri: "https://app.example.org/api/auth/email-hook" } };
    expect((await put("/email/settings", { supabaseToken: TOKEN })).status).toBe(200);
    expect((await json(await call("/email/auth-settings", "tok-super"))).hook).toEqual({ url: "https://app.example.org/api/auth/email-hook", secretSet: true, sending: true, enabled: true, supabaseUrl: "https://app.example.org/api/auth/email-hook" });
    expect((await call("/email/auth-settings", "tok-finance")).status).toBe(403);
    if (saved === undefined) delete process.env["SUPABASE_EMAIL_HOOK_SECRET"]; else process.env["SUPABASE_EMAIL_HOOK_SECRET"] = saved;
  });

  it("adds the sending and receiving domain in Resend and shows its DNS records", async () => {
    await configure();
    providerReplies["POST /domains"] = { status: 200, body: { id: "dom_1", name: "novabridgegrant.org", status: "not_started" } };
    providerReplies["GET /domains/dom_1"] = { status: 200, body: { id: "dom_1", name: "novabridgegrant.org", status: "pending", records: [{ record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=abc", status: "pending" }] } };
    expect((await post("/email/domain", { name: "not a domain" })).status).toBe(400);
    const domain = await json(await post("/email/domain", { name: "NovaBridgeGrant.org", receiving: true }));
    expect(domain.records[0]).toMatchObject({ type: "TXT", name: "resend._domainkey" });
    expect(providerCalls.find(c => c.method === "POST" && c.url.endsWith("/domains"))!.body).toMatchObject({ name: "novabridgegrant.org", capabilities: { receiving: "enabled" } });
    expect((await json(await call("/email/settings", "tok-super"))).domain).toEqual({ name: "novabridgegrant.org", id: "dom_1" });
  });

  it("accepts only signed webhooks, stores received mail once, and records delivery results", async () => {
    const received = { type: "email.received", data: { email_id: "in_1", from: "Maya <maya@example.com>", to: ["info@novabridgegrant.org"], subject: "Question", created_at: "2026-09-26T10:00:00Z", attachments: [] } };
    expect((await hook(received)).status).toBe(503);
    await configure();
    expect((await hook(received, { "svix-id": "x", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,AAAA" })).status).toBe(401);
    const old = JSON.stringify(received);
    expect((await hook(received, sign(old, "msg_1", Math.floor(Date.now() / 1000) - 3600))).status).toBe(401);
    providerReplies["GET /emails/receiving/in_1"] = { status: 200, body: { id: "in_1", from: "Maya <maya@example.com>", to: ["info@novabridgegrant.org"], subject: "Question", html: "<p>Hello <script>x</script></p>", text: "Hello", created_at: "2026-09-26T10:00:00Z", message_id: "<m1@example.com>", attachments: [{ id: "a1", filename: "plan.pdf", content_type: "application/pdf", size: 1200 }] } };
    expect((await hook(received)).status).toBe(200);
    expect((await hook(received, sign(JSON.stringify(received), "msg_2"))).status).toBe(200);
    const box = await json(await call("/inbox", "tok-finance"));
    expect(box).toMatchObject({ address: "info@novabridgegrant.org", receiving: true, sending: true, unread: 1 });
    expect(box.messages).toHaveLength(1);
    expect(box.messages[0]).toMatchObject({ from: "Maya <maya@example.com>", subject: "Question", text: "Hello", messageId: "<m1@example.com>", attachments: [{ filename: "plan.pdf", size: 1200 }] });
    expect((await call("/inbox", "tok-applicant")).status).toBe(403);
  });

  it("sends and replies from the team mailbox through Resend, and audits it", async () => {
    await configure();
    providerReplies["GET /emails/receiving/in_2"] = { status: 200, body: { id: "in_2", from: "maya@example.com", to: ["info@novabridgegrant.org"], subject: "Budget", html: null, text: "Is equipment eligible?", created_at: "2026-09-26T10:00:00Z", message_id: "<m2@example.com>" } };
    await hook({ type: "email.received", data: { email_id: "in_2" } });
    const [original] = (await json(await call("/inbox", "tok-super"))).messages;
    expect((await post("/inbox/send", { to: "nope", subject: "", text: "" })).status).toBe(400);
    providerReplies["POST /emails"] = { status: 200, body: { id: "out_1" } };
    const sent = await post("/inbox/send", { to: "maya@example.com", subject: "Re: Budget", text: "Yes, it is.\n\nThanks", inReplyTo: original.id });
    expect(sent.status).toBe(201);
    const request = providerCalls.find(c => c.method === "POST" && c.url.endsWith("/emails"))!;
    expect(request.body).toMatchObject({ from: "Nova Bridge <info@novabridgegrant.org>", to: ["maya@example.com"], reply_to: "info@novabridgegrant.org", headers: { "In-Reply-To": "<m2@example.com>" } });
    const sentBox = (await json(await call("/inbox?folder=sent", "tok-super"))).messages;
    expect(sentBox[0]).toMatchObject({ direction: "outbound", status: "sent", sentBy: "Sam Rivera", inReplyTo: original.id });
    await hook({ type: "email.delivered", data: { email_id: "out_1" } }, sign(JSON.stringify({ type: "email.delivered", data: { email_id: "out_1" } }), "msg_9"));
    expect((await json(await call("/inbox?folder=sent", "tok-super"))).messages[0].status).toBe("delivered");
    expect((await json(await call("/inbox", "tok-super"))).unread).toBe(0);
    expect((await json(await call("/audit", "tok-super"))).events.map((e: { action: string }) => e.action)).toContain("Send email");
    expect((await post(`/inbox/${original.id}/update`, { folder: "archive" })).status).toBe(200);
    expect((await json(await call("/inbox?folder=archive", "tok-super"))).messages).toHaveLength(1);
  });
});

describe("Supabase's Send Email Hook", () => {
  const HOOK_SECRET = `v1,whsec_${Buffer.from("another-secret-signing-key-32byt").toString("base64")}`;
  const sign = (body: string, id = "hook_1", ts = Math.floor(Date.now() / 1000)) => ({
    "webhook-id": id, "webhook-timestamp": String(ts),
    "webhook-signature": `v1,${createHmac("sha256", Buffer.from(HOOK_SECRET.slice(9), "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`,
  });
  const send = (payload: unknown, headers?: Record<string, string>) => {
    const body = JSON.stringify(payload);
    return fetch(`${base}/auth/email-hook`, { method: "POST", body, headers: { "content-type": "application/json", ...(headers ?? sign(body)) } });
  };
  const signup = { user: { email: "maya@example.com" }, email_data: { token: "123456", token_hash: "hash-abc", redirect_to: "https://app.example.org/login", site_url: "https://app.example.org", email_action_type: "signup" } };
  const sentEmails = () => providerCalls.filter(c => c.method === "POST" && c.url.endsWith("/emails")).map(c => ({ ...(c.body as { to: string[]; subject: string; html: string; from: string }), key: c.headers["idempotency-key"] }));
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    for (const k of ["SUPABASE_EMAIL_HOOK_SECRET", "SUPABASE_URL"]) saved[k] = process.env[k];
    process.env["SUPABASE_EMAIL_HOOK_SECRET"] = HOOK_SECRET;
    process.env["SUPABASE_URL"] = "https://abcdefghijklmnop.supabase.co";
    providerReplies["GET /domains"] = { status: 200, body: { data: [] } };
    providerReplies["POST /emails"] = { status: 200, body: { id: "re_sent_1" } };
  });
  afterEach(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const configure = () => put("/email/settings", { resendKey: "re_test_1234567890abcd", fromAddress: "Nova Bridge Grant <noreply@novabridgegrant.org>", replyTo: "info@novabridgegrant.org" });

  it("sends the sign-up confirmation from our sender, with a link to Supabase's verify endpoint", async () => {
    await configure();
    providerCalls = [];
    const res = await send(signup);
    expect(res.status).toBe(200);
    const [email, ...rest] = sentEmails();
    expect(rest).toHaveLength(0);
    expect(email).toMatchObject({ from: "Nova Bridge Grant <noreply@novabridgegrant.org>", to: ["maya@example.com"], reply_to: "info@novabridgegrant.org", subject: "Confirm your arc.fund email", key: "auth-hook_1-0" });
    expect(email!.html).toContain("https://abcdefghijklmnop.supabase.co/auth/v1/verify?token=hash-abc&amp;type=signup&amp;redirect_to=https%3A%2F%2Fapp.example.org%2Flogin");
    expect(email!.html).not.toContain("supabase.io");
  });

  it("refuses unsigned, wrongly signed, and stale calls, and says when sending isn't set up", async () => {
    expect((await send(signup)).status).toBe(503);
    await configure();
    expect((await send(signup, { "webhook-id": "x", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,AAAA" })).status).toBe(401);
    expect((await send(signup, sign(JSON.stringify(signup), "hook_2", Math.floor(Date.now() / 1000) - 3600))).status).toBe(401);
    delete process.env["SUPABASE_EMAIL_HOOK_SECRET"];
    expect(await json(await send(signup))).toEqual({ error: { http_code: 503, message: "The email hook isn't set up on the server." } });
  });

  it("sends a secure email change to both addresses with the right link each, and resets and codes", async () => {
    await configure();
    providerCalls = [];
    const change = { user: { email: "old@example.com", new_email: "new@example.com" }, email_data: { token: "111111", token_hash: "hash-for-new", token_new: "222222", token_hash_new: "hash-for-old", email_action_type: "email_change", site_url: "https://app.example.org" } };
    expect((await send(change)).status).toBe(200);
    const [toOld, toNew] = sentEmails();
    expect(toOld!.to).toEqual(["old@example.com"]);
    expect(toOld!.html).toContain("token=hash-for-old&amp;type=email_change");
    expect(toNew!.to).toEqual(["new@example.com"]);
    expect(toNew!.html).toContain("token=hash-for-new&amp;type=email_change");
    expect(toNew!.html).toContain("from old@example.com to new@example.com");

    providerCalls = [];
    await send({ user: { email: "maya@example.com" }, email_data: { token_hash: "r1", email_action_type: "recovery", site_url: "https://app.example.org" } }, undefined);
    await send({ user: { email: "maya@example.com" }, email_data: { token: "654321", email_action_type: "reauthentication" } });
    const [reset, code] = sentEmails();
    expect(reset).toMatchObject({ subject: "Reset your arc.fund password" });
    expect(reset!.html).toContain("token=r1&amp;type=recovery");
    expect(code!.html).toContain("654321");
  });

  it("answers with an error Supabase shows when Resend fails, and ignores unknown types", async () => {
    await configure();
    providerReplies["POST /emails"] = { status: 500, body: { message: "down" } };
    const res = await send(signup);
    expect(res.status).toBe(502);
    expect(await json(res)).toEqual({ error: { http_code: 502, message: "We couldn't send the email. Try again in a minute." } });
    providerCalls = [];
    expect((await send({ user: { email: "maya@example.com" }, email_data: { email_action_type: "something_new" } })).status).toBe(200);
    expect(sentEmails()).toHaveLength(0);
  });
});

// ---------- Profile center (user_profile_ui_design_operation.md) ----------

const MAYA_ID = "66666666-6666-4666-8666-666666666666";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x40, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(64, 3)]);
const putAvatar = (bytes: Buffer, token = "tok-maya") => fetch(`${base}/profile/avatar`, { method: "PUT", body: bytes, headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" } });
const WINDOWS_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const signInFrom = (token: string, deviceId: string) => call("/sign-ins", token, { method: "POST", body: JSON.stringify({ deviceId }), headers: { "user-agent": WINDOWS_CHROME } });

describe("profile center: avatar", () => {
  it("stores JPEG, PNG, and WEBP photos on the file store, replaces the old file, and serves them to the owner only", async () => {
    expect((await json(await call("/profile", "tok-maya"))).avatarUpdatedAt).toBeNull();
    expect((await call("/profile/avatar", "tok-maya")).status).toBe(404);
    const first = await putAvatar(PNG);
    expect(first.status).toBe(200);
    expect((await json(first)).avatarUpdatedAt).toEqual(expect.any(String));
    expect(files.files.size).toBe(1);
    const photo = await call("/profile/avatar", "tok-maya");
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await photo.arrayBuffer()).equals(PNG)).toBe(true);
    // Another person's token only ever reaches their own (missing) photo.
    expect((await call("/profile/avatar", "tok-applicant")).status).toBe(404);
    for (const bytes of [JPEG, WEBP]) expect((await putAvatar(bytes)).status).toBe(200);
    expect(files.files.size).toBe(1); // the old files were removed
    expect((await call("/profile/avatar", "tok-maya")).headers.get("content-type")).toBe("image/webp");
  });

  it("refuses empty, oversized, and non-image files", async () => {
    expect((await putAvatar(Buffer.alloc(0))).status).toBe(400);
    const pdf = await putAvatar(Buffer.from("%PDF-1.7 not a photo"));
    expect(pdf.status).toBe(415);
    expect((await json(pdf)).error).toMatch(/JPG, PNG, or WEBP/);
    const big = await putAvatar(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]));
    expect(big.status).toBe(413);
    expect((await json(big)).error).toMatch(/5 MB/);
    expect(files.files.size).toBe(0);
  });

  it("checks the stored photo against its SHA-256, and removing it deletes the file", async () => {
    await putAvatar(PNG);
    const [key] = [...files.files.keys()];
    files.files.set(key!, Buffer.from("changed on disk"));
    expect((await call("/profile/avatar", "tok-maya")).status).toBe(404);
    await putAvatar(JPEG);
    const removed = await post("/profile/avatar/delete", {}, "tok-maya");
    expect((await json(removed)).avatarUpdatedAt).toBeNull();
    expect(files.files.size).toBe(0);
    expect((await call("/profile/avatar", "tok-maya")).status).toBe(404);
  });
});

describe("profile center: personal details", () => {
  const details = { name: "Maya Okafor", phone: "+44 20 7946 0000", address: "", displayName: "Maya O", telegram: "@maya_ok", birthDate: "1990-04-02" };
  const save = (body: unknown) => call("/profile", "tok-maya", { method: "PATCH", body: JSON.stringify(body) });

  it("saves the display name, Telegram handle, date of birth, and phone, and keeps the sign-in email", async () => {
    // An email in the body is ignored: it's always the sign-in account's.
    const saved = await json(await save({ ...details, email: "nope@example.com" }));
    expect(saved).toMatchObject({ displayName: "Maya O", telegram: "maya_ok", birthDate: "1990-04-02", phone: "+44 20 7946 0000", email: "maya@example.com" });
    expect(await json(await call("/profile", "tok-maya"))).toMatchObject({ displayName: "Maya O", telegram: "maya_ok" });
    // Empty values clear the optional fields.
    expect(await json(await save({ ...details, telegram: "", birthDate: "", displayName: "" }))).toMatchObject({ telegram: "", displayName: "", birthDate: null });
  });

  it("refuses a bad handle, a phone without a country code, and a future or under-age date of birth, with field errors", async () => {
    const res = await save({ ...details, phone: "020 7946 0000", telegram: "@ab", birthDate: "2099-01-01", displayName: "!" });
    expect(res.status).toBe(400);
    expect(Object.keys((await json(res)).fieldErrors).sort()).toEqual(["birthDate", "displayName", "phone", "telegram"]);
    const young = await save({ ...details, birthDate: `${new Date().getUTCFullYear() - 10}-01-01` });
    expect((await json(young)).fieldErrors.birthDate).toMatch(/at least 16/);
  });

  it("keeps saved profile-center fields when an older portal sends only name, phone, and address", async () => {
    await save(details);
    const saved = await json(await save({ name: "Maya Okafor", phone: "+44 20 7946 0001", address: "" }));
    expect(saved).toMatchObject({ phone: "+44 20 7946 0001", telegram: "maya_ok", displayName: "Maya O", birthDate: "1990-04-02" });
  });
});

describe("profile center: privacy", () => {
  it("defaults both switches on and saves them", async () => {
    expect((await json(await call("/profile", "tok-maya"))).privacy).toEqual({ activityLogging: true, unusualActivityEmail: true });
    expect((await put("/profile/privacy", { activityLogging: "no", unusualActivityEmail: true }, "tok-maya")).status).toBe(400);
    const saved = await json(await put("/profile/privacy", { activityLogging: false, unusualActivityEmail: false }, "tok-maya"));
    expect(saved.privacy).toEqual({ activityLogging: false, unusualActivityEmail: false });
  });

  it("with activity logging off, keeps security events and sign-in notices without device, IP, or location", async () => {
    await put("/profile/privacy", { activityLogging: false, unusualActivityEmail: true }, "tok-maya");
    await signInFrom("tok-maya", "0f5c2b8e-1d4a-4c7e-9b3a-6e2f8d1c4a55");
    const [event] = await json(await call("/profile/security-events", "tok-maya"));
    expect(event).toMatchObject({ kind: "new_device_sign_in", device: null, ip: null, location: null });
    const [note] = await json(await call("/notifications", "tok-maya"));
    expect(note.body).not.toContain("Chrome on Windows");
    // Turned back on, the next event keeps where it came from.
    await put("/profile/privacy", { activityLogging: true, unusualActivityEmail: true }, "tok-maya");
    await signInFrom("tok-maya", "0f5c2b8e-1d4a-4c7e-9b3a-6e2f8d1c4a55");
    const [latest] = await json(await call("/profile/security-events", "tok-maya"));
    expect(latest).toMatchObject({ kind: "sign_in", device: "Chrome on Windows", ip: expect.any(String) });
  });

  it("with unusual-activity email off, a new device makes an in-app notice but no email", async () => {
    await put("/profile/privacy", { activityLogging: true, unusualActivityEmail: false }, "tok-maya");
    await signInFrom("tok-maya", "0f5c2b8e-1d4a-4c7e-9b3a-6e2f8d1c4a55");
    expect(outbox.rows.filter(r => r.to === "maya@example.com" && r.subject === "New device signed in")).toHaveLength(0);
    expect((await json(await call("/notifications", "tok-maya")))[0].title).toBe("New device signed in");
    // Switched back on: the next new device is emailed.
    await put("/profile/privacy", { activityLogging: true, unusualActivityEmail: true }, "tok-maya");
    await signInFrom("tok-maya", "9a9a9a9a-1d4a-4c7e-9b3a-6e2f8d1c4a55");
    expect(outbox.rows.filter(r => r.to === "maya@example.com" && r.subject === "New device signed in")).toHaveLength(1);
  });

  it("reads the location from Cloudflare's headers only when GEO_HEADERS=cloudflare", async () => {
    const { requestLocation } = await import("./lib/securityEvents");
    const req = { get: (h: string) => ({ "cf-ipcity": "Port Harcourt", "cf-ipcountry": "ng" } as Record<string, string>)[h] };
    expect(requestLocation(req, {})).toBeNull();
    expect(requestLocation(req, { GEO_HEADERS: "cloudflare" })).toBe("Port Harcourt, NG");
    expect(requestLocation({ get: (h: string) => h === "cf-ipcountry" ? "XX" : undefined }, { GEO_HEADERS: "cloudflare" })).toBeNull();
  });
});

describe("profile center: security activity", () => {
  it("lists sign-ins and password changes, newest first, only to their owner", async () => {
    await signInFrom("tok-maya", "0f5c2b8e-1d4a-4c7e-9b3a-6e2f8d1c4a55");
    await signInFrom("tok-maya", "0f5c2b8e-1d4a-4c7e-9b3a-6e2f8d1c4a55");
    await post("/profile/password-changed", {}, "tok-maya");
    const kinds = (await json(await call("/profile/security-events", "tok-maya"))).map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(["password_changed", "sign_in", "new_device_sign_in"]);
    expect(await json(await call("/profile/security-events", "tok-applicant"))).toEqual([]);
  });

  it("checks the current password with Supabase from the server, signs that session out, and records a wrong one as a failed attempt", async () => {
    providerReplies["POST /auth/v1/token"] = { status: 200, body: { access_token: "throwaway", refresh_token: "r" } };
    providerReplies["POST /auth/v1/logout"] = { status: 200, body: {} };
    const ok = await post("/profile/check-password", { password: "right-password" }, "tok-maya");
    expect(ok.status).toBe(200);
    const token = providerCalls.find(c => c.url.includes("/auth/v1/token"))!;
    expect(token.url).toBe("https://proj.supabase.co/auth/v1/token?grant_type=password");
    expect(token.body).toEqual({ email: "maya@example.com", password: "right-password" });
    const logout = providerCalls.find(c => c.url.includes("/auth/v1/logout"))!;
    expect(logout.url).toContain("scope=local");
    expect(logout.headers["authorization"]).toBe("Bearer throwaway");

    providerReplies["POST /auth/v1/token"] = { status: 400, body: { error_code: "invalid_credentials" } };
    const wrong = await post("/profile/check-password", { password: "wrong" }, "tok-maya");
    expect(wrong.status).toBe(400);
    expect((await json(wrong)).fieldErrors.currentPassword).toMatch(/isn't your current password/);
    expect((await json(await call("/profile/security-events", "tok-maya")))[0]).toMatchObject({ kind: "failed_password_check" });
    providerReplies["POST /auth/v1/token"] = { status: 429, body: {} };
    expect((await post("/profile/check-password", { password: "x" }, "tok-maya")).status).toBe(429);
    expect((await post("/profile/check-password", {}, "tok-maya")).status).toBe(400);
  });

  it("limits current-password checks per user", async () => {
    await new Promise(r => server.close(r));
    await start(verifier, { passwordChecks: { name: "passwordChecks", max: 2, windowMs: 60_000 } });
    providerReplies["POST /auth/v1/token"] = { status: 400, body: {} };
    for (let i = 0; i < 2; i++) expect((await post("/profile/check-password", { password: "guess" }, "tok-maya")).status).toBe(400);
    expect((await post("/profile/check-password", { password: "guess" }, "tok-maya")).status).toBe(429);
  });

  it("records email changes, two-step changes the account agrees with, and signing out other devices", async () => {
    expect((await json(await post("/profile/security-events", { kind: "signed_out_others" }, "tok-maya"))).recorded).toBe(true);
    expect((await json(await post("/profile/security-events", { kind: "email_change_requested" }, "tok-maya"))).recorded).toBe(true);
    // Maya's plain token has no authenticator, so "two-step on" isn't believed; her two-step session's is.
    expect((await json(await post("/profile/security-events", { kind: "two_step_on" }, "tok-maya"))).recorded).toBe(false);
    expect((await json(await post("/profile/security-events", { kind: "two_step_on" }, "tok-maya-new-factor"))).recorded).toBe(true);
    expect((await json(await post("/profile/security-events", { kind: "two_step_off" }, "tok-maya-new-factor"))).recorded).toBe(false);
    expect((await post("/profile/security-events", { kind: "sign_in" }, "tok-maya")).status).toBe(400);
    // The sign-in email changing at Supabase is noticed on the next request.
    USERS["tok-maya-renamed"] = { ...USERS["tok-maya"]!, email: "maya.new@example.com" };
    try {
      expect((await json(await call("/profile", "tok-maya-renamed"))).email).toBe("maya.new@example.com");
    } finally { delete USERS["tok-maya-renamed"]; }
    const kinds = (await json(await call("/profile/security-events", "tok-maya"))).map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(["email_changed", "two_step_on", "email_change_requested", "signed_out_others"]);
    expect((await json(await call("/notifications", "tok-maya")))[0]).toMatchObject({ title: "Email address changed", href: "/profile" });
  });

  it("puts the verification code in the email-change email", async () => {
    const { hookEmails } = await import("./lib/authEmails");
    const [toOld, toNew] = hookEmails({ user: { email: "old@example.com", new_email: "new@example.com" }, email_data: { token: "111111", token_hash: "h1", token_new: "222222", token_hash_new: "h2", email_action_type: "email_change" } }, "https://proj.supabase.co");
    expect(toOld!.text).toContain("111111");
    expect(toNew!.text).toContain("222222");
  });
});
