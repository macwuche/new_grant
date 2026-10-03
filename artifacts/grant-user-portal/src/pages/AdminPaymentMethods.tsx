import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Clock3, Copy, Image as ImageIcon, Link2, Pencil, Plus, Trash2, TriangleAlert, Upload, X } from 'lucide-react';
import * as api from '@workspace/api-client-react';
import type { DemoState, DepositMethod, MethodFieldType, ProofRule, Result, Treasury, WithdrawalMethod, WithdrawalSource } from '@workspace/domain/model';
import {
  createDepositMethod, deleteDepositMethod, hasPlaceholderDetails, MAX_RECEIVING_DETAILS, PLACEHOLDER_MARK, PROOF_LABELS, setDepositMethodAvailability, updateDepositMethod,
  validateDepositMethod, type DepositMethodInput,
} from '@workspace/domain/depositMethods';
import { channelFee } from '@workspace/domain/money';
import {
  chargesLabel, createMethod, deleteMethod, FIELD_TYPES, MAX_FIELDS, MAX_METHOD_PHOTO_BYTES, MAX_PREVIEW_PHOTO_BYTES, setMethodAvailability, SOURCE_LABELS, updateMethod,
  validateMethod, type MethodInput,
} from '@workspace/domain/withdrawalMethods';
import { MethodBadge } from '@/components/MethodBadge';
import { useStaffMoney, type Outcome } from '@/lib/serverData';
import { useDemoStore } from '@/lib/store';
import { RoleNotice, useCan, useStaffCommand } from './AdminStaff';
import './AdminPaymentMethods.css';

// Settings → Withdrawal methods and Settings → Deposit methods: finance
// creates the ways applicants are paid out and add funds. Both kinds have a
// photo (a link, an upload, or the method's first letter), limits, charges, a
// processing time, instructions, and the form applicants fill in; withdrawal
// methods also say which balance they pay from, and deposit methods where to
// send the money (receiving details) and whether proof of payment is needed.
// Methods can be edited, hidden from users, or deleted. Signed in, changes go
// through the API (photos are stored on the API server); in preview mode
// they're kept in this browser.

type Kind = 'withdrawal' | 'deposit';
type AnyMethod = WithdrawalMethod | DepositMethod;
type Flash = { tone: 'ok' | 'error'; text: string } | null;
type PhotoMode = 'none' | 'link' | 'upload';
/** A form field as edited; `key` is only for React, `id` is kept for existing fields. */
type FieldDraft = { key: string; id?: string; label: string; type: MethodFieldType; required: boolean; placeholder: string; help: string; options: string };
type DetailDraft = { key: string; label: string; value: string };
type Draft = {
  name: string; enabled: boolean; min: string; max: string; feeRate: string; feeFixed: string; feeCap: string; processingTime: string; instructions: string;
  photoMode: PhotoMode; photoLink: string; formTitle: string; fields: FieldDraft[];
  /** Withdrawal methods only. */
  source: WithdrawalSource;
  /** Deposit methods only. */
  receivingDetails: DetailDraft[]; proof: ProofRule;
};
type Input = MethodInput | DepositMethodInput;
type LocalRule = (s: DemoState, by: string) => Result;

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: string) => v.trim() === '' ? NaN : Number(v);
let keySeq = 0;
const nextKey = () => `f${++keySeq}`;

/** Everything that differs between the two kinds: words, the rules, and the API calls. */
const KINDS = {
  withdrawal: {
    title: 'Withdrawal methods', noun: 'withdrawal method', page: 'withdrawal page', minLabel: 'Minimum withdrawal (USD)', maxLabel: 'Maximum withdrawal (USD)',
    panelTestId: 'panel-admin-withdrawal-methods', example: 'e.g. PayPal', nameHint: 'Shown to users, e.g. "PayPal" or "Crypto (USDT)".',
    intro: 'Users see available methods on their withdrawal page, fill in the method\'s form, and finance pays them outside the app.',
    noneWarning: 'No method is available, so users can\'t request payouts.', emptyText: 'Add one so users can request payouts.',
    methods: (t: Treasury): AnyMethod[] => t.channels,
    validate: (input: Input, t: Treasury, existing?: AnyMethod) => validateMethod(input as MethodInput, t.channels, existing as WithdrawalMethod | undefined),
    create: (v: string, input: Input): LocalRule => (s, by) => createMethod(s, v, input as MethodInput, by, new Date()),
    update: (v: string, id: string, input: Input): LocalRule => (s, by) => updateMethod(s, v, id, input as MethodInput, by, new Date()),
    availability: (id: string, enabled: boolean): LocalRule => (s, by) => setMethodAvailability(s, id, enabled, by, new Date()),
    remove: (id: string): LocalRule => (s, by) => deleteMethod(s, id, by, new Date()),
    api: {
      create: (version: string, input: Input) => api.createWithdrawalMethod({ version, method: input as api.WithdrawalMethodInput }),
      update: (id: string, version: string, input: Input) => api.updateWithdrawalMethod(id, { version, method: input as api.WithdrawalMethodInput }),
      availability: (id: string, enabled: boolean) => api.setWithdrawalMethodAvailability(id, { enabled }),
      remove: (id: string) => api.deleteWithdrawalMethod(id),
      photo: (id: string, file: File) => api.uploadWithdrawalMethodPhoto(id, file),
    },
  },
  deposit: {
    title: 'Deposit methods', noun: 'deposit method', page: 'Add funds page', minLabel: 'Minimum deposit (USD)', maxLabel: 'Maximum deposit (USD)',
    panelTestId: 'panel-admin-deposit-methods', example: 'e.g. USDT (TRC-20)', nameHint: 'Shown to users, e.g. "Bank transfer" or "USDT (TRC-20)".',
    intro: 'Users see available methods on the Add funds page with where to send the money, fill in the method\'s form, and finance confirms each deposit when it arrives.',
    noneWarning: 'No method is available, so users can\'t add funds.', emptyText: 'Add one so users can add funds.',
    methods: (t: Treasury): AnyMethod[] => t.depositMethods,
    validate: (input: Input, t: Treasury, existing?: AnyMethod) => validateDepositMethod(input as DepositMethodInput, t.depositMethods, existing as DepositMethod | undefined),
    create: (v: string, input: Input): LocalRule => (s, by) => createDepositMethod(s, v, input as DepositMethodInput, by, new Date()),
    update: (v: string, id: string, input: Input): LocalRule => (s, by) => updateDepositMethod(s, v, id, input as DepositMethodInput, by, new Date()),
    availability: (id: string, enabled: boolean): LocalRule => (s, by) => setDepositMethodAvailability(s, id, enabled, by, new Date()),
    remove: (id: string): LocalRule => (s, by) => deleteDepositMethod(s, id, by, new Date()),
    api: {
      create: (version: string, input: Input) => api.createDepositMethod({ version, method: input as api.DepositMethodInput }),
      update: (id: string, version: string, input: Input) => api.updateDepositMethod(id, { version, method: input as api.DepositMethodInput }),
      availability: (id: string, enabled: boolean) => api.setDepositMethodAvailability(id, { enabled }),
      remove: (id: string) => api.deleteDepositMethod(id),
      photo: (id: string, file: File) => api.uploadDepositMethodPhoto(id, file),
    },
  },
} as const;

const label = (kind: Kind, verb: string) => `${verb} ${KINDS[kind].noun}`;
const isDeposit = (m: AnyMethod): m is DepositMethod => 'receivingDetails' in m;

const emptyDraft = (kind: Kind): Draft => ({
  name: '', enabled: kind === 'withdrawal', min: kind === 'deposit' ? '20' : '10', max: kind === 'deposit' ? '25000' : '1000', feeRate: '0', feeFixed: '0', feeCap: '0', processingTime: '', instructions: '',
  photoMode: 'none', photoLink: '', formTitle: '', fields: [], source: 'grant',
  receivingDetails: kind === 'deposit' ? [{ key: nextKey(), label: '', value: '' }] : [], proof: 'optional',
});
const toDraft = (m: AnyMethod): Draft => ({
  name: m.name, enabled: m.enabled, min: String(m.min), max: String(m.max), feeRate: String(+(m.feeRate * 100).toFixed(4)), feeFixed: String(m.feeFixed), feeCap: String(m.feeCap),
  processingTime: m.processingTime, instructions: m.instructions,
  photoMode: !m.photoUrl ? 'none' : m.photoUrl.startsWith('https://') ? 'link' : 'upload', photoLink: m.photoUrl.startsWith('https://') ? m.photoUrl : '',
  formTitle: m.formTitle,
  fields: m.fields.map(f => ({ key: nextKey(), id: f.id, label: f.label, type: f.type, required: f.required, placeholder: f.placeholder, help: f.help, options: f.options.join('\n') })),
  source: isDeposit(m) ? 'grant' : m.source,
  receivingDetails: isDeposit(m) ? m.receivingDetails.map(d => ({ key: nextKey(), ...d })) : [],
  proof: isDeposit(m) ? m.proof : 'optional',
});
/** The draft as the rules and API take it; `photoUrl` for uploads is filled in by the caller. */
function toInput(kind: Kind, d: Draft, photoUrl: string): Input {
  const common = {
    name: d.name, enabled: d.enabled, min: num(d.min), max: num(d.max), feeRate: +(num(d.feeRate) / 100).toFixed(6), feeFixed: num(d.feeFixed), feeCap: num(d.feeCap),
    processingTime: d.processingTime, instructions: d.instructions, photoUrl, formTitle: d.formTitle,
    fields: d.fields.map(f => ({ ...(f.id ? { id: f.id } : {}), label: f.label, type: f.type, required: f.required, placeholder: f.placeholder, help: f.help, options: f.type === 'select' ? f.options.split('\n') : [] })),
  };
  return kind === 'deposit'
    ? { ...common, receivingDetails: d.receivingDetails.map(r => ({ label: r.label, value: r.value })), proof: d.proof }
    : { ...common, source: d.source };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
}

/** Staff actions in both modes: the API when signed in, the browser rule otherwise. */
function useMethodActions() {
  const command = useStaffCommand();
  const staffMoney = useStaffMoney();
  const local = (action: string, target: string, rule: LocalRule) => {
    const r = command('treasury.manage', { action, target }, (s, actor) => rule(s, actor.name));
    return r.ok ? { ok: true as const, message: r.message, id: r.id, treasury: r.state.treasury } : r;
  };
  return { connected: staffMoney.connected, local, remote: (call: () => Promise<api.MoneySettingsResult>) => staffMoney.settings(call) };
}

// ---------- The list ----------

export function AdminWithdrawalMethods() { return <MethodsAdmin kind="withdrawal" />; }
export function AdminDepositMethods() { return <MethodsAdmin kind="deposit" />; }

function MethodsAdmin({ kind }: { kind: Kind }) {
  const { state } = useDemoStore();
  const allowed = useCan()('treasury.manage');
  const actions = useMethodActions();
  const k = KINDS[kind];
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const methods = k.methods(state.treasury);
  const available = methods.filter(m => m.enabled).length;

  const report = (r: Outcome | (Result & { ok: false }) | { ok: true; message: string }) => setFlash(r.ok ? { tone: 'ok', text: r.message } : { tone: 'error', text: r.error });
  const toggle = async (m: AnyMethod) => {
    setBusy(m.id);
    report(actions.connected
      ? await actions.remote(() => k.api.availability(m.id, !m.enabled))
      : actions.local(`Make ${k.noun} ${m.enabled ? 'unavailable' : 'available'}`, m.id, k.availability(m.id, !m.enabled)));
    setBusy(null);
  };
  const remove = async (m: AnyMethod) => {
    setBusy(m.id);
    report(actions.connected ? await actions.remote(() => k.api.remove(m.id)) : actions.local(label(kind, 'Delete'), m.id, k.remove(m.id)));
    setBusy(null); setConfirmDelete(null);
  };

  if (editing) {
    return <MethodEditor kind={kind} methodId={editing.id} onClose={message => { setEditing(null); if (message) setFlash({ tone: 'ok', text: message }); }} />;
  }

  return <section className="admin-panel wm-panel" aria-labelledby="wm-title" data-testid={k.panelTestId}>
    <div className="admin-panel-head"><div><h2 id="wm-title">{k.title}</h2><p>{available} of {methods.length} available to users. {k.intro} {actions.connected ? 'Saved on the server.' : 'Saved in this browser only.'}</p></div>
      <button type="button" className="admin-btn primary" disabled={!allowed} onClick={() => { setFlash(null); setEditing({ id: null }); }} data-testid="button-admin-add-method"><Plus size={14} /> Add method</button></div>
    <RoleNotice permission="treasury.manage" />
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-methods-flash">{flash.text}</div>}
    {!available && methods.length > 0 && <p className="admin-field-error" role="alert" data-testid="notice-admin-no-methods">{k.noneWarning}</p>}
    {methods.length ? <ul className="wm-list" data-testid="list-admin-methods">{methods.map(m => <li key={m.id} className={`wm-card ${m.enabled ? '' : 'off'}`} data-testid={`card-admin-method-${m.id}`}>
      <div className="wm-card-top">
        <MethodBadge name={m.name} photoUrl={m.photoUrl} size={44} testId={`badge-admin-method-${m.id}`} />
        <div className="wm-card-title"><strong>{m.name}</strong><span className={`admin-badge ${m.enabled ? 'active' : 'draft'}`} data-testid={`status-admin-method-${m.id}`}>{m.enabled ? 'Available' : 'Unavailable'}</span></div>
        <button type="button" role="switch" aria-checked={m.enabled} aria-label={`${m.name} available to users`} className="wm-switch" disabled={!allowed || busy === m.id} onClick={() => void toggle(m)} data-testid={`switch-admin-method-${m.id}`}><span /></button>
      </div>
      {isDeposit(m) && hasPlaceholderDetails(m) && <p className="wm-warning" data-testid={`notice-admin-method-placeholder-${m.id}`}><TriangleAlert size={13} aria-hidden="true" /> Sample receiving details. Replace them before users send money.</p>}
      <dl className="wm-facts">
        <div><dt>Limits</dt><dd>{usd(m.min)} – {usd(m.max)}</dd></div>
        <div><dt>Charges</dt><dd>{chargesLabel(m)}</dd></div>
        <div><dt>Processing</dt><dd>{m.processingTime}</dd></div>
        {isDeposit(m)
          ? <div><dt>Proof of payment</dt><dd>{PROOF_LABELS[m.proof]}</dd></div>
          : <div><dt>Pays from</dt><dd>{SOURCE_LABELS[m.source]}</dd></div>}
        {isDeposit(m) && <div className="wide"><dt>Send to</dt><dd>{m.receivingDetails.map(d => `${d.label}: ${d.value}`).join(' · ')}</dd></div>}
        <div className="wide"><dt>Form</dt><dd>{m.fields.length ? `${m.formTitle} · ${m.fields.length} field${m.fields.length === 1 ? '' : 's'}` : 'No form'}</dd></div>
      </dl>
      {confirmDelete === m.id
        ? <div className="wm-confirm" role="group" aria-label={`Delete ${m.name}`}><span>Delete {m.name}? Pending {kind === 'deposit' ? 'deposits' : 'requests'} keep their details and can still be processed.</span>
          <div className="admin-review-buttons"><button type="button" className="admin-btn" onClick={() => setConfirmDelete(null)} data-testid={`button-admin-keep-method-${m.id}`}>Keep</button>
            <button type="button" className="admin-btn danger" disabled={busy === m.id} onClick={() => void remove(m)} data-testid={`button-admin-confirm-delete-method-${m.id}`}>Delete</button></div></div>
        : <div className="admin-review-buttons wm-card-actions">
          <button type="button" className="admin-btn" disabled={!allowed} onClick={() => setConfirmDelete(m.id)} data-testid={`button-admin-delete-method-${m.id}`}><Trash2 size={13} /> Delete</button>
          <button type="button" className="admin-btn primary" disabled={!allowed} onClick={() => { setFlash(null); setEditing({ id: m.id }); }} data-testid={`button-admin-edit-method-${m.id}`}><Pencil size={13} /> Edit</button>
        </div>}
    </li>)}</ul>
      : <div className="admin-empty" data-testid="empty-admin-methods"><ImageIcon size={25} /><h3>No {k.title.toLowerCase()}</h3><p>{k.emptyText}</p></div>}
  </section>;
}

// ---------- The editor ----------

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <small className="admin-field-error" id={id} role="alert">{message}</small> : null;
}

function MethodEditor({ kind, methodId, onClose }: { kind: Kind; methodId: string | null; onClose: (message?: string) => void }) {
  const { state } = useDemoStore();
  const allowed = useCan()('treasury.manage');
  const actions = useMethodActions();
  const k = KINDS[kind];
  const existing = methodId ? k.methods(state.treasury).find(m => m.id === methodId) ?? null : null;
  const [seenVersion] = useState(state.treasury.updatedAt);
  const [draft, setDraft] = useState<Draft>(() => existing ? toDraft(existing) : emptyDraft(kind));
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
    setErrors(e => Object.fromEntries(Object.entries(e).filter(([key]) => !key.startsWith(`fields.${i}.`) && key !== 'fields')));
  };
  /** Reordering or removing shifts the indexes that field errors are keyed by, so those errors are cleared. */
  const reshape = (fields: FieldDraft[]) => { setDraft(d => ({ ...d, fields })); setErrors(e => Object.fromEntries(Object.entries(e).filter(([key]) => !key.startsWith('fields')))); };
  const move = (i: number, by: -1 | 1) => { const f = [...draft.fields]; const [x] = f.splice(i, 1); f.splice(i + by, 0, x!); reshape(f); };
  const setDetail = (i: number, patch: Partial<DetailDraft>) => {
    setDraft(d => ({ ...d, receivingDetails: d.receivingDetails.map((r, j) => j === i ? { ...r, ...patch } : r) }));
    setErrors(e => Object.fromEntries(Object.entries(e).filter(([key]) => !key.startsWith(`receivingDetails.${i}.`) && key !== 'receivingDetails')));
  };
  const reshapeDetails = (receivingDetails: DetailDraft[]) => { setDraft(d => ({ ...d, receivingDetails })); setErrors(e => Object.fromEntries(Object.entries(e).filter(([key]) => !key.startsWith('receivingDetails')))); };

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
    const input = toInput(kind, draft, photoUrlFor());
    // Check here first so every field shows its message before anything is sent.
    const found = k.validate(input, state.treasury, existing ?? undefined);
    if (draft.photoMode === 'upload' && !upload && !currentUpload) found.photoUrl = 'Choose a photo to upload.';
    if (Object.keys(found).length) { setErrors(found); setFlash({ tone: 'error', text: 'Fix the highlighted fields.' }); return; }
    setSaving(true); setFlash(null);
    let result: Outcome & { treasury?: Treasury; id?: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };
    if (actions.connected) {
      result = await actions.remote(() => existing ? k.api.update(existing.id, seenVersion, input) : k.api.create(seenVersion, input));
      // Only a new photo chosen: the method itself is unchanged, so go straight to the upload.
      if (!result.ok && existing && upload && result.error === 'Nothing has changed.') result = { ok: true, message: `${existing.name} saved.` };
      const id = existing?.id ?? (result.ok ? result.id ?? (result.treasury ? k.methods(result.treasury).find(m => m.name === input.name.trim())?.id : undefined) : undefined);
      if (result.ok && upload && draft.photoMode === 'upload' && id) {
        const uploaded = await actions.remote(() => k.api.photo(id, upload.file));
        if (!uploaded.ok) result = { ok: false, error: `The method was saved, but the photo wasn't: ${uploaded.error}` };
      }
    } else {
      result = actions.local(label(kind, existing ? 'Edit' : 'Add'), existing?.id ?? 'treasury', existing ? k.update(seenVersion, existing.id, input) : k.create(seenVersion, input));
    }
    setSaving(false);
    if (!result.ok) { setErrors(result.fieldErrors ?? {}); setFlash({ tone: 'error', text: result.error }); return; }
    onClose(result.message);
  };

  const err = (key: string) => errors[key];
  const aria = (key: string) => ({ 'aria-invalid': !!errors[key], 'aria-describedby': errors[key] ? `${uid}-${key}` : undefined });
  const text = (key: 'name' | 'processingTime' | 'formTitle', title: string, hint: string, placeholder: string) => <label className="admin-review-field">
    <span>{title}</span><input className="admin-input" value={draft[key]} onChange={e => set(key, e.target.value)} placeholder={placeholder} {...aria(key)} data-testid={`input-method-${key}`} />
    {err(key) ? <FieldError id={`${uid}-${key}`} message={err(key)} /> : <small>{hint}</small>}
  </label>;
  const amount = (key: 'min' | 'max' | 'feeRate' | 'feeFixed' | 'feeCap', title: string, hint: string) => <label className="admin-review-field">
    <span>{title}</span><input className="admin-input" type="number" inputMode="decimal" step="0.01" min="0" value={draft[key]} onChange={e => set(key, e.target.value)} {...aria(key)} data-testid={`input-method-${key}`} />
    {err(key) ? <FieldError id={`${uid}-${key}`} message={err(key)} /> : <small>{hint}</small>}
  </label>;

  const example = 100;
  const charges = { feeFixed: num(draft.feeFixed) || 0, feeRate: (num(draft.feeRate) || 0) / 100, feeCap: num(draft.feeCap) || 0 };
  const exampleFee = channelFee(charges, example);
  const placeholderLeft = kind === 'deposit' && draft.receivingDetails.some(r => r.value.toLowerCase().includes(PLACEHOLDER_MARK));

  return <section className="admin-panel wm-panel" aria-labelledby="wm-editor-title" data-testid="panel-admin-method-editor">
    <button type="button" className="admin-settings-back wm-back" onClick={() => onClose()} data-testid="button-admin-method-back"><ArrowLeft size={14} /> All {k.title.toLowerCase()}</button>
    <div className="admin-panel-head"><div><h2 id="wm-editor-title" ref={headingRef} tabIndex={-1}>{existing ? `Edit ${existing.name}` : `New ${k.noun}`}</h2>
      <p>Changes apply to new {kind === 'deposit' ? 'deposits; pending deposits keep the receiving details, charges, and answers' : 'requests; pending requests keep the charges and details'} they were made with.</p></div></div>
    <RoleNotice permission="treasury.manage" />
    {stale && <div className="admin-review-stale" role="alert"><span>{k.title} changed since you opened this. Go back and open it again to see the latest version.</span></div>}
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-method-flash">{flash.text}</div>}

    <form className="wm-editor" noValidate onSubmit={e => { e.preventDefault(); void save(); }}>
      <fieldset className="wm-section" disabled={!allowed}><legend>Method</legend>
        <div className="wm-grid-2">
          {text('name', 'Method name', k.nameHint, k.example)}
          <div className="admin-review-field"><span>Available to users</span>
            <label className="admin-check-row"><input type="checkbox" checked={draft.enabled} onChange={e => set('enabled', e.target.checked)} data-testid="checkbox-method-enabled" /> Show it on the {k.page}</label>
            <small>Unavailable methods are kept but hidden from users.</small></div>
        </div>
        <div className="admin-review-field"><span>Photo (optional)</span>
          <div className="wm-photo">
            <MethodBadge name={draft.name || '?'} photoUrl={photoPreview} size={64} testId="badge-method-preview" />
            <div className="wm-photo-controls">
              <div className="admin-segment" role="radiogroup" aria-label="Photo">{([['none', 'First letter'], ['link', 'Photo link'], ['upload', 'Upload']] as const).map(([mode, title]) =>
                <button key={mode} type="button" role="radio" aria-checked={draft.photoMode === mode} className={draft.photoMode === mode ? 'active' : ''} onClick={() => set('photoMode', mode)} data-testid={`button-photo-mode-${mode}`}>{title}</button>)}</div>
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

      {kind === 'deposit' && <fieldset className="wm-section" disabled={!allowed}><legend>Where users send the money</legend>
        <p className="admin-review-hint">Each line is shown with a copy button, e.g. "Account number", "Bank name", or "Wallet address". Users also get a payment reference to include.</p>
        {placeholderLeft && <p className="wm-warning" role="note" data-testid="notice-method-placeholder"><TriangleAlert size={13} aria-hidden="true" /> Some values still say {PLACEHOLDER_MARK}. Replace them with the real details before making this method available.</p>}
        <ol className="wm-fields" data-testid="list-method-receiving">{draft.receivingDetails.map((r, i) => {
          const key = (name: string) => `receivingDetails.${i}.${name}`;
          return <li key={r.key} className="wm-field wm-detail" data-testid={`row-method-receiving-${i}`}>
            <div className="wm-grid-2">
              <label className="admin-review-field"><span>Label</span><input className="admin-input" value={r.label} onChange={e => setDetail(i, { label: e.target.value })} placeholder="e.g. Wallet address" {...aria(key('label'))} data-testid={`input-receiving-label-${i}`} /><FieldError id={`${uid}-${key('label')}`} message={err(key('label'))} /></label>
              <label className="admin-review-field"><span>Value users copy</span><input className="admin-input" value={r.value} onChange={e => setDetail(i, { value: e.target.value })} placeholder="e.g. TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE" {...aria(key('value'))} data-testid={`input-receiving-value-${i}`} /><FieldError id={`${uid}-${key('value')}`} message={err(key('value'))} /></label>
            </div>
            <div className="wm-field-tools wm-detail-tools">
              <button type="button" className="admin-icon-button" disabled={i === 0} onClick={() => { const list = [...draft.receivingDetails]; const [x] = list.splice(i, 1); list.splice(i - 1, 0, x!); reshapeDetails(list); }} aria-label={`Move line ${i + 1} up`} data-testid={`button-receiving-up-${i}`}><ArrowUp size={13} /></button>
              <button type="button" className="admin-icon-button" onClick={() => reshapeDetails(draft.receivingDetails.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`} data-testid={`button-receiving-remove-${i}`}><X size={13} /></button>
            </div>
          </li>;
        })}</ol>
        <FieldError id={`${uid}-receivingDetails`} message={err('receivingDetails')} />
        <button type="button" className="admin-btn" disabled={draft.receivingDetails.length >= MAX_RECEIVING_DETAILS} onClick={() => reshapeDetails([...draft.receivingDetails, { key: nextKey(), label: '', value: '' }])} data-testid="button-add-receiving"><Plus size={13} /> Add line</button>
        {draft.receivingDetails.some(r => r.label.trim() || r.value.trim()) && <div className="wm-preview" aria-label="Receiving details preview" data-testid="panel-method-receiving-preview">
          <span className="wm-preview-tag">Preview</span>
          <strong>Send to</strong>
          {draft.receivingDetails.filter(r => r.label.trim() || r.value.trim()).map(r => <div key={r.key} className="wm-preview-line"><span>{r.label.trim() || 'Label'}</span><b>{r.value.trim() || '—'}</b><Copy size={12} aria-hidden="true" /></div>)}
        </div>}
      </fieldset>}

      <fieldset className="wm-section" disabled={!allowed}><legend>Limits and charges</legend>
        <div className="wm-grid-2">{amount('min', k.minLabel, kind === 'deposit' ? 'Per deposit.' : 'Per request.')}{amount('max', k.maxLabel, kind === 'deposit' ? 'Per deposit.' : 'Per request.')}</div>
        <div className="wm-grid-3">{amount('feeRate', 'Charge (%)', 'Of the amount, 0–10%.')}{amount('feeFixed', 'Fixed charge (USD)', 'Added to the percentage.')}{amount('feeCap', 'Maximum charge (USD)', '0 for no maximum.')}</div>
        <p className="admin-review-hint" data-testid="text-method-fee-example">On a {usd(example)} {kind === 'deposit' ? 'deposit' : 'request'}: {chargesLabel(charges)} → charge {usd(exampleFee)}, {kind === 'deposit' ? `the user's deposit balance is credited ${usd(example - exampleFee)}` : `the user receives ${usd(example - exampleFee)}`}.</p>
      </fieldset>

      <fieldset className="wm-section" disabled={!allowed}><legend>Processing and instructions</legend>
        {text('processingTime', 'Processing time', 'Shown to users before they choose the method.', kind === 'deposit' ? 'e.g. Usually within an hour' : 'e.g. 1–2 business days')}
        <label className="admin-review-field"><span>{kind === 'deposit' ? 'Deposit' : 'Withdrawal'} instructions (optional)</span>
          <textarea className="admin-input" rows={3} value={draft.instructions} onChange={e => set('instructions', e.target.value)} placeholder={kind === 'deposit' ? 'e.g. Send only USDT on the TRON (TRC-20) network.' : 'e.g. Only USDT on the TRON (TRC-20) network.'} {...aria('instructions')} data-testid="textarea-method-instructions" />
          {err('instructions') ? <FieldError id={`${uid}-instructions`} message={err('instructions')} /> : <small>{kind === 'deposit' ? 'Shown to users with the receiving details.' : 'Shown to users with the method\'s form.'}</small>}</label>
      </fieldset>

      {kind === 'deposit'
        ? <fieldset className="wm-section" disabled={!allowed}><legend>Proof of payment</legend>
          <div className="wm-sources" role="radiogroup" aria-label="Proof of payment">{(['required', 'optional', 'off'] as const).map(rule => <label key={rule} className={`wm-source ${draft.proof === rule ? 'active' : ''}`}>
            <input type="radio" name={`${uid}-proof`} checked={draft.proof === rule} onChange={() => set('proof', rule)} data-testid={`radio-method-proof-${rule}`} />
            <span><strong>{PROOF_LABELS[rule]}</strong><small>{rule === 'required' ? 'Finance can\'t confirm until the user uploads a receipt or screenshot.' : rule === 'optional' ? 'Users can upload a receipt or screenshot.' : 'Users aren\'t asked for one.'}</small></span>
          </label>)}</div>
          <FieldError id={`${uid}-proof`} message={err('proof')} />
          <p className="admin-review-hint">PDF, JPG, or PNG, up to 5 files per deposit. Only the user and staff who process payments can open them.</p>
        </fieldset>
        : <fieldset className="wm-section" disabled={!allowed}><legend>Balance users withdraw from</legend>
          <div className="wm-sources" role="radiogroup" aria-label="Balance">{(['grant', 'deposit', 'both'] as const).map(source => <label key={source} className={`wm-source ${draft.source === source ? 'active' : ''}`}>
            <input type="radio" name={`${uid}-source`} checked={draft.source === source} onChange={() => set('source', source)} data-testid={`radio-method-source-${source}`} />
            <span><strong>{source === 'both' ? 'Both' : SOURCE_LABELS[source]}</strong><small>{source === 'grant' ? 'Awarded funds.' : source === 'deposit' ? 'Funds the user added; the reserve stays.' : 'The user chooses which balance.'}</small></span>
          </label>)}</div>
          <FieldError id={`${uid}-source`} message={err('source')} />
          <p className="admin-review-hint">"Eligible amount" is what a user could apply for, not money, so it can't be withdrawn.</p>
        </fieldset>}

      <fieldset className="wm-section" disabled={!allowed}><legend>The form users fill in{kind === 'deposit' ? ' (optional)' : ''}</legend>
        <p className="admin-review-hint">{kind === 'deposit'
          ? 'Ask for what helps finance find the transfer, e.g. the sender\'s name, the number it came from, or a transaction hash.'
          : 'Ask for what finance needs to send the money, e.g. an email address or a wallet address. Users\' last answers are remembered for their next request.'}</p>
        {text('formTitle', 'Form name', `e.g. "${kind === 'deposit' ? 'Transfer details' : 'Wallet details'}". Needed when the form has fields.`, kind === 'deposit' ? 'e.g. Transfer details' : 'e.g. Wallet details')}
        <ol className="wm-fields" data-testid="list-method-fields">{draft.fields.map((f, i) => {
          const key = (name: string) => `fields.${i}.${name}`;
          return <li key={f.key} className="wm-field" data-testid={`row-method-field-${i}`}>
            <div className="wm-field-head"><strong>Field {i + 1}</strong>
              <div className="wm-field-tools">
                <button type="button" className="admin-icon-button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move field ${i + 1} up`} data-testid={`button-field-up-${i}`}><ArrowUp size={13} /></button>
                <button type="button" className="admin-icon-button" disabled={i === draft.fields.length - 1} onClick={() => move(i, 1)} aria-label={`Move field ${i + 1} down`} data-testid={`button-field-down-${i}`}><ArrowDown size={13} /></button>
                <button type="button" className="admin-icon-button" onClick={() => reshape(draft.fields.filter((_, j) => j !== i))} aria-label={`Remove field ${i + 1}`} data-testid={`button-field-remove-${i}`}><X size={13} /></button>
              </div></div>
            <div className="wm-grid-2">
              <label className="admin-review-field"><span>Label</span><input className="admin-input" value={f.label} onChange={e => setField(i, { label: e.target.value })} placeholder={kind === 'deposit' ? 'e.g. Transaction hash' : 'e.g. Email address'} {...aria(key('label'))} data-testid={`input-field-label-${i}`} /><FieldError id={`${uid}-${key('label')}`} message={err(key('label'))} /></label>
              <label className="admin-review-field"><span>Type</span><select className="admin-input" value={f.type} onChange={e => setField(i, { type: e.target.value as MethodFieldType })} data-testid={`select-field-type-${i}`}>{FIELD_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
            </div>
            {f.type === 'select' && <label className="admin-review-field"><span>Choices (one per line)</span><textarea className="admin-input" rows={3} value={f.options} onChange={e => setField(i, { options: e.target.value })} placeholder={'e.g.\nMTN\nAirtel'} {...aria(key('options'))} data-testid={`textarea-field-options-${i}`} /><FieldError id={`${uid}-${key('options')}`} message={err(key('options'))} /></label>}
            <div className="wm-grid-2">
              <label className="admin-review-field"><span>Placeholder (optional)</span><input className="admin-input" value={f.placeholder} onChange={e => setField(i, { placeholder: e.target.value })} {...aria(key('placeholder'))} data-testid={`input-field-placeholder-${i}`} /><FieldError id={`${uid}-${key('placeholder')}`} message={err(key('placeholder'))} /></label>
              <label className="admin-review-field"><span>Help text (optional)</span><input className="admin-input" value={f.help} onChange={e => setField(i, { help: e.target.value })} {...aria(key('help'))} data-testid={`input-field-help-${i}`} /><FieldError id={`${uid}-${key('help')}`} message={err(key('help'))} /></label>
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
