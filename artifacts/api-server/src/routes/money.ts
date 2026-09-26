import { Router, type IRouter, type Request, type Response } from "express";
import {
  ConfirmDepositParams as LedgerIdParams, MarkPayoutFailedBody as ReasonBody, RemovePayoutDestinationParams, RequestDepositBody,
  RequestWithdrawalBody, SavePayoutDestinationBody, SetCardLimitBody, UpdateMoneySettingsBody,
} from "@workspace/api-zod";
import type { Permission } from "@workspace/authz";
import { cancelDeposit, confirmDeposit, rejectDeposit, requestDeposit } from "@workspace/domain/deposits";
import {
  cancelWithdrawal, removePayoutDestination, requestPhysicalCard, requestWithdrawal, savePayoutDestination, setCardLimit, toggleCardFreeze,
} from "@workspace/domain/money";
import type { ChannelId, DemoState, Result, Transaction, Treasury, TreasuryInput } from "@workspace/domain/model";
import { approvePayoutRelease, markPayoutFailed, markPayoutPaid } from "@workspace/domain/payouts";
import { endLockdown, startLockdown } from "@workspace/domain/security";
import { applicantState, readApplicantSlot, serverState } from "@workspace/domain/server";
import { updateTreasury } from "@workspace/domain/treasury";
import { effectsOf } from "../lib/activity";
import { slotApplicant } from "../lib/applicantRules";
import { storeLedgerChanges } from "../lib/ledger";
import { logger } from "../lib/logger";
import type { MoneyRepo } from "../lib/moneyRepo";
import type { ProfileRepo } from "../lib/profileRepo";
import { auditContext, authLocals, requirePermission, requireStaff } from "../middlewares/auth";
import { ownProfile } from "./profile";

// Money: the ledger, deposits, payouts, cards, payout destinations, the money
// settings, and the lockdown. Every change runs the shared rules
// (@workspace/domain/{money,deposits,payouts,treasury,security}) under the
// locks described in ../lib/moneyRepo.ts, and stores the ledger entries, money
// profile, notifications, feed items, and audit entry in one transaction.
// No payment provider is connected: staff record what happened outside the app.

type Failure = { status: 400 | 403 | 404 | 409; body: { error: string; fieldErrors?: Record<string, string> } };
const refused = (r: Result & { ok: false }): Failure => ({ status: 400, body: { error: r.error, ...(r.fieldErrors ? { fieldErrors: r.fieldErrors } : {}) } });
const send = (res: Response, f: Failure) => res.status(f.status).json(f.body);

/** What applicants see of the settings: the rules that apply to them, not who changed what. */
const forApplicants = (t: Treasury): Treasury => ({ ...t, changeLog: [] });

export function moneyRouter(money: MoneyRepo, profiles: ProfileRepo): IRouter {
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

  /** Runs an applicant money rule on their own records, with a fresh block of ids. */
  async function asApplicant(res: Response, command: (state: DemoState) => Result) {
    const record = await ownProfile(profiles, authLocals(res).user);
    const nextId = await money.nextBlock();
    const outcome = await money.withApplicant(record.authUserId, async (scope): Promise<{ message: string; id?: string } | { failure: Failure }> => {
      const base = slotApplicant(scope.applicant);
      const before = applicantState(
        { transactions: scope.transactions, treasury: scope.treasury, lockdown: scope.lockdown, nextId },
        { ...base, account: { ...base.account, ...(scope.money.destinationChangedAt ? { destinationChangedAt: scope.money.destinationChangedAt } : {}) }, cards: scope.money.cards, payoutDestinations: scope.money.payoutDestinations },
      );
      const result = command(before);
      if (!result.ok) return { failure: refused(result) };
      const slot = readApplicantSlot(result.state, record.authUserId);
      await storeLedgerChanges(scope.transactions, slot.transactions, scope.saveTransaction);
      const after = { cards: slot.cards, payoutDestinations: slot.payoutDestinations, ...(slot.account.destinationChangedAt ? { destinationChangedAt: slot.account.destinationChangedAt } : {}) };
      if (JSON.stringify(after) !== JSON.stringify(scope.money)) await scope.saveMoney(after);
      await scope.record(effectsOf(before, result.state, new Date(), { slotId: record.authUserId }));
      return { message: result.message, ...(result.id ? { id: result.id } : {}) };
    });
    if ("failure" in outcome) { send(res, outcome.failure); return; }
    res.json({ money: await myMoney(record.authUserId), message: outcome.message, ...(outcome.id ? { id: outcome.id } : {}) });
  }

  const idOf = (req: Request) => { const p = LedgerIdParams.safeParse(req.params); return p.success ? p.data.id : null; };

  router.post("/money/deposits", async (req, res) => {
    const b = RequestDepositBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Send an amount and a deposit method." }); return; }
    await asApplicant(res, s => requestDeposit(s, b.data.amount, b.data.method, new Date()));
  });
  router.post("/money/deposits/:id/cancel", async (req, res) => {
    const id = idOf(req);
    if (!id) { res.status(404).json({ error: "That deposit could not be found." }); return; }
    await asApplicant(res, s => cancelDeposit(s, id, new Date()));
  });
  router.post("/money/withdrawals", async (req, res) => {
    const b = RequestWithdrawalBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Send an amount and a payout channel." }); return; }
    await asApplicant(res, s => requestWithdrawal(s, b.data.amount, b.data.channel, new Date()));
  });
  router.post("/money/withdrawals/:id/cancel", async (req, res) => {
    const id = idOf(req);
    if (!id) { res.status(404).json({ error: "That payout request could not be found." }); return; }
    await asApplicant(res, s => cancelWithdrawal(s, id, new Date()));
  });
  router.post("/money/cards/freeze", async (_req, res) => { await asApplicant(res, toggleCardFreeze); });
  router.post("/money/cards/limit", async (req, res) => {
    const b = SetCardLimitBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Send the card and a daily limit." }); return; }
    await asApplicant(res, s => setCardLimit(s, b.data.card, b.data.limit));
  });
  router.post("/money/cards/physical", async (_req, res) => { await asApplicant(res, s => requestPhysicalCard(s, new Date())); });
  router.post("/money/destinations", async (req, res) => {
    const b = SavePayoutDestinationBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Send the channel and the destination details." }); return; }
    await asApplicant(res, s => savePayoutDestination(s, b.data.channel, { primary: b.data.primary, secondary: b.data.secondary }, new Date()));
  });
  router.post("/money/destinations/:channel/remove", async (req, res) => {
    const p = RemovePayoutDestinationParams.safeParse(req.params);
    if (!p.success) { res.status(400).json({ error: "Choose a payout channel." }); return; }
    await asApplicant(res, s => removePayoutDestination(s, p.data.channel as ChannelId));
  });

  // ---------- Staff: ledger entries ----------

  router.get("/money/ledger", requireStaff, async (_req, res) => { res.json(await money.ledger()); });
  router.get("/money/settings", requireStaff, async (_req, res) => { res.json(await money.settings()); });

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

  txAction("deposits/:id/confirm", "payments.process", "Confirm deposit", none((s, a, tx) => confirmDeposit(s, tx.id, a.name, new Date())));
  txAction("deposits/:id/reject", "payments.process", "Reject deposit", reason(text => (s, a, tx) => rejectDeposit(s, tx.id, text, a.name, new Date()), "Explain why the deposit was rejected."));
  txAction("withdrawals/:id/release", "payments.release", "Approve payout release", none((s, a, tx) => approvePayoutRelease(s, tx.id, a.name, new Date())));
  txAction("withdrawals/:id/paid", "payments.process", "Mark payout paid", none((s, a, tx) => {
    // Two different people: the rule compares names, the server also compares staff ids.
    if (tx.releaseApproval?.byId === a.id) return { ok: false, error: `You approved the release of ${tx.id}, so a different staff member must mark it paid.` };
    return markPayoutPaid(s, tx.id, a.name, new Date());
  }));
  txAction("withdrawals/:id/failed", "payments.process", "Mark payout failed", reason(text => (s, a, tx) => markPayoutFailed(s, tx.id, text, a.name, new Date()), "Explain why the payout failed."));

  // ---------- Staff: settings and lockdown ----------

  async function asSystem(req: Request, res: Response, label: string, target: "treasury" | "lockdown", command: (state: DemoState, by: string) => Result) {
    const actor = authLocals(res).staff!;
    const outcome = await money.withSystem(async (scope): Promise<{ message: string } | { failure: Failure }> => {
      const before = serverState({ treasury: scope.treasury, lockdown: scope.lockdown, transactions: scope.pendingWithdrawals });
      const result = command(before, actor.name);
      if (!result.ok) return { failure: refused(result) };
      if (JSON.stringify(result.state.treasury) !== JSON.stringify(scope.treasury)) await scope.saveTreasury(result.state.treasury);
      if (JSON.stringify(result.state.lockdown) !== JSON.stringify(scope.lockdown)) await scope.saveLockdown(result.state.lockdown);
      await scope.record(effectsOf(before, result.state, new Date(), { audit: auditContext(req, res, label, target), summary: result.message }));
      return { message: result.message };
    });
    if ("failure" in outcome) { send(res, outcome.failure); return; }
    res.json({ settings: await money.settings(), message: outcome.message });
  }

  router.put("/money/settings", requireStaff, requirePermission("treasury.manage"), async (req, res) => {
    const b = UpdateMoneySettingsBody.safeParse(req.body);
    if (!b.success) { res.status(400).json({ error: "Send the settings' version and every setting." }); return; }
    const current = await money.settings();
    if (current.treasury.updatedAt !== b.data.version) { res.status(409).json({ error: "Money settings changed since you opened them. Review the latest values and try again." }); return; }
    await asSystem(req, res, "Update money settings", "treasury", (s, by) => updateTreasury(s, b.data.version, b.data.treasury as TreasuryInput, by, new Date()));
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
