import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { AuthUser, TokenVerifier } from "./lib/auth";
import { ensureInitialSuperAdmin, memoryStaffRepo, type StaffRecord, type StaffRepo } from "./lib/staffRepo";

// Tokens in these tests are fake: the stub verifier maps them to users.
const USERS: Record<string, AuthUser> = {
  "tok-super": { id: "11111111-1111-4111-8111-111111111111", email: "sam@example.org", emailConfirmed: true },
  "tok-finance": { id: "22222222-2222-4222-8222-222222222222", email: "jordan@example.org", emailConfirmed: true },
  "tok-applicant": { id: "33333333-3333-4333-8333-333333333333", email: "alex@example.com", emailConfirmed: true },
  "tok-unconfirmed": { id: "44444444-4444-4444-8444-444444444444", email: "riley@example.org", emailConfirmed: false },
  "tok-riley": { id: "55555555-5555-4555-8555-555555555555", email: "riley@example.org", emailConfirmed: true },
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

async function start(v: TokenVerifier | null = verifier) {
  repo = memoryStaffRepo(SEED);
  server = createApp({ verifier: v, staffRepo: repo }, ["https://app.example.org"]).listen(0);
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
