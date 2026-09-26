import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { AuthUser, TokenVerifier } from "./lib/auth";
import { seedGrants } from "@workspace/domain/seed";
import { memoryProfileRepo, type ProfileRepo } from "./lib/profileRepo";
import { ensureSeedPrograms, memoryProgramRepo, type ProgramRepo } from "./lib/programRepo";
import { memoryApplicationRepo, type ApplicationRepo } from "./lib/applicationRepo";
import { memoryActivity } from "./lib/activity";
import { memoryMoneyRepo } from "./lib/moneyRepo";
import { seedTreasury } from "@workspace/domain/seed";
import { ensureInitialSuperAdmin, memoryStaffRepo, type StaffRecord, type StaffRepo } from "./lib/staffRepo";

// Tokens in these tests are fake: the stub verifier maps them to users.
const USERS: Record<string, AuthUser> = {
  "tok-super": { id: "11111111-1111-4111-8111-111111111111", email: "sam@example.org", emailConfirmed: true },
  "tok-finance": { id: "22222222-2222-4222-8222-222222222222", email: "jordan@example.org", emailConfirmed: true },
  "tok-applicant": { id: "33333333-3333-4333-8333-333333333333", email: "alex@example.com", emailConfirmed: true },
  "tok-unconfirmed": { id: "44444444-4444-4444-8444-444444444444", email: "riley@example.org", emailConfirmed: false },
  "tok-riley": { id: "55555555-5555-4555-8555-555555555555", email: "riley@example.org", emailConfirmed: true },
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

async function start(v: TokenVerifier | null = verifier) {
  activity = memoryActivity();
  repo = memoryStaffRepo(SEED, activity);
  programs = memoryProgramRepo(seedGrants(), activity);
  profiles = memoryProfileRepo([], activity);
  money = memoryMoneyRepo(profiles, { treasury: seedTreasury(), lockdown: null }, activity);
  applications = memoryApplicationRepo(programs, [], activity, money);
  server = createApp({ verifier: v, staffRepo: repo, programRepo: programs, profileRepo: profiles, applicationRepo: applications, activityRepo: activity, moneyRepo: money }, ["https://app.example.org"]).listen(0);
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
    expect(body).toEqual({ user: USERS["tok-applicant"], staff: null, permissions: [] });
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
  minimumTier: 1, requirements: ["Workshop photos"], requiresRegistration: false, questions: [], ...overrides,
});
const post = (path: string, body: unknown, token = "tok-super") => call(path, token, { method: "POST", body: JSON.stringify(body) });
const put = (path: string, body: unknown, token = "tok-super") => call(path, token, { method: "PUT", body: JSON.stringify(body) });
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
    expect((await json(res)).message).toMatch(/reopened/);
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
    const bad = await call("/profile", "tok-maya", { method: "PATCH", body: JSON.stringify({ name: "M", phone: "12", address: "" }) });
    expect(bad.status).toBe(400);
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
  const maya = async () => json(await call("/profile", "tok-maya"));
  const identity = { documentType: "Passport", documentNumber: "AB 1234-5678", nameOnDocument: "Maya Okafor" };
  beforeEach(async () => { await call("/profile", "tok-maya"); });

  it("starts every applicant active, unverified, and at Tier 1", async () => {
    expect((await maya()).account).toEqual({ status: "Active", passwordResetRequired: false, twoFactorResetRequired: false, kyc: { status: "Not submitted" } });
  });

  it("keeps only the last four characters of the document number", async () => {
    const res = await post("/profile/identity", identity, "tok-maya");
    expect(res.status).toBe(200);
    const { account } = await json(res);
    expect(account.kyc).toMatchObject({ status: "Pending", documentType: "Passport", documentLast4: "5678", nameOnDocument: "Maya Okafor" });
    expect(JSON.stringify(account)).not.toContain("1234");
    expect((await post("/profile/identity", identity, "tok-maya")).status).toBe(400);
  });

  it("lets only kyc.review approve, and marks the applicant verified", async () => {
    await post("/profile/identity", identity, "tok-maya");
    expect((await act("identity/approve", {}, "tok-finance")).status).toBe(403);
    expect((await act("identity/approve", {}, "tok-applicant")).status).toBe(403);
    const res = await act("identity/approve");
    expect(res.status).toBe(200);
    expect((await json(res)).applicant.profile).toMatchObject({ identityVerified: true, account: { kyc: { status: "Verified", reviewedBy: "Sam Rivera" } } });
    expect((await maya()).identityVerified).toBe(true);
  });

  it("needs a reason to reject, and lets the applicant resubmit", async () => {
    await post("/profile/identity", identity, "tok-maya");
    const short = await act("identity/reject", { reason: "No." });
    expect(short.status).toBe(400);
    expect((await json(short)).fieldErrors.reason).toBeDefined();
    expect((await act("identity/reject", { reason: "The name doesn't match the document." })).status).toBe(200);
    expect((await maya()).account.kyc).toMatchObject({ status: "Rejected", rejectionReason: "The name doesn't match the document." });
    expect((await post("/profile/identity", identity, "tok-maya")).status).toBe(200);
  });

  it("asks a verified applicant to verify again", async () => {
    await post("/profile/identity", identity, "tok-maya");
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

  it("records required resets, which the applicant then completes", async () => {
    expect((await act("credential-reset", { kind: "password" })).status).toBe(200);
    expect((await maya()).account.passwordResetRequired).toBe(true);
    expect((await post("/profile/credential-reset", { kind: "password" }, "tok-maya")).status).toBe(200);
    expect((await maya()).account.passwordResetRequired).toBe(false);
    expect((await post("/profile/credential-reset", { kind: "password" }, "tok-maya")).status).toBe(400);
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
    await post("/profile/identity", { documentType: "Passport", documentNumber: "AB12345678", nameOnDocument: "Test Person" }, token);
    await post(`/applicants/${id}/identity/approve`, {});
  };
  const submit = (body: unknown, token = "tok-maya") => post("/applications/submit", body, token);
  const mine = async (token = "tok-maya") => json(await call("/applications/mine", token));
  const queued = async (id: string) => (await json(await call("/applications", "tok-super"))).find((a: { id: string }) => a.id === id);
  const decide = (id: string, path: string, body: Record<string, unknown>, token = "tok-super") => post(`/applications/${id}/${path}`, body, token);

  it("requires a verified identity before applying", async () => {
    await call("/profile", "tok-maya");
    const res = await post("/applications/save", { grantId: "creative", application: creative }, "tok-maya");
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/Identity verification/);
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
    const created = await json(await post("/programs", { name: "Tight Budget", summary: "A program with room for one award.", focus: "Testing", maxFunding: 6000, minimumRequest: 100, budget: 10000, deadline, minimumTier: 1, requirements: ["A plan"], requiresRegistration: false, questions: [] }));
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
      reviewer: null, awardedAmount: null, history: [], internalNotes: [], escalation: null,
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
    await post("/profile/identity", { documentType: "Passport", documentNumber: "AB12345678", nameOnDocument: "Maya Okafor" }, "tok-maya");
    await post(`/applicants/${MAYA}/identity/approve`, {});
  };
  const notes = async (token = "tok-maya") => json(await call("/notifications", token));
  const feed = async (token = "tok-super") => json(await call("/staff-feed", token));

  it("notifies only the applicant concerned, and lets only them mark it read", async () => {
    await verifyMaya();
    const { application } = await json(await post("/applications/submit", { grantId: "creative", application: input }, "tok-maya"));
    const v = (await json(await post(`/applications/${application.id}/start-review`, { version: application.updatedAt }))).application.updatedAt;
    await post(`/applications/${application.id}/approve`, { version: v, award: 3000 });
    const mine = await notes();
    expect(mine.map((n: { title: string }) => n.title)).toEqual(["Creative Practice was approved", "Creative Practice is under review", "Identity verified"]);
    expect(await notes("tok-applicant")).toEqual([]);
    expect((await post(`/notifications/${mine[0].id}/read`, {}, "tok-applicant")).status).toBe(404);
    expect((await post(`/notifications/${mine[0].id}/read`, {}, "tok-maya")).status).toBe(200);
    expect((await notes())[0].read).toBe(true);
    expect((await json(await post("/notifications/read-all", {}, "tok-maya"))).message).toMatch(/2 notifications/);
  });

  it("tells applicants holding drafts when a program closes", async () => {
    await verifyMaya();
    await post("/applications/save", { grantId: "creative", application: input }, "tok-maya");
    await post("/programs/creative/close", { version: (await program("creative")).updatedAt });
    expect((await notes())[0]).toMatchObject({ title: "Creative Practice closed", href: expect.stringMatching(/^\/applications\/APP-/) });
  });

  it("feeds applicant actions to staff, with each person's own read state", async () => {
    await verifyMaya();
    await post("/applications/submit", { grantId: "creative", application: input }, "tok-maya");
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
  /** Maya verified, awarded `award` on Creative Practice, with a confirmed deposit and a saved bank account. */
  const fund = async (award: number, deposited = 100) => {
    await call("/profile", "tok-maya");
    await post("/profile/identity", { documentType: "Passport", documentNumber: "AB12345678", nameOnDocument: "Maya Okafor" }, "tok-maya");
    await post(`/applicants/${MAYA}/identity/approve`, {});
    const { application } = await json(await post("/applications/submit", { grantId: "creative", application: { ...input, requestedAmount: award } }, "tok-maya"));
    const v = (await json(await post(`/applications/${application.id}/start-review`, { version: application.updatedAt }))).application.updatedAt;
    await post(`/applications/${application.id}/approve`, { version: v, award });
    const d = (await json(await deposit(deposited))).money.transactions.find((t: { type: string; status: string }) => t.type === "Deposit" && t.status === "Pending");
    await post(`/money/deposits/${d.id}/confirm`, {}, "tok-finance");
    await post("/money/destinations", { channel: "bank", primary: "Meridian Bank", secondary: "123456789" }, "tok-maya");
  };
  const withdraw = (amount: number) => post("/money/withdrawals", { amount, channel: "bank" }, "tok-maya");

  it("starts with fictional cards and no entries, and hides who changed the settings", async () => {
    const m = await mine();
    expect(m.transactions).toEqual([]);
    expect(m.cards.virtual.lastFour).toMatch(/^\d{4}$/);
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
    expect(w).toMatchObject({ amount: -1000, status: "Pending", destination: "Bank transfer · Meridian Bank · •••• 6789" });
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

  it("lets finance change settings with a version check, and charges the application fee from deposits", async () => {
    const settings = await json(await call("/money/settings", "tok-finance"));
    const { updatedAt, changeLog: _log, ...treasury } = settings.treasury;
    expect((await put("/money/settings", { version: updatedAt, treasury: { ...treasury, applicationFee: 10 } }, "tok-applicant")).status).toBe(403);
    expect((await put("/money/settings", { version: updatedAt, treasury: { ...treasury, applicationFee: 10 } }, "tok-finance")).status).toBe(200);
    expect((await put("/money/settings", { version: updatedAt, treasury: { ...treasury, applicationFee: 20 } }, "tok-finance")).status).toBe(409);
    await call("/profile", "tok-maya");
    await post("/profile/identity", { documentType: "Passport", documentNumber: "AB12345678", nameOnDocument: "Maya Okafor" }, "tok-maya");
    await post(`/applicants/${MAYA}/identity/approve`, {});
    expect((await json(await post("/applications/submit", { grantId: "creative", application: input }, "tok-maya"))).error).toMatch(/application fee/);
    const d = (await json(await deposit(50))).money.transactions[0];
    await post(`/money/deposits/${d.id}/confirm`, {}, "tok-finance");
    expect((await post("/applications/submit", { grantId: "creative", application: input }, "tok-maya")).status).toBe(200);
    expect((await mine()).transactions.find((t: { type: string }) => t.type === "Application fee")).toMatchObject({ amount: -10, id: expect.stringMatching(/^TX-\d+$/) });
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
