import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelWithdrawal, confirmDeposit, createWithdrawalMethod, deleteWithdrawalMethod, getLedger, getMoneySettings, getMyMoney, requestDeposit, requestWithdrawal,
  setAuthTokenGetter, setBaseUrl, setWithdrawalMethodAvailability, updateWithdrawalMethod, uploadWithdrawalMethodPhoto, type WithdrawalMethodInput,
} from "@workspace/api-client-react";
import { adoptServerMoney, adoptServerSettings, type ServerMoney } from "@workspace/domain/sync";
import { createSeedState, seedGrants, seedTreasury } from "@workspace/domain/seed";
import type { Treasury } from "@workspace/domain/model";
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
import { memoryStaffRepo, type StaffRecord } from "./lib/staffRepo";

// Withdrawal methods' wiring: the portal's own generated client (the functions
// the admin and withdrawal pages call, through the same customFetch) against
// the real API router, so a path, method, body encoding, or response shape
// mismatch between the two sides fails here.

const TWO_STEP = { aal: "aal2" as const, factors: [{ id: "factor-1", createdAt: "2025-01-01T00:00:00.000Z" }] };
const USERS: Record<string, AuthUser> = {
  "tok-finance": { id: "22222222-2222-4222-8222-222222222222", email: "jordan@example.org", emailConfirmed: true, ...TWO_STEP },
  "tok-ada": { id: "77777777-7777-4777-8777-777777777777", email: "ada@example.com", emailConfirmed: true, metadata: { full_name: "Ada Obi", country: "Nigeria", sector: "Agriculture" } },
};
const STAFF: StaffRecord[] = [{ id: "aaaaaaaa-0000-4000-8000-000000000002", email: "jordan@example.org", name: "Jordan Lee", role: "finance", active: true, authUserId: USERS["tok-finance"]!.id }];
const verifier: TokenVerifier = async token => USERS[token] ?? null;

/** A real 1×1 PNG. */
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f3a0e30000000049454e44ae426082", "hex");

let server: Server;
let port = 0;
let token: string | null = null;
let files: ReturnType<typeof memoryFileStore>;
const as = (who: string) => { token = who; };

beforeEach(async () => {
  const outbox = memoryOutbox();
  const activity = memoryActivity({ outbox, recipient: () => undefined });
  const profiles = memoryProfileRepo([], activity);
  const programs = memoryProgramRepo(seedGrants(), activity);
  const money = memoryMoneyRepo(profiles, { treasury: seedTreasury(), lockdown: null }, activity);
  files = memoryFileStore();
  server = createApp({
    verifier, staffRepo: memoryStaffRepo(STAFF, activity), programRepo: programs, profileRepo: profiles,
    applicationRepo: memoryApplicationRepo(programs, [], activity, money), activityRepo: activity, moneyRepo: money,
    documentRepo: memoryDocumentRepo(activity), fileStore: files, emailOutbox: outbox, emailSettings: memoryEmailSettingsRepo(activity),
    inbox: memoryInboxRepo(), signIns: memorySignInRepo(activity),
  }, []).listen(0);
  await new Promise(r => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
  // Exactly how the portal is configured: relative /api/... URLs and a bearer token from the session.
  setBaseUrl(`http://127.0.0.1:${port}`);
  setAuthTokenGetter(() => token);
});
afterEach(async () => {
  setBaseUrl(null); setAuthTokenGetter(null);
  await new Promise(r => server.close(r));
});

const method = (patch: Partial<WithdrawalMethodInput> = {}): WithdrawalMethodInput => ({
  name: "Crypto (USDT)", enabled: true, min: 20, max: 5000, feeRate: 0.01, feeFixed: 1, feeCap: 0, processingTime: "1–24 hours",
  instructions: "TRC-20 only.", photoUrl: "", source: "deposit", formTitle: "Wallet details",
  fields: [
    { label: "Wallet address", type: "text", required: true, placeholder: "T…", help: "", options: [] },
    { label: "Contact email", type: "email", required: true, placeholder: "", help: "", options: [] },
    { label: "Withdrawal note", type: "textarea", required: false, placeholder: "", help: "", options: [] },
  ],
  ...patch,
});

describe("withdrawal wiring: portal client ↔ API", () => {
  it("finance creates, edits, hides, and deletes a method, and the admin page adopts the settings", async () => {
    as("tok-finance");
    const version = (await getMoneySettings()).treasury.updatedAt;
    const created = await createWithdrawalMethod({ version, method: method() });
    expect(created.id).toBe("crypto-usdt");
    const adopted = adoptServerSettings(createSeedState(), { treasury: created.settings.treasury as Treasury, lockdown: created.settings.lockdown ?? null });
    expect(adopted.ok && adopted.state.treasury.channels.find(c => c.id === "crypto-usdt")).toMatchObject({ source: "deposit", formTitle: "Wallet details" });
    const saved = created.settings.treasury.channels.find(c => c.id === "crypto-usdt")!;
    // The admin page sends the fields back with their ids, so edits keep remembered answers matched.
    const edited = await updateWithdrawalMethod("crypto-usdt", { version: created.settings.treasury.updatedAt, method: { ...method({ max: 6000 }), fields: saved.fields } });
    expect(edited.message).toMatch(/saved/);
    const hidden = await setWithdrawalMethodAvailability("crypto-usdt", { enabled: false });
    expect(hidden.settings.treasury.channels.find(c => c.id === "crypto-usdt")!.enabled).toBe(false);
    const stale = await updateWithdrawalMethod("crypto-usdt", { version: created.settings.treasury.updatedAt, method: method() }).then(() => null, (e: { status: number }) => e.status);
    expect(stale).toBe(409);
    const gone = await deleteWithdrawalMethod("crypto-usdt");
    expect(gone.settings.treasury.channels.some(c => c.id === "crypto-usdt")).toBe(false);
  });

  it("uploads a method photo as raw bytes, and the page can load it from the returned address without a token", async () => {
    as("tok-finance");
    const { settings } = await createWithdrawalMethod({ version: (await getMoneySettings()).treasury.updatedAt, method: method() });
    expect(settings.treasury.channels.find(c => c.id === "crypto-usdt")!.photoUrl).toBe("");
    const res = await uploadWithdrawalMethodPhoto("crypto-usdt", new Blob([new Uint8Array(PNG)], { type: "image/png" }));
    const url = res.settings.treasury.channels.find(c => c.id === "crypto-usdt")!.photoUrl;
    expect(url).toMatch(/^\/api\/withdrawal-methods\/crypto-usdt\/photo\?v=/);
    const img = await fetch(`http://127.0.0.1:${port}${url}`);
    expect([img.status, img.headers.get("content-type"), Buffer.from(await img.arrayBuffer()).equals(PNG)]).toEqual([200, "image/png", true]);
  });

  it("the applicant requests with the form and the chosen balance; the withdrawal page adopts the result; finance sees the answers", async () => {
    as("tok-finance");
    await createWithdrawalMethod({ version: (await getMoneySettings()).treasury.updatedAt, method: method({ source: "both" }) });
    as("tok-ada");
    const mine = await getMyMoney();
    expect(mine.treasury.channels.map(c => c.id)).toContain("crypto-usdt");
    expect(mine.savedPayoutDetails).toEqual({});
    const deposit = await requestDeposit({ amount: 200, method: "bank" });
    as("tok-finance");
    await confirmDeposit(deposit.id!);
    as("tok-ada");
    const answers = { "wallet-address": "TXr9ab3kLmN2pQ4sT6vW8yZ1cD5fG7h9jK", "contact-email": "ada@example.com" };
    const refused = await requestWithdrawal({ amount: 50, channel: "crypto-usdt", source: "deposit", details: { "contact-email": "nope" } }).then(() => null, (e: { status: number; data: { fieldErrors?: Record<string, string> } }) => e);
    expect(refused?.status).toBe(400);
    expect(refused?.data.fieldErrors).toEqual({ "details.wallet-address": "Wallet address is required.", "details.contact-email": "Enter a valid email address." });
    const ok = await requestWithdrawal({ amount: 50, channel: "crypto-usdt", source: "deposit", details: answers });
    expect(ok.money.savedPayoutDetails).toEqual({ "crypto-usdt": answers });
    const adopted = adoptServerMoney(createSeedState(), ok.money as unknown as ServerMoney, USERS["tok-ada"]!.id);
    expect(adopted.ok && adopted.state.savedPayoutDetails).toEqual({ "crypto-usdt": answers });
    const w = ok.money.transactions.find(t => t.type === "Withdrawal")!;
    expect(w).toMatchObject({ source: "deposit", amount: -50, fee: 1.5 });
    as("tok-finance");
    expect((await getLedger()).find(t => t.id === w.id)!.payoutDetails!.map(d => d.label)).toEqual(["Wallet address", "Contact email"]);
    as("tok-ada");
    const back = await cancelWithdrawal(w.id);
    expect(back.message).toMatch(/back in your deposit balance/);
  });
});
