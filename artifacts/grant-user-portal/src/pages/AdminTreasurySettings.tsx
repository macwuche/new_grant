import { useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight } from 'lucide-react';
import { format } from 'date-fns';
import type { Treasury, TreasuryInput } from '@workspace/domain/model';
import { updateTreasury } from '@workspace/domain/treasury';
import * as api from '@workspace/api-client-react';
import { useStaffMoney, type Outcome } from '@/lib/serverData';
import { useDemoStore } from '@/lib/store';
import { RoleNotice, useCan, useStaffCommand } from './AdminStaff';

// Values are edited as strings and converted on save. Withdrawal and deposit methods (with their limits) have their own pages.
type Form = { physicalCardFee: string; cardDeliveryFee: string; depositThreshold: string; highValueDeposit: string; dualControlThreshold: string; depositDualControlThreshold: string; tier1: string; tier2: string; tier3: string };

const toForm = (t: Treasury): Form => ({
  physicalCardFee: String(t.physicalCardFee), cardDeliveryFee: String(t.cardDeliveryFee),
  depositThreshold: String(t.depositThreshold), highValueDeposit: String(t.highValueDeposit),
  dualControlThreshold: String(t.dualControlThreshold), depositDualControlThreshold: String(t.depositDualControlThreshold),
  tier1: String(t.tierEligibleAmounts.tier1), tier2: String(t.tierEligibleAmounts.tier2), tier3: String(t.tierEligibleAmounts.tier3),
});
const num = (v: string) => v.trim() === '' ? NaN : Number(v);
const toInput = (f: Form): TreasuryInput => ({
  physicalCardFee: num(f.physicalCardFee), cardDeliveryFee: num(f.cardDeliveryFee),
  depositThreshold: num(f.depositThreshold), highValueDeposit: num(f.highValueDeposit),
  dualControlThreshold: num(f.dualControlThreshold), depositDualControlThreshold: num(f.depositDualControlThreshold),
  tierEligibleAmounts: { tier1: num(f.tier1), tier2: num(f.tier2), tier3: num(f.tier3) },
});
/** Field errors for tier amounts come keyed `tierEligibleAmounts.tier1`; the form keys them `tier1`. */
const formErrors = (errors: Record<string, string>) => Object.fromEntries(Object.entries(errors).map(([k, v]) => [k.replace(/^tierEligibleAmounts\./, ''), v]));

export function AdminTreasurySettings() {
  const { state } = useDemoStore();
  const command = useStaffCommand();
  const staffMoney = useStaffMoney();
  const allowed = useCan()('treasury.manage');
  const { treasury } = state;
  const [seenVersion, setSeenVersion] = useState(treasury.updatedAt);
  const [form, setForm] = useState<Form>(() => toForm(treasury));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const stale = treasury.updatedAt !== seenVersion;
  const dirty = JSON.stringify(toForm(treasury)) !== JSON.stringify(form);

  const setField = (key: keyof Form, value: string) => { setForm(f => ({ ...f, [key]: value })); setErrors(({ [key]: _, ...rest }) => rest); };
  const save = async () => {
    const result = staffMoney.connected
      ? await staffMoney.settings(() => api.updateMoneySettings({ version: seenVersion, treasury: toInput(form) }))
      : (r => r.ok ? { ...r, treasury: r.state.treasury } : r)(command('treasury.manage', { action: 'Update money settings', target: 'treasury' }, (s, actor) => updateTreasury(s, seenVersion, toInput(form), actor.name, new Date())));
    if (!result.ok) { setErrors(formErrors(result.fieldErrors ?? {})); setFlash({ tone: 'error', text: result.error }); return; }
    setErrors({}); setFlash({ tone: 'ok', text: result.message });
    if (result.treasury) { setSeenVersion(result.treasury.updatedAt); setForm(toForm(result.treasury)); }
  };
  const field = (key: keyof Form, label: string, hint: string) => <label className="admin-review-field"><span>{label}</span><input className="admin-input" type="number" inputMode="decimal" step="0.01" min="0" value={form[key]} onChange={e => setField(key, e.target.value)} aria-invalid={!!errors[key]} data-testid={`input-admin-treasury-${key}`} />{errors[key] ? <small className="admin-field-error">{errors[key]}</small> : <small>{hint}</small>}</label>;

  return <section className="admin-panel admin-treasury" aria-labelledby="treasury-title" data-testid="panel-admin-treasury">
    <div className="admin-panel-head"><div><h2 id="treasury-title">Money settings</h2><p>Card fees, the deposit reserve, the two-person thresholds, and the eligible amount for each tier. Changes apply to new requests. {staffMoney.connected ? 'Saved on the server.' : 'Saved in this browser only.'}</p></div></div>
    {stale && <div className="admin-review-stale" role="alert"><span>These settings changed since you opened them.</span><button type="button" onClick={() => { setSeenVersion(treasury.updatedAt); setForm(toForm(treasury)); setErrors({}); setFlash(null); }} data-testid="button-admin-treasury-load-latest">Load latest</button></div>}
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-treasury-flash">{flash.text}</div>}
    <RoleNotice permission="treasury.manage" />

    <Link href="/admin/settings/withdrawal-methods" className="admin-setting-item" style={{ textDecoration: 'none', color: 'inherit' }} data-testid="link-admin-withdrawal-methods">
      <ArrowRight size={18} /><div><strong>Withdrawal methods</strong><p>{treasury.channels.filter(c => c.enabled).length} of {treasury.channels.length} available to users. Create, edit, hide, or delete them, with their limits, charges, and forms.</p></div><span>OPEN</span>
    </Link>
    <Link href="/admin/settings/deposit-methods" className="admin-setting-item" style={{ textDecoration: 'none', color: 'inherit' }} data-testid="link-admin-deposit-methods">
      <ArrowRight size={18} /><div><strong>Deposit methods</strong><p>{treasury.depositMethods.filter(m => m.enabled).length} of {treasury.depositMethods.length} available to users. Where users send money, with each method's limits, charges, proof of payment, and form.</p></div><span>OPEN</span>
    </Link>

    <div className="admin-form-row" style={{ marginTop: 18 }}>
      <div><h3 className="admin-treasury-heading">Fees</h3>{field('physicalCardFee', 'Physical card issuance (USD)', 'Charged to the deposit balance')}{field('cardDeliveryFee', 'Card delivery (USD)', 'Added to the issuance fee; 0 for none')}<h3 className="admin-treasury-heading" style={{ marginTop: 14 }}>Controls</h3>{field('dualControlThreshold', 'Payout two-person threshold (USD)', 'Payouts this size or larger need two different staff sign-offs')}{field('depositDualControlThreshold', 'Deposit two-person threshold (USD)', 'Deposits this size or larger need a second staff member\'s approval before confirming; 0 for never')}</div>
      <div><h3 className="admin-treasury-heading">Deposits</h3><p className="admin-review-hint">Deposit limits are set on each deposit method.</p>{field('depositThreshold', 'Required reserve (USD)', 'Deposit balance kept before payouts from it or card requests (grant payouts don\'t need it)')}{field('highValueDeposit', 'High-value flag at (USD)', 'Deposits this size or larger are highlighted for staff')}</div>
    </div>

    <h3 className="admin-treasury-heading" style={{ marginTop: 14 }}>Eligible amount by tier</h3>
    <p className="admin-review-hint">Shown on each applicant's dashboard for their account tier. It's a figure to show only: it doesn't limit requests (each plan's maximum award does) and can't be withdrawn. 0 means not set: the dashboard then shows the largest award the applicant can currently apply for.</p>
    <div className="admin-form-row">{field('tier1', 'Tier 1 (USD)', 'Eligible amount for Tier 1 accounts')}{field('tier2', 'Tier 2 (USD)', 'Eligible amount for Tier 2 accounts')}{field('tier3', 'Tier 3 (USD)', 'Eligible amount for Tier 3 accounts')}</div>

    <div className="admin-review-buttons">
      {dirty && <button type="button" className="admin-btn" onClick={() => { setForm(toForm(treasury)); setErrors({}); setFlash(null); }} data-testid="button-admin-treasury-discard">Discard edits</button>}
      <button type="button" className="admin-btn primary" disabled={!dirty || stale || !allowed} onClick={save} data-testid="button-admin-treasury-save">Save money settings</button>
    </div>

    <h3 className="admin-treasury-heading" style={{ marginTop: 20 }}>Change log</h3>
    <ol className="admin-review-history">{[...treasury.changeLog].reverse().slice(0, 8).map(c => <li key={`${c.at}-${c.summary}`}><strong>{c.summary}</strong><span>{format(new Date(c.at), 'dd MMM yyyy, HH:mm')} · {c.by}</span></li>)}</ol>
  </section>;
}
