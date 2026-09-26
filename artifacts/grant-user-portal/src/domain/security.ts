import type { DemoState, Result } from './model';
import { fail, usd } from './core';
import { logStaff } from './activity';
import { notify } from './notifications';
import { MIN_REASON_LENGTH } from './accounts';

// Emergency system lockdown. While active, applicants can't request payouts and
// staff can't release or mark payouts paid (marking one failed, which returns
// the funds, still works). Deposits and reviews continue.

export function startLockdown(state: DemoState, reason: string, by: string, now: Date): Result {
  if (state.lockdown) return fail(`A lockdown is already active (since ${new Date(state.lockdown.since).toLocaleString('en-US')}).`);
  const text = reason.trim();
  if (text.length < MIN_REASON_LENGTH) return fail('Explain why the system is being locked down.', { reason: `Write at least ${MIN_REASON_LENGTH} characters.` });
  let next: DemoState = { ...state, lockdown: { since: now.toISOString(), by, reason: text } };
  const pending = state.transactions.filter(t => t.type === 'Withdrawal' && t.status === 'Pending');
  for (const applicantId of new Set(pending.map(t => t.applicantId))) {
    next = notify(next, applicantId, 'Payouts paused', 'Payouts are temporarily paused while the team completes a security check. Your pending request is safe and will be processed afterwards.', '/withdrawals', now);
  }
  const held = pending.reduce((sum, t) => sum + Math.abs(t.amount), 0);
  next = logStaff(next, { kind: 'security', highlight: true, title: 'System lockdown started', body: `${by}: ${text}`, href: '/admin/security' }, now);
  return { ok: true, id: 'lockdown', message: `Lockdown active. ${pending.length} pending payout${pending.length === 1 ? '' : 's'} (${usd(held)}) frozen and new payout requests blocked.`, state: next };
}

export function endLockdown(state: DemoState, by: string, now: Date): Result {
  if (!state.lockdown) return fail('No lockdown is active.');
  const next = logStaff({ ...state, lockdown: null }, { kind: 'security', title: 'System lockdown ended', body: `Lifted by ${by}. Payouts can be requested and processed again.`, href: '/admin/security' }, now);
  return { ok: true, id: 'lockdown', message: 'Lockdown lifted. Payouts can be requested and processed again.', state: next };
}

export const lockdownMessage = (state: DemoState) => state.lockdown ? 'Payouts are temporarily paused while the team completes a security check.' : null;
