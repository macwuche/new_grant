import type { AuditChange, AuditEvent, DemoState, StaffMember } from './model';
import { nextIds } from './core';
import { findApplicant, permissionsOf } from './applicants';
import { assessRisk } from './risk';
import { computeBalances } from './rules';
import { CURRENT_APPLICANT_ID } from './seed';

// Append-only audit trail of staff actions. Entries are added by `asStaff`
// (./staff) in the same step as the change; no rule edits or removes them.
// IP addresses aren't captured: there is no server to see them.

const SKIP = new Set(['updatedAt', 'changeLog']);
const MAX_VALUE = 120;

type Flat = Record<string, string>;

function flatten(value: unknown, prefix: string, out: Flat) {
  if (Array.isArray(value)) {
    if (value.every(v => v === null || typeof v !== 'object')) out[prefix] = JSON.stringify(value);
    else if (value.every(v => v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string')) for (const v of value) flatten(v, `${prefix}.${(v as { id: string }).id}`, out);
    else out[prefix] = `${value.length} entr${value.length === 1 ? 'y' : 'ies'}`;
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) if (!SKIP.has(key)) flatten(v, prefix ? `${prefix}.${key}` : key, out);
  } else {
    const text = value === undefined || value === null ? '—' : String(value);
    out[prefix] = text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
  }
}

/** The record a target id refers to, flattened to field → value. */
/** The current applicant's cards (only they have cards in a rule state), never the PIN. */
function auditedCards(state: DemoState) {
  if (!state.cards.virtual) return { virtual: null, physical: state.cards.physical };
  const { pin: _pin, ...virtual } = state.cards.virtual;
  return { virtual, physical: state.cards.physical };
}

export function snapshot(state: DemoState, target: string): Flat {
  const out: Flat = {};
  const record = target === 'treasury' ? state.treasury
    : target === 'lockdown' ? { lockdown: state.lockdown }
    : target.startsWith('APP-') ? state.applications.find(a => a.id === target)
    : target.startsWith('TX-') ? state.transactions.find(t => t.id === target)
    : target.startsWith('APL-') ? (() => {
      const a = findApplicant(state, target);
      if (!a) return undefined;
      // Balances are derived from the ledger; recording them shows staff money moves as before → after.
      const { grant, deposit, card } = computeBalances(state.transactions.filter(t => t.applicantId === target));
      return { tier: a.tier, identityVerified: a.identityVerified, ...a.account, permissions: permissionsOf(state, target), balances: { grant, deposit, card }, ...(target === CURRENT_APPLICANT_ID ? { cards: auditedCards(state) } : {}) };
    })()
    : target.startsWith('STF-') ? state.staff.find(m => m.id === target)
    : state.grants.find(g => g.id === target);
  if (record) flatten(record, '', out);
  return out;
}

export function diff(before: Flat, after: Flat): AuditChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter(k => before[k] !== after[k]).map(k => ({ field: k, before: before[k] ?? '—', after: after[k] ?? '—' }));
}

/** Applicant a target belongs to, for the audit row and its risk score. */
export function applicantOf(state: DemoState, target: string): string | null {
  if (target.startsWith('APL-')) return target;
  return state.applications.find(a => a.id === target)?.applicantId ?? state.transactions.find(t => t.id === target)?.applicantId ?? null;
}

export function recordAudit(before: DemoState, after: DemoState, actor: StaffMember, action: string, target: string, summary: string, now: Date): DemoState {
  const ids = nextIds(after);
  const applicantId = applicantOf(after, target);
  const event: AuditEvent = {
    id: ids.audit, at: now.toISOString(), staffId: actor.id, staffName: actor.name, role: actor.role, action, target, applicantId, summary,
    changes: diff(snapshot(before, target), snapshot(after, target)),
    riskScore: applicantId ? assessRisk(after, applicantId, now).score : null,
  };
  return { ...after, nextId: ids.nextId, audit: [...after.audit, event] };
}

export type AuditFilter = { query?: string; staffId?: string; action?: string; from?: string; to?: string };

/** Newest first. `from`/`to` are inclusive ISO dates (local days). */
export function filterAudit(state: DemoState, filter: AuditFilter = {}): AuditEvent[] {
  const q = filter.query?.trim().toLowerCase() ?? '';
  const start = filter.from ? new Date(`${filter.from}T00:00:00`).getTime() : -Infinity;
  const end = filter.to ? new Date(`${filter.to}T23:59:59.999`).getTime() : Infinity;
  return [...state.audit].reverse().filter(e => {
    const at = new Date(e.at).getTime();
    if (at < start || at > end) return false;
    if (filter.staffId && e.staffId !== filter.staffId) return false;
    if (filter.action && e.action !== filter.action) return false;
    return !q || `${e.id} ${e.staffName} ${e.action} ${e.target} ${e.summary} ${e.applicantId ?? ''}`.toLowerCase().includes(q);
  });
}

const csvCell = (value: string | number | null) => `"${String(value ?? '').replaceAll('"', '""')}"`;

export function auditToCsv(events: AuditEvent[]): string {
  return [
    '# arc.fund demo audit export — browser-only records, not a compliance record',
    ['id', 'timestamp', 'admin_id', 'admin_user', 'role', 'action', 'entity', 'target_user_id', 'ip_address', 'risk_score', 'summary', 'changes'].join(','),
    ...events.map(e => [e.id, e.at, e.staffId, e.staffName, e.role, e.action, e.target, e.applicantId, e.ip ?? 'not captured', e.riskScore, e.summary,
      e.changes.map(c => `${c.field}: ${c.before} → ${c.after}`).join('; ')].map(csvCell).join(',')),
  ].join('\n');
}

export const auditToJson = (events: AuditEvent[]) => JSON.stringify({ note: 'arc.fund demo audit export — browser-only records, not a compliance record', events }, null, 2);
