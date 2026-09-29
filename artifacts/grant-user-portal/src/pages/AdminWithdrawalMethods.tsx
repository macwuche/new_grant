import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Clock3, Image as ImageIcon, Link2, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import * as api from '@workspace/api-client-react';
import type { MethodFieldType, Result, Treasury, WithdrawalMethod, WithdrawalSource } from '@workspace/domain/model';
import { channelFee } from '@workspace/domain/money';
import {
  chargesLabel, createMethod, deleteMethod, FIELD_TYPES, MAX_FIELDS, MAX_METHOD_PHOTO_BYTES, MAX_PREVIEW_PHOTO_BYTES, setMethodAvailability, SOURCE_LABELS, updateMethod,
  validateMethod, type MethodInput,
} from '@workspace/domain/withdrawalMethods';
import { MethodBadge } from '@/components/MethodBadge';
import { useStaffMoney, type Outcome } from '@/lib/serverData';
import { useDemoStore } from '@/lib/store';
import { RoleNotice, useCan, useStaffCommand } from './AdminStaff';
import './AdminWithdrawalMethods.css';

// Settings → Withdrawal methods: finance creates the ways applicants can be
// paid out, with limits, charges, processing time, instructions, a photo (a
// link, an upload, or the method's first letter), the balance it pays from,
// and the form applicants fill in. Methods can be edited, hidden from users,
// or deleted. Signed in, changes go through the API (photos are stored on the
// API server); in preview mode they're kept in this browser.

type Flash = { tone: 'ok' | 'error'; text: string } | null;
type PhotoMode = 'none' | 'link' | 'upload';
/** A form field as edited; `key` is only for React, `id` is kept for existing fields. */
type FieldDraft = { key: string; id?: string; label: string; type: MethodFieldType; required: boolean; placeholder: string; help: string; options: string };
type Draft = {
  name: string; enabled: boolean; min: string; max: string; feeRate: string; feeFixed: string; feeCap: string; processingTime: string; instructions: string;
  photoMode: PhotoMode; photoLink: string; source: WithdrawalSource; formTitle: string; fields: FieldDraft[];
};
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: string) => v.trim() === '' ? NaN : Number(v);
let keySeq = 0;
const nextKey = () => `f${++keySeq}`;

const emptyDraft = (): Draft => ({
  name: '', enabled: true, min: '10', max: '1000', feeRate: '0', feeFixed: '0', feeCap: '0', processingTime: '', instructions: '',
  photoMode: 'none', photoLink: '', source: 'grant', formTitle: '', fields: [],
});
const toDraft = (m: WithdrawalMethod): Draft => ({
  name: m.name, enabled: m.enabled, min: String(m.min), max: String(m.max), feeRate: String(+(m.feeRate * 100).toFixed(4)), feeFixed: String(m.feeFixed), feeCap: String(m.feeCap),
  processingTime: m.processingTime, instructions: m.instructions,
  photoMode: !m.photoUrl ? 'none' : m.photoUrl.startsWith('https://') ? 'link' : 'upload', photoLink: m.photoUrl.startsWith('https://') ? m.photoUrl : '',
  source: m.source, formTitle: m.formTitle,
  fields: m.fields.map(f => ({ key: nextKey(), id: f.id, label: f.label, type: f.type, required: f.required, placeholder: f.placeholder, help: f.help, options: f.options.join('\n') })),
});
/** The draft as the rules and API take it; `photoUrl` for uploads is filled in by the caller. */
const toInput = (d: Draft, photoUrl: string): MethodInput => ({
  name: d.name, enabled: d.enabled, min: num(d.min), max: num(d.max), feeRate: +(num(d.feeRate) / 100).toFixed(6), feeFixed: num(d.feeFixed), feeCap: num(d.feeCap),
  processingTime: d.processingTime, instructions: d.instructions, photoUrl, source: d.source, formTitle: d.formTitle,
  fields: d.fields.map(f => ({ ...(f.id ? { id: f.id } : {}), label: f.label, type: f.type, required: f.required, placeholder: f.placeholder, help: f.help, options: f.type === 'select' ? f.options.split('\n') : [] })),
});

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
}

/** Staff actions in both modes: the API when signed in, the browser rule otherwise. */
function useMethodActions() {
  const command = useStaffCommand();
  const staffMoney = useStaffMoney();
  const local = (action: string, target: string, rule: (s: Parameters<Parameters<typeof command>[2]>[0], by: string) => Result) => {
    const r = command('treasury.manage', { action, target }, (s, actor) => rule(s, actor.name));
    return r.ok ? { ok: true as const, message: r.message, id: r.id, treasury: r.state.treasury } : r;
  };
  return { connected: staffMoney.connected, local, remote: (call: () => Promise<api.MoneySettingsResult>) => staffMoney.settings(call) };
}

// ---------- The list ----------

export function AdminWithdrawalMethods() {
  const { state } = useDemoStore();
  const allowed = useCan()('treasury.manage');
  const actions = useMethodActions();
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const methods = state.treasury.channels;
  const available = methods.filter(m => m.enabled).length;

  const report = (r: Outcome | (Result & { ok: false }) | { ok: true; message: string }) => setFlash(r.ok ? { tone: 'ok', text: r.message } : { tone: 'error', text: r.error });
  const toggle = async (m: WithdrawalMethod) => {
    setBusy(m.id);
    report(actions.connected
      ? await actions.remote(() => api.setWithdrawalMethodAvailability(m.id, { enabled: !m.enabled }))
      : actions.local(m.enabled ? 'Make withdrawal method unavailable' : 'Make withdrawal method available', m.id, (s, by) => setMethodAvailability(s, m.id, !m.enabled, by, new Date())));
    setBusy(null);
  };
  const remove = async (m: WithdrawalMethod) => {
    setBusy(m.id);
    report(actions.connected
      ? await actions.remote(() => api.deleteWithdrawalMethod(m.id))
      : actions.local('Delete withdrawal method', m.id, (s, by) => deleteMethod(s, m.id, by, new Date())));
    setBusy(null); setConfirmDelete(null);
  };

  if (editing) {
    return <MethodEditor methodId={editing.id} onClose={message => { setEditing(null); if (message) setFlash({ tone: 'ok', text: message }); }} />;
  }

  return <section className="admin-panel wm-panel" aria-labelledby="wm-title" data-testid="panel-admin-withdrawal-methods">
    <div className="admin-panel-head"><div><h2 id="wm-title">Withdrawal methods</h2><p>{available} of {methods.length} available to users. Users see available methods on their withdrawal page, fill in the method's form, and finance pays them outside the app. {actions.connected ? 'Saved on the server.' : 'Saved in this browser only.'}</p></div>
      <button type="button" className="admin-btn primary" disabled={!allowed} onClick={() => { setFlash(null); setEditing({ id: null }); }} data-testid="button-admin-add-method"><Plus size={14} /> Add method</button></div>
    <RoleNotice permission="treasury.manage" />
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-methods-flash">{flash.text}</div>}
    {!available && methods.length > 0 && <p className="admin-field-error" role="alert" data-testid="notice-admin-no-methods">No method is available, so users can't request payouts.</p>}
    {methods.length ? <ul className="wm-list" data-testid="list-admin-methods">{methods.map(m => <li key={m.id} className={`wm-card ${m.enabled ? '' : 'off'}`} data-testid={`card-admin-method-${m.id}`}>
      <div className="wm-card-top">
        <MethodBadge name={m.name} photoUrl={m.photoUrl} size={44} testId={`badge-admin-method-${m.id}`} />
        <div className="wm-card-title"><strong>{m.name}</strong><span className={`admin-badge ${m.enabled ? 'active' : 'draft'}`} data-testid={`status-admin-method-${m.id}`}>{m.enabled ? 'Available' : 'Unavailable'}</span></div>
        <button type="button" role="switch" aria-checked={m.enabled} aria-label={`${m.name} available to users`} className="wm-switch" disabled={!allowed || busy === m.id} onClick={() => void toggle(m)} data-testid={`switch-admin-method-${m.id}`}><span /></button>
      </div>
      <dl className="wm-facts">
        <div><dt>Limits</dt><dd>{usd(m.min)} – {usd(m.max)}</dd></div>
        <div><dt>Charges</dt><dd>{chargesLabel(m)}</dd></div>
        <div><dt>Processing</dt><dd>{m.processingTime}</dd></div>
        <div><dt>Pays from</dt><dd>{SOURCE_LABELS[m.source]}</dd></div>
        <div className="wide"><dt>Form</dt><dd>{m.fields.length ? `${m.formTitle} · ${m.fields.length} field${m.fields.length === 1 ? '' : 's'}` : 'No form'}</dd></div>
      </dl>
      {confirmDelete === m.id
        ? <div className="wm-confirm" role="group" aria-label={`Delete ${m.name}`}><span>Delete {m.name}? Pending requests keep their details and can still be processed.</span>
          <div className="admin-review-buttons"><button type="button" className="admin-btn" onClick={() => setConfirmDelete(null)} data-testid={`button-admin-keep-method-${m.id}`}>Keep</button>
            <button type="button" className="admin-btn danger" disabled={busy === m.id} onClick={() => void remove(m)} data-testid={`button-admin-confirm-delete-method-${m.id}`}>Delete</button></div></div>
        : <div className="admin-review-buttons wm-card-actions">
          <button type="button" className="admin-btn" disabled={!allowed} onClick={() => setConfirmDelete(m.id)} data-testid={`button-admin-delete-method-${m.id}`}><Trash2 size={13} /> Delete</button>
          <button type="button" className="admin-btn primary" disabled={!allowed} onClick={() => { setFlash(null); setEditing({ id: m.id }); }} data-testid={`button-admin-edit-method-${m.id}`}><Pencil size={13} /> Edit</button>
        </div>}
    </li>)}</ul>
      : <div className="admin-empty" data-testid="empty-admin-methods"><ImageIcon size={25} /><h3>No withdrawal methods</h3><p>Add one so users can request payouts.</p></div>}
  </section>;
}

// ---------- The editor ----------

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <small className="admin-field-error" id={id} role="alert">{message}</small> : null;
}

function MethodEditor({ methodId, onClose }: { methodId: string | null; onClose: (message?: string) => void }) {
  const { state } = useDemoStore();
  const allowed = useCan()('treasury.manage');
  const actions = useMethodActions();
  const existing = methodId ? state.treasury.channels.find(m => m.id === methodId) ?? null : null;
  const [seenVersion] = useState(state.treasury.updatedAt);
  const [draft, setDraft] = useState<Draft>(() => existing ? toDraft(existing) : emptyDraft());
  const [upload, setUpload] = useState<{ file: File; preview: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<Flash>(null);
  const [saving, setSaving] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const stale = state.treasury.updatedAt !== seenVersion;
  useEffect(() => { headingRef.current?.focus(); }, []);
  useEffect(() => () => { if (upload?.preview.startsWith('blob:')) URL.revokeObjectURL(upload.preview); }, [upload]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => { setDraft(d => ({ ...d, [key]: value })); setErrors(({ [key]: _, ...rest }) => rest); };
  const setField = (i: number, patch: Partial<FieldDraft>) => {
    setDraft(d => ({ ...d, fields: d.fields.map((f, j) => j === i ? { ...f, ...patch } : f) }));
    setErrors(e => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith(`fields.${i}.`) && k !== 'fields')));
  };
  /** Reordering or removing shifts the indexes that field errors are keyed by, so those errors are cleared. */
  const reshape = (fields: FieldDraft[]) => { setDraft(d => ({ ...d, fields })); setErrors(e => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('fields')))); };
  const move = (i: number, by: -1 | 1) => { const f = [...draft.fields]; const [x] = f.splice(i, 1); f.splice(i + by, 0, x!); reshape(f); };

  /** What the photo is right now: an upload being chosen, the method's current upload, a link, or none. */
  const currentUpload = existing && existing.photoUrl && !existing.photoUrl.startsWith('https://') ? existing.photoUrl : '';
  const photoPreview = draft.photoMode === 'link' ? draft.photoLink.trim() : draft.photoMode === 'upload' ? upload?.preview ?? currentUpload : '';

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    const limit = actions.connected ? MAX_METHOD_PHOTO_BYTES : MAX_PREVIEW_PHOTO_BYTES;
    if (!PHOTO_TYPES.includes(file.type)) { setErrors(e => ({ ...e, photoUrl: 'Choose a JPG, PNG, or WEBP image.' })); return; }
    if (file.size > limit) { setErrors(e => ({ ...e, photoUrl: `Photos can be at most ${limit >= 1024 * 1024 ? `${limit / 1024 / 1024} MB` : `${limit / 1024} KB`}${actions.connected ? '' : ' in this preview'}.` })); return; }
    // Preview mode keeps the photo in the browser as a data: URL; signed in, it's uploaded after saving.
    const preview = actions.connected ? URL.createObjectURL(file) : await readAsDataUrl(file);
    setUpload({ file, preview });
    setErrors(({ photoUrl: _, ...rest }) => rest);
  };

  const photoUrlFor = (): string => {
    if (draft.photoMode === 'link') return draft.photoLink;
    if (draft.photoMode === 'none') return '';
    if (upload) return actions.connected ? currentUpload : upload.preview; // signed in: the new file is uploaded after saving
    return currentUpload;
  };

  const save = async () => {
    const photoUrl = photoUrlFor();
    const input = toInput(draft, photoUrl);
    // Check here first so every field shows its message before anything is sent.
    const found = validateMethod(input, state.treasury.channels, existing ?? undefined);
    if (draft.photoMode === 'upload' && !upload && !currentUpload) found.photoUrl = 'Choose a photo to upload.';
    if (Object.keys(found).length) { setErrors(found); setFlash({ tone: 'error', text: 'Fix the highlighted fields.' }); return; }
    setSaving(true); setFlash(null);
    let result: Outcome & { treasury?: Treasury; id?: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };
    if (actions.connected) {
      result = await actions.remote(() => existing ? api.updateWithdrawalMethod(existing.id, { version: seenVersion, method: input }) : api.createWithdrawalMethod({ version: seenVersion, method: input }));
      // Only a new photo chosen: the method itself is unchanged, so go straight to the upload.
      if (!result.ok && existing && upload && result.error === 'Nothing has changed.') result = { ok: true, message: `${existing.name} saved.` };
      const id = existing?.id ?? (result.ok ? result.treasury?.channels.find(c => c.name === input.name.trim())?.id : undefined);
      if (result.ok && upload && draft.photoMode === 'upload' && id) {
        const uploaded = await actions.remote(() => api.uploadWithdrawalMethodPhoto(id, upload.file));
        if (!uploaded.ok) result = { ok: false, error: `The method was saved, but the photo wasn't: ${uploaded.error}` };
      }
    } else {
      result = actions.local(existing ? 'Edit withdrawal method' : 'Add withdrawal method', existing?.id ?? 'treasury',
        (s, by) => existing ? updateMethod(s, seenVersion, existing.id, input, by, new Date()) : createMethod(s, seenVersion, input, by, new Date()));
    }
    setSaving(false);
    if (!result.ok) { setErrors(result.fieldErrors ?? {}); setFlash({ tone: 'error', text: result.error }); return; }
    onClose(result.message);
  };

  const err = (key: string) => errors[key];
  const aria = (key: string) => ({ 'aria-invalid': !!errors[key], 'aria-describedby': errors[key] ? `${uid}-${key}` : undefined });
  const text = (key: 'name' | 'processingTime' | 'formTitle', label: string, hint: string, placeholder: string) => <label className="admin-review-field">
    <span>{label}</span><input className="admin-input" value={draft[key]} onChange={e => set(key, e.target.value)} placeholder={placeholder} {...aria(key)} data-testid={`input-method-${key}`} />
    {err(key) ? <FieldError id={`${uid}-${key}`} message={err(key)} /> : <small>{hint}</small>}
  </label>;
  const amount = (key: 'min' | 'max' | 'feeRate' | 'feeFixed' | 'feeCap', label: string, hint: string) => <label className="admin-review-field">
    <span>{label}</span><input className="admin-input" type="number" inputMode="decimal" step="0.01" min="0" value={draft[key]} onChange={e => set(key, e.target.value)} {...aria(key)} data-testid={`input-method-${key}`} />
    {err(key) ? <FieldError id={`${uid}-${key}`} message={err(key)} /> : <small>{hint}</small>}
  </label>;

  const example = 100;
  const exampleFee = channelFee({ feeFixed: num(draft.feeFixed) || 0, feeRate: (num(draft.feeRate) || 0) / 100, feeCap: num(draft.feeCap) || 0 }, example);

  return <section className="admin-panel wm-panel" aria-labelledby="wm-editor-title" data-testid="panel-admin-method-editor">
    <button type="button" className="admin-settings-back wm-back" onClick={() => onClose()} data-testid="button-admin-method-back"><ArrowLeft size={14} /> All withdrawal methods</button>
    <div className="admin-panel-head"><div><h2 id="wm-editor-title" ref={headingRef} tabIndex={-1}>{existing ? `Edit ${existing.name}` : 'New withdrawal method'}</h2>
      <p>Changes apply to new requests; pending requests keep the charges and details they were made with.</p></div></div>
    <RoleNotice permission="treasury.manage" />
    {stale && <div className="admin-review-stale" role="alert"><span>Withdrawal methods changed since you opened this. Go back and open it again to see the latest version.</span></div>}
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-method-flash">{flash.text}</div>}

    <form className="wm-editor" noValidate onSubmit={e => { e.preventDefault(); void save(); }}>
      <fieldset className="wm-section" disabled={!allowed}><legend>Method</legend>
        <div className="wm-grid-2">
          {text('name', 'Method name', 'Shown to users, e.g. "PayPal" or "Crypto (USDT)".', 'e.g. PayPal')}
          <div className="admin-review-field"><span>Available to users</span>
            <label className="admin-check-row"><input type="checkbox" checked={draft.enabled} onChange={e => set('enabled', e.target.checked)} data-testid="checkbox-method-enabled" /> Show it on the withdrawal page</label>
            <small>Unavailable methods are kept but hidden from users.</small></div>
        </div>
        <div className="admin-review-field"><span>Photo (optional)</span>
          <div className="wm-photo">
            <MethodBadge name={draft.name || '?'} photoUrl={photoPreview} size={64} testId="badge-method-preview" />
            <div className="wm-photo-controls">
              <div className="admin-segment" role="radiogroup" aria-label="Photo">{([['none', 'First letter'], ['link', 'Photo link'], ['upload', 'Upload']] as const).map(([mode, label]) =>
                <button key={mode} type="button" role="radio" aria-checked={draft.photoMode === mode} className={draft.photoMode === mode ? 'active' : ''} onClick={() => set('photoMode', mode)} data-testid={`button-photo-mode-${mode}`}>{label}</button>)}</div>
              {draft.photoMode === 'none' && <small>Users see the first letter of the name{draft.name.trim() ? ` ("${draft.name.trim()[0]!.toUpperCase()}")` : ''}.</small>}
              {draft.photoMode === 'link' && <><div className="wm-inline"><Link2 size={14} aria-hidden="true" /><input className="admin-input" type="url" inputMode="url" value={draft.photoLink} onChange={e => { set('photoLink', e.target.value); setErrors(({ photoUrl: _, ...r }) => r); }} placeholder="https://…/logo.png" aria-label="Photo link" {...aria('photoUrl')} data-testid="input-method-photo-link" /></div>
                <small>A secure (https) link to a JPG, PNG, or WEBP image.</small></>}
              {draft.photoMode === 'upload' && <><div className="wm-inline"><button type="button" className="admin-btn" onClick={() => fileRef.current?.click()} data-testid="button-method-photo-choose"><Upload size={13} /> {upload || currentUpload ? 'Choose another photo' : 'Choose a photo'}</button>
                {upload && <span className="wm-file-name">{upload.file.name}</span>}</div>
                <input ref={fileRef} type="file" hidden accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={e => { void pickFile(e.target.files?.[0]); e.target.value = ''; }} data-testid="input-method-photo-file" />
                <small>JPG, PNG, or WEBP, up to {actions.connected ? '2 MB' : '400 KB in this preview'}.</small></>}
              <FieldError id={`${uid}-photoUrl`} message={err('photoUrl')} />
            </div>
          </div>
        </div>
      </fieldset>

      <fieldset className="wm-section" disabled={!allowed}><legend>Limits and charges</legend>
        <div className="wm-grid-2">{amount('min', 'Minimum withdrawal (USD)', 'Per request.')}{amount('max', 'Maximum withdrawal (USD)', 'Per request.')}</div>
        <div className="wm-grid-3">{amount('feeRate', 'Charge (%)', 'Of the amount, 0–10%.')}{amount('feeFixed', 'Fixed charge (USD)', 'Added to the percentage.')}{amount('feeCap', 'Maximum charge (USD)', '0 for no maximum.')}</div>
        <p className="admin-review-hint" data-testid="text-method-fee-example">On a {usd(example)} request: {chargesLabel({ feeFixed: num(draft.feeFixed) || 0, feeRate: (num(draft.feeRate) || 0) / 100, feeCap: num(draft.feeCap) || 0 })} → charge {usd(exampleFee)}, the user receives {usd(example - exampleFee)}.</p>
      </fieldset>

      <fieldset className="wm-section" disabled={!allowed}><legend>Processing and instructions</legend>
        {text('processingTime', 'Processing time', 'Shown to users before they request.', 'e.g. 1–2 business days')}
        <label className="admin-review-field"><span>Withdrawal instructions (optional)</span>
          <textarea className="admin-input" rows={3} value={draft.instructions} onChange={e => set('instructions', e.target.value)} placeholder="e.g. Only USDT on the TRON (TRC-20) network." {...aria('instructions')} data-testid="textarea-method-instructions" />
          {err('instructions') ? <FieldError id={`${uid}-instructions`} message={err('instructions')} /> : <small>Shown to users with the method's form.</small>}</label>
      </fieldset>

      <fieldset className="wm-section" disabled={!allowed}><legend>Balance users withdraw from</legend>
        <div className="wm-sources" role="radiogroup" aria-label="Balance">{(['grant', 'deposit', 'both'] as const).map(source => <label key={source} className={`wm-source ${draft.source === source ? 'active' : ''}`}>
          <input type="radio" name={`${uid}-source`} checked={draft.source === source} onChange={() => set('source', source)} data-testid={`radio-method-source-${source}`} />
          <span><strong>{source === 'both' ? 'Both' : SOURCE_LABELS[source]}</strong><small>{source === 'grant' ? 'Awarded funds.' : source === 'deposit' ? 'Funds the user added; the reserve stays.' : 'The user chooses which balance.'}</small></span>
        </label>)}</div>
        <FieldError id={`${uid}-source`} message={err('source')} />
        <p className="admin-review-hint">"Eligible amount" is what a user could apply for, not money, so it can't be withdrawn.</p>
      </fieldset>

      <fieldset className="wm-section" disabled={!allowed}><legend>The form users fill in</legend>
        <p className="admin-review-hint">Ask for what finance needs to send the money, e.g. an email address or a wallet address. Users' last answers are remembered for their next request.</p>
        {text('formTitle', 'Form name', 'e.g. "Wallet details". Needed when the form has fields.', 'e.g. Wallet details')}
        <ol className="wm-fields" data-testid="list-method-fields">{draft.fields.map((f, i) => {
          const k = (name: string) => `fields.${i}.${name}`;
          return <li key={f.key} className="wm-field" data-testid={`row-method-field-${i}`}>
            <div className="wm-field-head"><strong>Field {i + 1}</strong>
              <div className="wm-field-tools">
                <button type="button" className="admin-icon-button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move field ${i + 1} up`} data-testid={`button-field-up-${i}`}><ArrowUp size={13} /></button>
                <button type="button" className="admin-icon-button" disabled={i === draft.fields.length - 1} onClick={() => move(i, 1)} aria-label={`Move field ${i + 1} down`} data-testid={`button-field-down-${i}`}><ArrowDown size={13} /></button>
                <button type="button" className="admin-icon-button" onClick={() => reshape(draft.fields.filter((_, j) => j !== i))} aria-label={`Remove field ${i + 1}`} data-testid={`button-field-remove-${i}`}><X size={13} /></button>
              </div></div>
            <div className="wm-grid-2">
              <label className="admin-review-field"><span>Label</span><input className="admin-input" value={f.label} onChange={e => setField(i, { label: e.target.value })} placeholder="e.g. Email address" {...aria(k('label'))} data-testid={`input-field-label-${i}`} /><FieldError id={`${uid}-${k('label')}`} message={err(k('label'))} /></label>
              <label className="admin-review-field"><span>Type</span><select className="admin-input" value={f.type} onChange={e => setField(i, { type: e.target.value as MethodFieldType })} data-testid={`select-field-type-${i}`}>{FIELD_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
            </div>
            {f.type === 'select' && <label className="admin-review-field"><span>Choices (one per line)</span><textarea className="admin-input" rows={3} value={f.options} onChange={e => setField(i, { options: e.target.value })} placeholder={'e.g.\nMTN\nAirtel'} {...aria(k('options'))} data-testid={`textarea-field-options-${i}`} /><FieldError id={`${uid}-${k('options')}`} message={err(k('options'))} /></label>}
            <div className="wm-grid-2">
              <label className="admin-review-field"><span>Placeholder (optional)</span><input className="admin-input" value={f.placeholder} onChange={e => setField(i, { placeholder: e.target.value })} {...aria(k('placeholder'))} data-testid={`input-field-placeholder-${i}`} /><FieldError id={`${uid}-${k('placeholder')}`} message={err(k('placeholder'))} /></label>
              <label className="admin-review-field"><span>Help text (optional)</span><input className="admin-input" value={f.help} onChange={e => setField(i, { help: e.target.value })} {...aria(k('help'))} data-testid={`input-field-help-${i}`} /><FieldError id={`${uid}-${k('help')}`} message={err(k('help'))} /></label>
            </div>
            <label className="admin-check-row"><input type="checkbox" checked={f.required} onChange={e => setField(i, { required: e.target.checked })} data-testid={`checkbox-field-required-${i}`} /> Required</label>
          </li>;
        })}</ol>
        <FieldError id={`${uid}-fields`} message={err('fields')} />
        <button type="button" className="admin-btn" disabled={draft.fields.length >= MAX_FIELDS} onClick={() => setDraft(d => ({ ...d, fields: [...d.fields, { key: nextKey(), label: '', type: 'text', required: true, placeholder: '', help: '', options: '' }] }))} data-testid="button-add-field"><Plus size={13} /> Add field</button>
        {draft.fields.length > 0 && <FormPreview draft={draft} />}
      </fieldset>

      <div className="admin-review-buttons wm-save">
        <button type="button" className="admin-btn" onClick={() => onClose()} data-testid="button-admin-method-cancel">Cancel</button>
        <button type="submit" className="admin-btn primary" disabled={!allowed || saving || stale} data-testid="button-admin-method-save">{saving ? 'Saving…' : existing ? 'Save method' : 'Add method'}</button>
      </div>
    </form>
  </section>;
}

/** How users will see the form (inputs are inert). */
function FormPreview({ draft }: { draft: Draft }) {
  return <div className="wm-preview" aria-label="Form preview" data-testid="panel-method-form-preview">
    <span className="wm-preview-tag">Preview</span>
    <strong>{draft.formTitle.trim() || 'Form name'}</strong>
    {draft.processingTime.trim() && <small className="wm-preview-time"><Clock3 size={11} aria-hidden="true" /> {draft.processingTime.trim()}</small>}
    {draft.fields.map(f => <div key={f.key} className="wm-preview-field"><span>{f.label.trim() || 'Untitled field'}{f.required ? ' *' : ' (optional)'}</span>
      {f.type === 'textarea' ? <textarea className="admin-input" rows={2} disabled placeholder={f.placeholder} />
        : f.type === 'select' ? <select className="admin-input" disabled><option>{f.options.split('\n').map(o => o.trim()).filter(Boolean)[0] ?? 'Choose…'}</option></select>
          : <input className="admin-input" disabled type={f.type === 'email' ? 'email' : f.type === 'number' ? 'number' : 'text'} placeholder={f.placeholder} />}
      {f.help.trim() && <small>{f.help.trim()}</small>}</div>)}
  </div>;
}
