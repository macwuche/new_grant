import { createHash, randomInt, randomUUID } from "node:crypto";
import express, { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import {
  ActivatePhysicalCardBody, AdjustBalanceBody, ApprovePhysicalCardBody, ConfirmDepositParams as LedgerIdParams, DeductFromCardBody, FundCardAsStaffBody, FundCardBody,
  CreateDepositMethodBody, CreateWithdrawalMethodBody, GetDepositProofParams, GetCardHolderParams as ApplicantIdParams, IssuePhysicalCardBody, MarkPayoutFailedBody as ReasonBody, RequestDepositBody,
  RequestPhysicalCardBody, RequestWithdrawalBody, SetCardFreezeAsStaffBody, SetCardLimitBody, SetWithdrawalMethodAvailabilityBody, ToggleCardFreezeBody,
  UpdateMoneySettingsBody, UpdateWithdrawalMethodParams as MethodIdParams,
} from "@workspace/api-zod";
import {
  activatePhysicalCard, approvePhysicalCard, cancelPhysicalCard, cardQueue, createVirtualCard, declinePhysicalCard, DEFAULT_CARD_SETTINGS, fundCard,
  staffCards, staffCreateVirtualCard, staffDeductCard, staffFundCard, staffIssuePhysicalCard, staffSetCardFreeze,
} from "@workspace/domain/cards";
import { staffAdjustBalance } from "@workspace/domain/adjustments";
import { computeBalances } from "@workspace/domain/rules";
import { roleCan, type Permission } from "@workspace/authz";
import {
  createDepositMethod, deleteDepositMethod, setDepositMethodAvailability, setDepositMethodPhoto, STALE_DEPOSIT_METHODS, updateDepositMethod, type DepositMethodInput,
} from "@workspace/domain/depositMethods";
import {
  approveDepositRelease, attachDepositProof, cancelDeposit, confirmDeposit, MAX_PROOF_BYTES, rejectDeposit, removeDepositProof, requestDeposit,
} from "@workspace/domain/deposits";
import { cancelWithdrawal, requestPhysicalCard, requestWithdrawal, setCardLimit, toggleCardFreeze } from "@workspace/domain/money";
import type { DemoState, DepositProof, MethodPhotoFile, Result, Transaction, Treasury, TreasuryInput } from "@workspace/domain/model";
import { approvePayoutRelease, markPayoutFailed, markPayoutPaid } from "@workspace/domain/payouts";
import { endLockdown, startLockdown } from "@workspace/domain/security";
import { applicantState, readApplicantSlot, serverState } from "@workspace/domain/server";
import { CURRENT_APPLICANT_ID as SLOT } from "@workspace/domain/seed";
import { updateTreasury } from "@workspace/domain/treasury";
import { createMethod, deleteMethod, MAX_METHOD_PHOTO_BYTES, setMethodAvailability, setMethodPhoto, updateMethod, type MethodInput } from "@workspace/domain/withdrawalMethods";
import { auditEntry, effectsOf } from "../lib/activity";
import type { FileStore } from "../lib/fileStore";
import { slotApplicant } from "../lib/applicantRules";
import { storeLedgerChanges } from "../lib/ledger";
import { logger } from "../lib/logger";
import { newCards, type MoneyRepo } from "../lib/moneyRepo";
import type { ProfileRecord, ProfileRepo } from "../lib/profileRepo";
import { auditContext, authLocals, requirePermission, requireStaff } from "../middlewares/auth";
import { cleanFileName, detectType } from "./documents";
import { detectImage, ownProfile } from "./profile";
import { inspectUpload } from "../lib/uploadSafety";

// Money: the ledger, deposits (with proof of payment), payouts, cards,
// withdrawal and deposit methods, the money settings, and the lockdown. Every change runs the shared rules
// (@workspace/domain/{money,deposits,payouts,treasury,security}) under the
// locks described in ../lib/moneyRepo.ts, and stores the ledger entries, money
// profile, notifications, feed items, and audit entry in one transaction.
// No payment provider is connected: staff record what happened outside the app.

type Failure = { status: 400 | 403 | 404 | 409; body: { error: string; fieldErrors?: Record<string, string> } };
const refused = (r: Result & { ok: false }): Failure => ({ status: 400, body: { error: r.error, ...(r.fieldErrors ? { fieldErrors: r.fieldErrors } : {}) } });
const send = (res: Response, f: Failure) => res.status(f.status).json(f.body);

/** No card issuer is connected, so card endings and PINs are random. */
const fourDigits = () => String(randomInt(10_000)).padStart(4, "0");

/** Settings as they leave the server: where an uploaded method photo is stored stays on the server. */
const outward = (t: Treasury): Treasury => ({
  ...t, channels: t.channels.map(({ photoFile: _file, ...m }) => m), depositMethods: t.depositMethods.map(({ photoFile: _file, ...m }) => m),
});
/** What applicants see of the settings: the available methods and the rules that apply to them, not who changed what. */
const forApplicants = (t: Treasury): Treasury => {
  const o = outward(t);
  return { ...o, channels: o.channels.filter(c => c.enabled), depositMethods: o.depositMethods.filter(m => m.enabled), changeLog: [] };
};
const outwardSettings = (s: { treasury: Treasury; lockdown: DemoState["lockdown"] }) => ({ ...s, treasury: outward(s.treasury) });

/** Method photos are stored under these owner ids (storage keys are `<uuid>/<uuid>`). */
export const METHOD_PHOTO_OWNER = "5a1e5000-0000-4000-8000-00000000f070";
export const DEPOSIT_METHOD_PHOTO_OWNER = "5a1e5000-0000-4000-8000-00000000f071";
/** A deposit's proof file: under the applicant's own folder, named by the proof's id. */
export const proofKey = (applicantId: string, proofId: string) => `${applicantId}/${proofId}`;
/** Staff who process or approve deposits can open their proof of payment. */
const PROOF_VIEWERS: Permission[] = ["payments.process", "payments.release"];

export function moneyRouter(money: MoneyRepo, profiles: ProfileRepo, files: FileStore): IRouter {
  const router: IRouter = Router();

  // ---------- Applicant ----------

  async function myMoney(applicantId: string) {
    const [settings, profile, transactions] = await Promise.all([money.settings(), money.moneyProfile(applicantId), money.ledgerFor(applicantId)]);
    return { transactions, ...profile, treasury: forApplicants(settings.treasury), lockdown: settings.lockdown };
  }

  router.get("/money/mine", async (_req, res) => {
    const record = await ownProfile(profiles, authLocals(res).user);
    // Creates the fictional cards on first visit, inside the applicant's lock.
    if (!(await money.moneyProfile(record.authUserId))) await money.withApplicant(record.authUserId, async () => {});
    res.json(await myMoney(record.authUserId));
  });

  /** Runs an applicant money rule on their own records, with a fresh block of ids; true if it was applied (the response is sent either way). */
  async function asApplicant(res: Response, command: (state: DemoState) => Result): Promise<boolean> {
    const record = await ownProfile(profiles, authLocals(res).user);
    const nextId = await money.nextBlock();
    const outcome = await money.withApplicant(record.authUserId, async (scope): Promise<{ message: string; id?: string } | { failure: Failure }> => {
      const base = slotApplicant(scope.applicant);
      const before = applicantState(
        { transactions: scope.transactions, treasury: scope.treasury, lockdown: scope.lockdown, nextId },
        { ...base, account: { ...base.account, ...(scope.money.destinationChangedAt ? { destinationChangedAt: scope.money.destinationChangedAt } : {}) }, cards: scope.money.cards, savedPayoutDetails: scope.money.savedPayoutDetails },
      );
      const result = command(before);
      if (!result.ok) return { failure: refused(result) };
      const slot = readApplicantSlot(result.state, record.authUserId);
      await storeLedgerChanges(scope.transactions, slot.transactions, scope.saveTransaction);
      const after = { cards: slot.cards, savedPayoutDetails: slot.savedPayoutDetails, ...(slot.account.destinationChangedAt ? { destinationChangedAt: slot.account.destinationChangedAt } : {}) };
      if (JSON.stringify(after) !== JSON.stringify(scope.money)) await scope.saveMoney(after);
      await scope.record(effectsOf(before, result.state, new Date(), { slotId: record.authUserId }));
      return { message: result.message, ...(result.id ? { id: result.id } : {}) };
    });
    if ("failure" in outcome) { send(res, outcome.failure); return false; }
    res.json({ money: await myMoney(record.authUserId), message: outcome.message, ...(outcome.id ? { id: outcome.id } : {}) });
    return true;
  }

  const idOf = (req: Request) => { const p = LedgerIdParams.safeParse(req.params); return p.success ? p.data.id : null; };

  router.post("/money/deposits", async (req, res) => {
    const b = RequestDepositBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Send an amount, a deposit method, and the method's details." }); return; }
    await asApplicant(res, s => requestDeposit(s, b.data.amount, b.data.method, new Date(), b.data.details ?? {}));
  });

  // ---------- Proof of payment ----------

  /** The applicant's own deposit (anyone else's reads as not found). */
  async function ownDeposit(req: Request, res: Response): Promise<Transaction | null> {
    const id = idOf(req);
    const tx = id ? await money.findTransaction(id) : null;
    if (!tx || tx.type !== "Deposit" || tx.applicantId !== authLocals(res).user.id) { res.status(404).json({ error: "That deposit could not be found." }); return null; }
    return tx;
  }

  router.put("/money/deposits/:id/proof", express.raw({ type: () => true, limit: MAX_PROOF_BYTES }), async (req: Request, res: Response) => {
    const tx = await ownDeposit(req, res);
    if (!tx) return;
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length) { res.status(400).json({ error: "The file is empty." }); return; }
    const contentType = detectType(bytes);
    if (!contentType) { res.status(415).json({ error: "Upload a PDF, JPG, or PNG file." }); return; }
    const unsafe = inspectUpload(bytes, contentType);
    if (!unsafe.ok) { res.status(422).json({ error: unsafe.reason }); return; }
    const proof: DepositProof = {
      id: randomUUID(), fileName: cleanFileName(req.header("x-file-name")), contentType, sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), uploadedAt: new Date().toISOString(),
    };
    const key = proofKey(tx.applicantId, proof.id);
    await files.put(key, bytes);
    const saved = await asApplicant(res, s => attachDepositProof(s, tx.id, proof, new Date())).catch(async err => { await files.remove(key).catch(() => {}); throw err; });
    if (!saved) { await files.remove(key).catch(() => {}); return; }
    logger.info({ applicant: tx.applicantId, entry: tx.id, proof: proof.id, bytes: bytes.length }, "deposit proof uploaded");
  });
  router.use("/money/deposits/:id/proof", (err: { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type === "entity.too.large") { res.status(413).json({ error: `Files can be at most ${MAX_PROOF_BYTES / 1024 / 1024} MB.` }); return; }
    next(err);
  });
  router.post("/money/deposits/:id/proof/:proofId/delete", async (req, res) => {
    const p = GetDepositProofParams.safeParse(req.params);
    const tx = p.success ? await ownDeposit(req, res) : null;
    if (!p.success) { res.status(404).json({ error: "That file could not be found." }); return; }
    if (!tx) return;
    if (await asApplicant(res, s => removeDepositProof(s, tx.id, p.data.proofId))) await files.remove(proofKey(tx.applicantId, p.data.proofId)).catch(() => {});
  });
  router.get("/money/deposits/:id/proof/:proofId", async (req, res) => {
    const { user, staff } = authLocals(res);
    const p = GetDepositProofParams.safeParse(req.params);
    const tx = p.success ? await money.findTransaction(p.data.id) : null;
    const proof = tx?.type === "Deposit" ? tx.proof?.find(f => f.id === p.data?.proofId) : undefined;
    const owner = tx?.applicantId === user.id;
    const staffMay = !!staff?.active && PROOF_VIEWERS.some(permission => roleCan(staff.role, permission));
    // Someone else's file reads as not found, never as forbidden.
    if (!tx || !proof || (!owner && !staffMay)) { res.status(404).json({ error: "That file could not be found." }); return; }
    const bytes = await files.get(proofKey(tx.applicantId, proof.id));
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== proof.sha256) {
      logger.error({ entry: tx.id, proof: proof.id, missing: !bytes }, "deposit proof is missing or doesn't match its record");
      res.status(500).json({ error: "This file can't be opened: the stored file is missing or has changed. The team has been alerted." }); return;
    }
    if (!owner) {
      const ctx = auditContext(req, res, "View deposit proof", tx.id);
      await money.withApplicant(tx.applicantId, scope => scope.record({ notifications: [], staffEvents: [], audit: [{ ...auditEntry(ctx, `Opened proof of payment for ${tx.reference ?? tx.id}: ${proof.fileName}`, [], new Date()), applicantId: tx.applicantId }] }));
    }
    res.set({
      "Content-Type": proof.contentType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${proof.fileName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(proof.fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    res.end(bytes);
  });
  router.post("/money/deposits/:id/cancel", async (req, res) => {
    const id = idOf(req);
    if (!id) { res.status(404).json({ error: "That deposit could not be found." }); return; }
    await asApplicant(res, s => cancelDeposit(s, id, new Date()));
  });
  router.post("/money/withdrawals", async (req, res) => {
    const b = RequestWithdrawalBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Send an amount, a withdrawal method, and the method's details." }); return; }
    const { amount, channel, source, details } = b.data;
    await asApplicant(res, s => requestWithdrawal(s, { amount, method: channel, ...(source ? { source } : {}), details: details ?? {} }, new Date()));
  });
  router.post("/money/withdrawals/:id/cancel", async (req, res) => {
    const id = idOf(req);
    if (!id) { res.status(404).json({ error: "That payout request could not be found." }); return; }
    await asApplicant(res, s => cancelWithdrawal(s, id, new Date()));
  });
  router.post("/money/cards/freeze", async (req, res) => {
    const b = ToggleCardFreezeBody.safeParse(req.body ?? {});
    if (!b.success) { res.status(400).json({ error: "Choose the virtual or physical card." }); return; }
    await asApplicant(res, s => toggleCardFreeze(s, new Date(), b.data.card ?? "virtual"));
  });
  router.post("/money/cards/physical/activate", async (req, res) => {
    const b = ActivatePhysicalCardBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Enter the last four digits on the front of your card.", fieldErrors: { lastFour: "Enter four digits." } }); return; }
    await asApplicant(res, s => activatePhysicalCard(s, b.data.lastFour, new Date()));
  });
  router.post("/money/cards/limit", async (req, res) => {
    const b = SetCardLimitBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Send the card and a daily limit." }); return; }
    await asApplicant(res, s => setCardLimit(s, b.data.card, b.data.limit));
  });
  router.post("/money/cards/virtual", async (_req, res) => { await asApplicant(res, s => createVirtualCard(s, fourDigits(), fourDigits(), new Date())); });
  router.post("/money/cards/fund", async (req, res) => {
    const b = FundCardBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Send an amount and the balance to take it from." }); return; }
    await asApplicant(res, s => fundCard(s, b.data.amount, b.data.source, new Date()));
  });
  router.post("/money/cards/physical", async (req, res) => {
    const b = RequestPhysicalCardBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Enter the shipping address: name, address, city, postal code, and country." }); return; }
    await asApplicant(res, s => requestPhysicalCard(s, b.data, new Date()));
  });
  // ---------- Staff: ledger entries ----------

  router.get("/money/ledger", requireStaff, async (_req, res) => { res.json(await money.ledger()); });
  router.get("/money/settings", requireStaff, async (_req, res) => { res.json(outwardSettings(await money.settings())); });

  type TxCommand = (state: DemoState, actor: { id: string; name: string }, tx: Transaction) => Result;

  const txAction = (path: string, permission: Permission, label: string, parse: (body: unknown) => { ok: true; command: TxCommand } | { ok: false; error: string }) =>
    router.post(`/money/${path}`, requireStaff, requirePermission(permission), async (req, res) => {
      const id = idOf(req);
      const found = id ? await money.findTransaction(id) : null;
      if (!found) { res.status(404).json({ error: "That ledger entry could not be found." }); return; }
      if (found.applicantId === authLocals(res).user.id) { res.status(403).json({ error: "You can't process your own money. Ask another team member." }); return; }
      const parsed = parse(req.body);
      if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
      const actor = authLocals(res).staff!;
      const outcome = await money.withApplicant(found.applicantId, async (scope): Promise<{ saved: Transaction; message: string } | { failure: Failure }> => {
        const current = scope.transactions.find(t => t.id === found.id)!;
        const before = serverState({ transactions: scope.transactions, treasury: scope.treasury, lockdown: scope.lockdown });
        const result = parsed.command(before, actor, current);
        if (!result.ok) return { failure: refused(result) };
        let after = result.state.transactions;
        // Dual control is enforced by staff id, not just by name: record who approved the release.
        if (path.endsWith("/release")) after = after.map(t => t.id === found.id && t.releaseApproval ? { ...t, releaseApproval: { ...t.releaseApproval, byId: actor.id } } : t);
        await storeLedgerChanges(scope.transactions, after, scope.saveTransaction);
        await scope.record(effectsOf(before, { ...result.state, transactions: after }, new Date(), { audit: auditContext(req, res, label, found.id), summary: result.message }));
        return { saved: after.find(t => t.id === found.id)!, message: result.message };
      });
      if ("failure" in outcome) { send(res, outcome.failure); return; }
      logger.info({ actor: actor.id, entry: found.id, action: path }, "ledger entry processed");
      res.json({ transaction: outcome.saved, message: outcome.message });
    });

  const none = (command: TxCommand) => () => ({ ok: true as const, command });
  const reason = (make: (text: string) => TxCommand, error: string) => (body: unknown) => {
    const b = ReasonBody.safeParse(body);
    return b.success ? { ok: true as const, command: make(b.data.reason) } : { ok: false as const, error };
  };

  txAction("deposits/:id/release", "payments.release", "Approve deposit", none((s, a, tx) => approveDepositRelease(s, tx.id, a.name, new Date())));
  txAction("deposits/:id/confirm", "payments.process", "Confirm deposit", none((s, a, tx) => {
    // Two different people: the rule compares names, the server also compares staff ids.
    if (tx.releaseApproval?.byId === a.id) return { ok: false, error: `You approved ${tx.reference ?? tx.id}, so a different staff member must confirm it.` };
    return confirmDeposit(s, tx.id, a.name, new Date());
  }));
  txAction("deposits/:id/reject", "payments.process", "Reject deposit", reason(text => (s, a, tx) => rejectDeposit(s, tx.id, text, a.name, new Date()), "Explain why the deposit was rejected."));
  txAction("withdrawals/:id/release", "payments.release", "Approve payout release", none((s, a, tx) => approvePayoutRelease(s, tx.id, a.name, new Date())));
  txAction("withdrawals/:id/paid", "payments.process", "Mark payout paid", none((s, a, tx) => {
    // Two different people: the rule compares names, the server also compares staff ids.
    if (tx.releaseApproval?.byId === a.id) return { ok: false, error: `You approved the release of ${tx.id}, so a different staff member must mark it paid.` };
    return markPayoutPaid(s, tx.id, a.name, new Date());
  }));
  txAction("withdrawals/:id/failed", "payments.process", "Mark payout failed", reason(text => (s, a, tx) => markPayoutFailed(s, tx.id, text, a.name, new Date()), "Explain why the payout failed."));

  // ---------- Staff: cards ----------

  /** An applicant's cards as staff see them: no PIN, with the card balance and their card settings. */
  async function holderOf(record: ProfileRecord) {
    const [profile, ledger] = await Promise.all([money.moneyProfile(record.authUserId), money.ledgerFor(record.authUserId)]);
    return { applicantId: record.authUserId, name: record.name, email: record.email, cards: staffCards(profile?.cards ?? newCards()), balance: computeBalances(ledger).card, settings: record.account.cardSettings ?? DEFAULT_CARD_SETTINGS };
  }

  router.get("/money/card-holders", requireStaff, async (_req, res) => {
    const [holders, ledger] = await Promise.all([money.cardHolders(), money.ledger()]);
    res.json(cardQueue(holders.map(h => ({ ...h, cards: staffCards(h.cards), balance: computeBalances(ledger.filter(t => t.applicantId === h.applicantId)).card }))));
  });
  router.get("/money/card-holders/:id", requireStaff, async (req, res) => {
    const p = ApplicantIdParams.safeParse(req.params);
    const record = p.success ? await profiles.get(p.data.id) : null;
    if (!record) { res.status(404).json({ error: "That applicant could not be found." }); return; }
    res.json(await holderOf(record));
  });

  type CardCommand = (state: DemoState, actor: { id: string; name: string }) => Result;

  /** A staff card rule on one applicant, run with them in the rules' slot under their money lock. */
  const cardAction = (path: string, permission: Permission, label: string, parse: (body: unknown) => { ok: true; command: CardCommand } | { ok: false; error: string }) =>
    router.post(`/money/card-holders/:id/${path}`, requireStaff, requirePermission(permission), async (req, res) => {
      const p = ApplicantIdParams.safeParse(req.params);
      const record = p.success ? await profiles.get(p.data.id) : null;
      if (!record) { res.status(404).json({ error: "That applicant could not be found." }); return; }
      if (record.authUserId === authLocals(res).user.id) { res.status(403).json({ error: "You can't manage your own cards. Ask another team member." }); return; }
      const parsed = parse(req.body);
      if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
      const actor = authLocals(res).staff!;
      const nextId = await money.nextBlock();
      const outcome = await money.withApplicant(record.authUserId, async (scope): Promise<{ message: string } | { failure: Failure }> => {
        const base = slotApplicant(scope.applicant);
        const before = applicantState({ transactions: scope.transactions, treasury: scope.treasury, lockdown: scope.lockdown, nextId },
          { ...base, cards: scope.money.cards, savedPayoutDetails: scope.money.savedPayoutDetails });
        const result = parsed.command(before, actor);
        if (!result.ok) return { failure: refused(result) };
        const slot = readApplicantSlot(result.state, record.authUserId);
        await storeLedgerChanges(scope.transactions, slot.transactions, scope.saveTransaction);
        await scope.saveMoney({ ...scope.money, cards: slot.cards });
        // The audit target is the rules' slot id; it's stored as the applicant's real id.
        await scope.record(effectsOf(before, result.state, new Date(), { slotId: record.authUserId, audit: auditContext(req, res, label, SLOT), summary: result.message }));
        return { message: result.message };
      });
      if ("failure" in outcome) { send(res, outcome.failure); return; }
      logger.info({ actor: actor.id, applicant: record.authUserId, action: path }, "card changed by staff");
      res.json({ holder: await holderOf(record), message: outcome.message });
    });

  const body = <T,>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, error: string, make: (data: T) => CardCommand) => (raw: unknown) => {
    const b = schema.safeParse(raw ?? {});
    return b.success ? { ok: true as const, command: make(b.data) } : { ok: false as const, error };
  };
  cardAction("virtual", "payments.process", "Create virtual card", () => ({ ok: true, command: (s, a) => staffCreateVirtualCard(s, fourDigits(), fourDigits(), a.name, new Date()) }));
  cardAction("physical", "payments.process", "Issue physical card", body(IssuePhysicalCardBody, "Send the shipping address and the message for the applicant.",
    d => (s, a) => staffIssuePhysicalCard(s, d.address, fourDigits(), d.message, d.trackingRef ?? "", a.name, new Date())));
  cardAction("approve", "payments.process", "Approve physical card", body(ApprovePhysicalCardBody, "Write the message for the applicant (up to 2000 characters).",
    d => (s, a) => approvePhysicalCard(s, fourDigits(), d.message, d.trackingRef ?? "", a.name, new Date())));
  cardAction("decline", "payments.process", "Decline physical card", body(ReasonBody, "Explain why the application is declined.", d => (s, a) => declinePhysicalCard(s, d.reason, a.name, new Date())));
  cardAction("cancel", "payments.process", "Cancel physical card", body(ReasonBody, "Explain why the card is being cancelled.", d => (s, a) => cancelPhysicalCard(s, d.reason, a.name, new Date())));
  cardAction("freeze", "accounts.manage", "Change card freeze", body(SetCardFreezeAsStaffBody, "Say which card, whether to freeze it, and the note for the applicant.",
    d => s => staffSetCardFreeze(s, d.card, d.frozen, d.reason ?? "", new Date())));
  cardAction("fund", "payments.process", "Fund card", body(FundCardAsStaffBody, "Send an amount, where it comes from, and a reason.", d => (s, a) => staffFundCard(s, d.amount, d.source, d.reason, a.name, new Date())));
  cardAction("adjust", "payments.process", "Adjust balance", body(AdjustBalanceBody, "Send the balance, credit or debit, an amount, a category, and a reason.", d => (s, a) => staffAdjustBalance(s, d, a.name, new Date())));
  cardAction("deduct", "payments.process", "Deduct from card", body(DeductFromCardBody, "Send an amount, where it goes, and a reason.", d => (s, a) => staffDeductCard(s, d.amount, d.destination, d.reason, a.name, new Date())));

  // ---------- Staff: settings and lockdown ----------

  /** Runs a settings, method, or lockdown rule under the system lock; returns the outcome (the response is sent). */
  async function asSystem(req: Request, res: Response, label: string, target: string, command: (state: DemoState, by: string) => Result): Promise<{ ok: true; before: Treasury; after: Treasury } | { ok: false }> {
    const actor = authLocals(res).staff!;
    const outcome = await money.withSystem(async (scope): Promise<{ message: string; id?: string; before: Treasury; after: Treasury } | { failure: Failure }> => {
      const before = serverState({ treasury: scope.treasury, lockdown: scope.lockdown, transactions: scope.pendingWithdrawals });
      const result = command(before, actor.name);
      if (!result.ok) return { failure: refused(result) };
      if (JSON.stringify(result.state.treasury) !== JSON.stringify(scope.treasury)) await scope.saveTreasury(result.state.treasury);
      if (JSON.stringify(result.state.lockdown) !== JSON.stringify(scope.lockdown)) await scope.saveLockdown(result.state.lockdown);
      await scope.record(effectsOf(before, result.state, new Date(), { audit: auditContext(req, res, label, target), summary: result.message }));
      return { message: result.message, ...(result.id ? { id: result.id } : {}), before: scope.treasury, after: result.state.treasury };
    });
    if ("failure" in outcome) { send(res, outcome.failure); return { ok: false }; }
    res.json({ settings: outwardSettings(await money.settings()), message: outcome.message, ...(outcome.id ? { id: outcome.id } : {}) });
    return { ok: true, before: outcome.before, after: outcome.after };
  }

  router.put("/money/settings", requireStaff, requirePermission("treasury.manage"), async (req, res) => {
    const b = UpdateMoneySettingsBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Send the settings' version and every setting." }); return; }
    const current = await money.settings();
    if (current.treasury.updatedAt !== b.data.version) { res.status(409).json({ error: "Money settings changed since you opened them. Review the latest values and try again." }); return; }
    await asSystem(req, res, "Update money settings", "treasury", (s, by) => updateTreasury(s, b.data.version, b.data.treasury as TreasuryInput, by, new Date()));
  });
  // ---------- Staff: withdrawal methods ----------

  /** Removes stored method photos no withdrawal or deposit method uses any more (after a delete, a new upload, or switching to a link). */
  async function dropUnusedPhotos(before: Treasury, after: Treasury) {
    const kept = new Set([...after.channels, ...after.depositMethods].map(c => c.photoFile?.key).filter(Boolean));
    for (const c of [...before.channels, ...before.depositMethods]) {
      if (c.photoFile && !kept.has(c.photoFile.key)) await files.remove(c.photoFile.key).catch(err => logger.warn({ err, method: c.id }, "couldn't remove an unused method photo"));
    }
  }
  const methodIdOf = (req: Request) => { const p = MethodIdParams.safeParse(req.params); return p.success ? p.data.methodId : null; };
  const staleVersion = async (version: string) => (await money.settings()).treasury.updatedAt !== version;
  const STALE = "Withdrawal methods changed since you opened them. Review the latest version and try again.";
  /** Uploaded photos are set with their own endpoint; preview-mode data: URLs never reach the server. */
  const photoLinkError = (input: { photoUrl: string }) => input.photoUrl.trim().startsWith("data:") ? { error: "Upload the photo with the photo button, or use an https link.", fieldErrors: { photoUrl: "Upload the photo with the photo button, or use an https link." } } : null;

  router.post("/money/methods", requireStaff, requirePermission("treasury.manage"), async (req, res) => {
    const b = CreateWithdrawalMethodBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Send the settings' version and every method field." }); return; }
    const input = b.data.method as MethodInput;
    const photo = photoLinkError(input);
    if (photo) { res.status(400).json(photo); return; }
    if (await staleVersion(b.data.version)) { res.status(409).json({ error: STALE }); return; }
    await asSystem(req, res, "Add withdrawal method", "treasury", (s, by) => createMethod(s, b.data.version, input, by, new Date()));
  });
  router.put("/money/methods/:methodId", requireStaff, requirePermission("treasury.manage"), async (req, res) => {
    const id = methodIdOf(req);
    const b = CreateWithdrawalMethodBody.safeParse(req.body);
    if (!id) { res.status(404).json({ error: "That withdrawal method no longer exists." }); return; }
    if (!b.success) { res.status(400).json({ error: "Send the settings' version and every method field." }); return; }
    const input = b.data.method as MethodInput;
    const photo = photoLinkError(input);
    if (photo) { res.status(400).json(photo); return; }
    const current = (await money.settings()).treasury;
    if (!current.channels.some(c => c.id === id)) { res.status(404).json({ error: "That withdrawal method no longer exists." }); return; }
    if (current.updatedAt !== b.data.version) { res.status(409).json({ error: STALE }); return; }
    const done = await asSystem(req, res, "Edit withdrawal method", id, (s, by) => updateMethod(s, b.data.version, id, input, by, new Date()));
    if (done.ok) await dropUnusedPhotos(done.before, done.after);
  });
  router.post("/money/methods/:methodId/availability", requireStaff, requirePermission("treasury.manage"), async (req, res) => {
    const id = methodIdOf(req);
    const b = SetWithdrawalMethodAvailabilityBody.safeParse(req.body);
    if (!id || !(await money.settings()).treasury.channels.some(c => c.id === id)) { res.status(404).json({ error: "That withdrawal method no longer exists." }); return; }
    if (!b.success) { res.status(400).json({ error: "Say whether users can choose the method." }); return; }
    await asSystem(req, res, b.data.enabled ? "Make withdrawal method available" : "Make withdrawal method unavailable", id, (s, by) => setMethodAvailability(s, id, b.data.enabled, by, new Date()));
  });
  router.post("/money/methods/:methodId/delete", requireStaff, requirePermission("treasury.manage"), async (req, res) => {
    const id = methodIdOf(req);
    if (!id || !(await money.settings()).treasury.channels.some(c => c.id === id)) { res.status(404).json({ error: "That withdrawal method no longer exists." }); return; }
    const done = await asSystem(req, res, "Delete withdrawal method", id, (s, by) => deleteMethod(s, id, by, new Date()));
    if (done.ok) await dropUnusedPhotos(done.before, done.after);
  });
  router.put("/money/methods/:methodId/photo", requireStaff, requirePermission("treasury.manage"), express.raw({ type: () => true, limit: MAX_METHOD_PHOTO_BYTES }), async (req: Request, res: Response) => {
    const id = methodIdOf(req);
    if (!id || !(await money.settings()).treasury.channels.some(c => c.id === id)) { res.status(404).json({ error: "That withdrawal method no longer exists." }); return; }
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length) { res.status(400).json({ error: "The file is empty." }); return; }
    const contentType = detectImage(bytes);
    if (!contentType) { res.status(415).json({ error: "Upload a JPG, PNG, or WEBP image." }); return; }
    const unsafe = inspectUpload(bytes, contentType);
    if (!unsafe.ok) { res.status(422).json({ error: unsafe.reason }); return; }
    const file: MethodPhotoFile = { key: `${METHOD_PHOTO_OWNER}/${randomUUID()}`, contentType, sha256: createHash("sha256").update(bytes).digest("hex") };
    await files.put(file.key, bytes);
    const done = await asSystem(req, res, "Change withdrawal method photo", id, (s, by) => setMethodPhoto(s, id, "", file, by, new Date()));
    if (!done.ok) { await files.remove(file.key).catch(() => {}); return; }
    await dropUnusedPhotos(done.before, done.after);
  });
  router.use("/money/methods/:methodId/photo", (err: { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type === "entity.too.large") { res.status(413).json({ error: `Photos can be at most ${MAX_METHOD_PHOTO_BYTES / 1024 / 1024} MB.` }); return; }
    next(err);
  });
  router.post("/money/methods/:methodId/photo/delete", requireStaff, requirePermission("treasury.manage"), async (req, res) => {
    const id = methodIdOf(req);
    if (!id || !(await money.settings()).treasury.channels.some(c => c.id === id)) { res.status(404).json({ error: "That withdrawal method no longer exists." }); return; }
    const done = await asSystem(req, res, "Remove withdrawal method photo", id, (s, by) => setMethodPhoto(s, id, "", null, by, new Date()));
    if (done.ok) await dropUnusedPhotos(done.before, done.after);
  });

  // ---------- Staff: deposit methods ----------

  /** The deposit method named in the path, if it exists. */
  const depositMethodIdOf = async (req: Request): Promise<string | null> => {
    const id = methodIdOf(req);
    return id && (await money.settings()).treasury.depositMethods.some(m => m.id === id) ? id : null;
  };
  const DEPOSIT_GONE = "That deposit method no longer exists.";

  router.post("/money/deposit-methods", requireStaff, requirePermission("treasury.manage"), async (req, res) => {
    const b = CreateDepositMethodBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Send the settings' version and every method field." }); return; }
    const input = b.data.method as DepositMethodInput;
    const photo = photoLinkError(input);
    if (photo) { res.status(400).json(photo); return; }
    if (await staleVersion(b.data.version)) { res.status(409).json({ error: STALE_DEPOSIT_METHODS }); return; }
    await asSystem(req, res, "Add deposit method", "treasury", (s, by) => createDepositMethod(s, b.data.version, input, by, new Date()));
  });
  router.put("/money/deposit-methods/:methodId", requireStaff, requirePermission("treasury.manage"), async (req, res) => {
    const id = await depositMethodIdOf(req);
    const b = CreateDepositMethodBody.safeParse(req.body);
    if (!id) { res.status(404).json({ error: DEPOSIT_GONE }); return; }
    if (!b.success) { res.status(400).json({ error: "Send the settings' version and every method field." }); return; }
    const input = b.data.method as DepositMethodInput;
    const photo = photoLinkError(input);
    if (photo) { res.status(400).json(photo); return; }
    if (await staleVersion(b.data.version)) { res.status(409).json({ error: STALE_DEPOSIT_METHODS }); return; }
    const done = await asSystem(req, res, "Edit deposit method", id, (s, by) => updateDepositMethod(s, b.data.version, id, input, by, new Date()));
    if (done.ok) await dropUnusedPhotos(done.before, done.after);
  });
  router.post("/money/deposit-methods/:methodId/availability", requireStaff, requirePermission("treasury.manage"), async (req, res) => {
    const id = await depositMethodIdOf(req);
    const b = SetWithdrawalMethodAvailabilityBody.safeParse(req.body);
    if (!id) { res.status(404).json({ error: DEPOSIT_GONE }); return; }
    if (!b.success) { res.status(400).json({ error: "Say whether users can choose the method." }); return; }
    await asSystem(req, res, b.data.enabled ? "Make deposit method available" : "Make deposit method unavailable", id, (s, by) => setDepositMethodAvailability(s, id, b.data.enabled, by, new Date()));
  });
  router.post("/money/deposit-methods/:methodId/delete", requireStaff, requirePermission("treasury.manage"), async (req, res) => {
    const id = await depositMethodIdOf(req);
    if (!id) { res.status(404).json({ error: DEPOSIT_GONE }); return; }
    const done = await asSystem(req, res, "Delete deposit method", id, (s, by) => deleteDepositMethod(s, id, by, new Date()));
    if (done.ok) await dropUnusedPhotos(done.before, done.after);
  });
  router.put("/money/deposit-methods/:methodId/photo", requireStaff, requirePermission("treasury.manage"), express.raw({ type: () => true, limit: MAX_METHOD_PHOTO_BYTES }), async (req: Request, res: Response) => {
    const id = await depositMethodIdOf(req);
    if (!id) { res.status(404).json({ error: DEPOSIT_GONE }); return; }
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length) { res.status(400).json({ error: "The file is empty." }); return; }
    const contentType = detectImage(bytes);
    if (!contentType) { res.status(415).json({ error: "Upload a JPG, PNG, or WEBP image." }); return; }
    const unsafe = inspectUpload(bytes, contentType);
    if (!unsafe.ok) { res.status(422).json({ error: unsafe.reason }); return; }
    const file: MethodPhotoFile = { key: `${DEPOSIT_METHOD_PHOTO_OWNER}/${randomUUID()}`, contentType, sha256: createHash("sha256").update(bytes).digest("hex") };
    await files.put(file.key, bytes);
    const done = await asSystem(req, res, "Change deposit method photo", id, (s, by) => setDepositMethodPhoto(s, id, "", file, by, new Date()));
    if (!done.ok) { await files.remove(file.key).catch(() => {}); return; }
    await dropUnusedPhotos(done.before, done.after);
  });
  router.use("/money/deposit-methods/:methodId/photo", (err: { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type === "entity.too.large") { res.status(413).json({ error: `Photos can be at most ${MAX_METHOD_PHOTO_BYTES / 1024 / 1024} MB.` }); return; }
    next(err);
  });
  router.post("/money/deposit-methods/:methodId/photo/delete", requireStaff, requirePermission("treasury.manage"), async (req, res) => {
    const id = await depositMethodIdOf(req);
    if (!id) { res.status(404).json({ error: DEPOSIT_GONE }); return; }
    const done = await asSystem(req, res, "Remove deposit method photo", id, (s, by) => setDepositMethodPhoto(s, id, "", null, by, new Date()));
    if (done.ok) await dropUnusedPhotos(done.before, done.after);
  });

  router.post("/money/lockdown", requireStaff, requirePermission("security.lockdown"), async (req, res) => {
    const b = ReasonBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Explain why the system is being locked down." }); return; }
    await asSystem(req, res, "Start system lockdown", "lockdown", (s, by) => startLockdown(s, b.data.reason, by, new Date()));
  });
  router.post("/money/lockdown/end", requireStaff, requirePermission("security.lockdown"), async (req, res) => {
    await asSystem(req, res, "End system lockdown", "lockdown", (s, by) => endLockdown(s, by, new Date()));
  });

  return router;
}

/**
 * Public: a withdrawal or deposit method's uploaded photo, so pages can show
 * it in an image tag (method logos aren't private). The address carries the
 * photo's hash, so it can be cached; the bytes are checked against that hash.
 */
export function methodPhotoRouter(money: MoneyRepo, files: FileStore): IRouter {
  const router: IRouter = Router();
  router.get(["/withdrawal-methods/:methodId/photo", "/deposit-methods/:methodId/photo"], async (req, res) => {
    const p = MethodIdParams.safeParse(req.params);
    const { treasury } = await money.settings();
    const list = req.path.startsWith("/deposit-methods/") ? treasury.depositMethods : treasury.channels;
    const method = p.success ? list.find(c => c.id === p.data.methodId) : undefined;
    const file = method?.photoFile;
    const bytes = file ? await files.get(file.key) : null;
    if (!file || !bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      if (file) logger.error({ method: method?.id, missing: !bytes }, "method photo is missing or doesn't match its record");
      res.status(404).json({ error: "No photo." }); return;
    }
    res.set({ "Content-Type": file.contentType, "Content-Length": String(bytes.length), "Cache-Control": "public, max-age=86400", "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-site" });
    res.end(bytes);
  });
  return router;
}
