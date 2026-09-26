import { useState } from 'react';
import { format } from 'date-fns';
import type { Treasury, TreasuryInput } from '@workspace/domain/model';
import { updateTreasury } from '@workspace/domain/treasury';
import { useDemoStore } from '@/lib/store';
import { RoleNotice, useCan, useStaffCommand } from './AdminStaff';

// Values are edited as strings (fee rate as a percentage) and converted on save.
type ChannelForm = { id: string; name: string; enabled: boolean; min: string; max: string; feeRate: string; feeFixed: string; feeCap: string };
type Form = { channels: ChannelForm[]; physicalCardFee: string; cardDeliveryFee: string; minDeposit: string; maxDeposit: string; depositThreshold: string; highValueDeposit: string; dualControlThreshold: string; applicationFee: string };

const toForm = (t: Treasury): Form => ({
  channels: t.channels.map(c => ({ id: c.id, name: c.name, enabled: c.enabled, min: String(c.min), max: String(c.max), feeRate: String(+(c.feeRate * 100).toFixed(4)), feeFixed: String(c.feeFixed), feeCap: String(c.feeCap) })),
  physicalCardFee: String(t.physicalCardFee), cardDeliveryFee: String(t.cardDeliveryFee), minDeposit: String(t.minDeposit), maxDeposit: String(t.maxDeposit),
  depositThreshold: String(t.depositThreshold), highValueDeposit: String(t.highValueDeposit),
  dualControlThreshold: String(t.dualControlThreshold), applicationFee: String(t.applicationFee),
});
const num = (v: string) => v.trim() === '' ? NaN : Number(v);
const toInput = (f: Form, base: Treasury): TreasuryInput => ({
  channels: f.channels.map(c => ({ ...base.channels.find(o => o.id === c.id)!, enabled: c.enabled, min: num(c.min), max: num(c.max), feeRate: +(num(c.feeRate) / 100).toFixed(6), feeFixed: num(c.feeFixed), feeCap: num(c.feeCap) })),
  physicalCardFee: num(f.physicalCardFee), cardDeliveryFee: num(f.cardDeliveryFee), minDeposit: num(f.minDeposit), maxDeposit: num(f.maxDeposit),
  depositThreshold: num(f.depositThreshold), highValueDeposit: num(f.highValueDeposit),
  dualControlThreshold: num(f.dualControlThreshold), applicationFee: num(f.applicationFee),
});

export function AdminTreasurySettings() {
  const { state } = useDemoStore();
  const command = useStaffCommand();
  const allowed = useCan()('treasury.manage');
  const { treasury } = state;
  const [seenVersion, setSeenVersion] = useState(treasury.updatedAt);
  const [form, setForm] = useState<Form>(() => toForm(treasury));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const stale = treasury.updatedAt !== seenVersion;
  const dirty = JSON.stringify(toForm(treasury)) !== JSON.stringify(form);

  const setChannel = (id: string, key: keyof ChannelForm, value: string | boolean) => {
    setForm(f => ({ ...f, channels: f.channels.map(c => c.id === id ? { ...c, [key]: value } : c) }));
    setErrors(({ [`channels.${id}.${key}`]: _, ...rest }) => rest);
  };
  const setField = (key: Exclude<keyof Form, 'channels'>, value: string) => { setForm(f => ({ ...f, [key]: value })); setErrors(({ [key]: _, ...rest }) => rest); };
  const save = () => {
    const result = command('treasury.manage', { action: 'Update money settings', target: 'treasury' }, (s, actor) => updateTreasury(s, seenVersion, toInput(form, s.treasury), actor.name, new Date()));
    if (!result.ok) { setErrors(result.fieldErrors ?? {}); setFlash({ tone: 'error', text: result.error }); return; }
    setErrors({}); setFlash({ tone: 'ok', text: result.message });
    setSeenVersion(result.state.treasury.updatedAt); setForm(toForm(result.state.treasury));
  };
  const cell = (id: string, key: 'min' | 'max' | 'feeRate' | 'feeFixed' | 'feeCap', label: string, value: string) => {
    const err = errors[`channels.${id}.${key}`];
    return <label className="admin-review-field admin-treasury-cell"><span>{label}</span><input className="admin-input" type="number" inputMode="decimal" step="0.01" min="0" value={value} onChange={e => setChannel(id, key, e.target.value)} aria-invalid={!!err} data-testid={`input-admin-treasury-${id}-${key}`} />{err && <small className="admin-field-error">{err}</small>}</label>;
  };
  const field = (key: Exclude<keyof Form, 'channels'>, label: string, hint: string) => <label className="admin-review-field"><span>{label}</span><input className="admin-input" type="number" inputMode="decimal" step="0.01" min="0" value={form[key]} onChange={e => setField(key, e.target.value)} aria-invalid={!!errors[key]} data-testid={`input-admin-treasury-${key}`} />{errors[key] ? <small className="admin-field-error">{errors[key]}</small> : <small>{hint}</small>}</label>;

  return <section className="admin-panel admin-treasury" aria-labelledby="treasury-title" data-testid="panel-admin-treasury">
    <div className="admin-panel-head"><div><h2 id="treasury-title">Money settings</h2><p>Payout channels, fees, and deposit rules. Changes apply to new requests; pending payouts keep the fee they were quoted. Saved in this browser only.</p></div></div>
    {stale && <div className="admin-review-stale" role="alert"><span>These settings changed since you opened them.</span><button type="button" onClick={() => { setSeenVersion(treasury.updatedAt); setForm(toForm(treasury)); setErrors({}); setFlash(null); }} data-testid="button-admin-treasury-load-latest">Load latest</button></div>}
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-treasury-flash">{flash.text}</div>}
    <RoleNotice permission="treasury.manage" />

    <h3 className="admin-treasury-heading">Payout channels</h3>
    <p className="admin-review-hint">Fee = fixed + percentage, capped at the maximum fee. Limits apply per request.</p>
    <div className="admin-treasury-channels">{form.channels.map(c => <fieldset key={c.id} className={`admin-treasury-channel ${c.enabled ? '' : 'off'}`} data-testid={`fieldset-admin-channel-${c.id}`}>
      <legend><label className="admin-check-row"><input type="checkbox" checked={c.enabled} onChange={e => setChannel(c.id, 'enabled', e.target.checked)} data-testid={`checkbox-admin-channel-${c.id}`} /> <strong>{c.name}</strong> <span className={`admin-badge ${c.enabled ? 'open' : 'draft'}`}>{c.enabled ? 'Enabled' : 'Disabled'}</span></label></legend>
      <div className="admin-treasury-grid">
        {cell(c.id, 'min', 'Min (USD)', c.min)}{cell(c.id, 'max', 'Max (USD)', c.max)}{cell(c.id, 'feeRate', 'Fee %', c.feeRate)}{cell(c.id, 'feeFixed', 'Fixed fee', c.feeFixed)}{cell(c.id, 'feeCap', 'Max fee', c.feeCap)}
      </div>
    </fieldset>)}</div>
    {!form.channels.some(c => c.enabled) && <p className="admin-field-error" role="alert">Every channel is disabled. Applicants won't be able to request payouts.</p>}

    <div className="admin-form-row" style={{ marginTop: 18 }}>
      <div><h3 className="admin-treasury-heading">Fees</h3>{field('physicalCardFee', 'Physical card issuance (USD)', 'Charged to the deposit balance')}{field('cardDeliveryFee', 'Card delivery (USD)', 'Added to the issuance fee; 0 for none')}{field('applicationFee', 'Application processing fee (USD)', 'Charged once per application at first submission; 0 for none')}<h3 className="admin-treasury-heading" style={{ marginTop: 14 }}>Controls</h3>{field('dualControlThreshold', 'Dual-control threshold (USD)', 'Payouts this size or larger need two different staff sign-offs')}</div>
      <div><h3 className="admin-treasury-heading">Deposits</h3>{field('minDeposit', 'Minimum deposit (USD)', 'Per request')}{field('maxDeposit', 'Maximum deposit (USD)', 'Per request')}{field('depositThreshold', 'Required reserve (USD)', 'Deposit balance kept before payouts or card requests')}{field('highValueDeposit', 'High-value flag at (USD)', 'Deposits this size or larger are highlighted for staff')}</div>
    </div>

    <div className="admin-review-buttons">
      {dirty && <button type="button" className="admin-btn" onClick={() => { setForm(toForm(treasury)); setErrors({}); setFlash(null); }} data-testid="button-admin-treasury-discard">Discard edits</button>}
      <button type="button" className="admin-btn primary" disabled={!dirty || stale || !allowed} onClick={save} data-testid="button-admin-treasury-save">Save money settings</button>
    </div>

    <h3 className="admin-treasury-heading" style={{ marginTop: 20 }}>Change log</h3>
    <ol className="admin-review-history">{[...treasury.changeLog].reverse().slice(0, 8).map(c => <li key={`${c.at}-${c.summary}`}><strong>{c.summary}</strong><span>{format(new Date(c.at), 'dd MMM yyyy, HH:mm')} · {c.by}</span></li>)}</ol>
  </section>;
}
