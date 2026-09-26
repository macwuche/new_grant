import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { AuthUser, TokenVerifier } from "./lib/auth";
import { seedGrants } from "@workspace/domain/seed";
import { memoryProfileRepo, type ProfileRepo } from "./lib/profileRepo";
import { ensureSeedPrograms, memoryProgramRepo, type ProgramRepo } from "./lib/programRepo";
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

async function start(v: TokenVerifier | null = verifier) {
  repo = memoryStaffRepo(SEED);
  programs = memoryProgramRepo(seedGrants());
  profiles = memoryProfileRepo();
  server = createApp({ verifier: v, staffRepo: repo, programRepo: programs, profileRepo: profiles }, ["https://app.example.org"]).listen(0);
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
