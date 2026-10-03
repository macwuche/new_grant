import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Building2, FolderOpen, Info, Leaf, Lock, Palette, Plus, Store, Trash2, X } from 'lucide-react';
import { format } from 'date-fns';
import * as api from '@workspace/api-client-react';
import type { DemoState, Grant, GrantInput, ProgramQuestion, Result, Tier } from '@workspace/domain/model';
import {
  closeProgram, commissionFor, createProgram, deleteProgram, emptyProgram, hasSubmissions, LOCKED_WHEN_SUBMITTED,
  MAX_QUESTIONS, MAX_REQUIREMENTS, publishProgram, QUESTION_TYPES, updateProgram,
} from '@workspace/domain/programs';
import { programBudget } from '@workspace/domain/review';
import { adoptServerProgram, dropServerProgram } from '@workspace/domain/sync';
import { apiError, useServerData } from '@/lib/serverData';
import { useDemoStore } from '@/lib/store';
import { ReviewFrame } from './AdminReviewPanel';
import { RoleNotice, useCan, useStaffCommand } from './AdminStaff';

const icons: Record<string, typeof Store> = { momentum: Store, green: Leaf, creative: Palette, community: Building2 };
const usd = (value: number) => `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const day = (iso: string) => format(new Date(iso.length === 10 ? `${iso}T00:00:00` : iso), 'dd MMM yyyy');
const when = (iso: string) => format(new Date(iso), 'dd MMM yyyy, HH:mm');
const STATUS_ORDER = { Open: 0, Draft: 1, Closed: 2 } as const;

export function AdminPrograms() {
  const { state } = useDemoStore();
  const { programsError } = useServerData();
  const [filter, setFilter] = useState('All programs');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const close = useCallback(() => setEditing(null), []);
  const all = [...state.grants].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));
  const visible = all.filter(g => filter === 'All programs' || g.status === filter);
  return <>
    {programsError && <div className="admin-review-flash error" role="alert" data-testid="status-admin-programs-error">{programsError}</div>}
    <div className="admin-toolbar"><span className="admin-count" data-testid="text-admin-grants-count">{visible.length} of {all.length} programs</span><div className="admin-toolbar-left" style={{ flex: '0 1 auto' }}><select className="admin-filter" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter grant programs by status" data-testid="select-admin-filter-grants"><option>All programs</option><option>Open</option><option>Draft</option><option>Closed</option></select><button type="button" className="admin-btn primary" onClick={() => setEditing('new')} data-testid="button-admin-new-program"><Plus size={14} style={{ verticalAlign: '-2px' }} /> New program</button></div></div>
    <div className="admin-program-grid">{visible.map(grant => {
      const Icon = icons[grant.id] ?? FolderOpen;
      const budget = programBudget(state, grant.id);
      const count = state.applications.filter(a => a.grantId === grant.id && a.status !== 'Draft').length;
      return <article className="admin-program-card" key={grant.id} data-testid={`card-admin-grant-${grant.id}`}>
        <div className="admin-program-top"><span className="admin-program-icon"><Icon size={19} /></span><span className={`admin-badge ${grant.status.toLowerCase()}`} data-testid={`status-admin-program-${grant.id}`}>{grant.status}</span></div>
        <h2>{grant.name}</h2><p>{grant.summary}</p>
        <div className="admin-program-meta"><div><span>Award range</span><strong>{usd(grant.minimumRequest)} – {usd(grant.maxFunding)}</strong></div><div><span>Commission</span><strong>{grant.commissionRate}%</strong></div><div><span>Approval time</span><strong>{grant.approvalDays} day{grant.approvalDays === 1 ? '' : 's'}</strong></div><div><span>Budget left</span><strong>{usd(budget.remaining)} of {usd(budget.budget)}</strong></div><div><span>Deadline</span><strong>{day(grant.deadline)}</strong></div><div><span>Submitted</span><strong>{count} application{count === 1 ? '' : 's'}</strong></div></div>
        <button type="button" onClick={() => setEditing(grant.id)} aria-label={`Manage ${grant.name}`} data-testid={`button-manage-admin-grant-${grant.id}`}>Manage program <ArrowRight size={14} /></button>
      </article>;
    })}</div>
    {editing && <ProgramPanel programId={editing === 'new' ? null : editing} onClose={close} onCreated={id => setEditing(id)} />}
  </>;
}

/** What the commission comes to on the maximum award, as a hint under the field. */
function commissionHint(f: Form): string {
  const rate = num(f.commissionRate);
  const max = num(f.maxFunding);
  if (!Number.isFinite(rate) || !Number.isFinite(max)) return 'Taken from the deposit balance on approval; it may go negative.';
  return `${usd(commissionFor(max, rate))} on a ${usd(max)} award. Taken from the deposit balance on approval; it may go negative.`;
}

type Outcome = { ok: true; message: string; program?: Grant } | { ok: false; error: string; fieldErrors?: Record<string, string> };

type Form = { name: string; summary: string; focus: string; minimumRequest: string; maxFunding: string; budget: string; deadline: string; minimumTier: string; requiresRegistration: boolean; requirements: string[]; questions: ProgramQuestion[]; approvalDays: string; commissionRate: string };

const toForm = (g: GrantInput): Form => ({ name: g.name, summary: g.summary, focus: g.focus, minimumRequest: String(g.minimumRequest), maxFunding: String(g.maxFunding), budget: String(g.budget), deadline: g.deadline, minimumTier: String(g.minimumTier), requiresRegistration: g.requiresRegistration, requirements: [...g.requirements], questions: g.questions.map(q => ({ ...q })), approvalDays: String(g.approvalDays), commissionRate: String(g.commissionRate) });
const num = (value: string) => value.trim() === '' ? NaN : Number(value);
const toInput = (f: Form): GrantInput => ({ name: f.name, summary: f.summary, focus: f.focus, minimumRequest: num(f.minimumRequest), maxFunding: num(f.maxFunding), budget: num(f.budget), deadline: f.deadline, minimumTier: Number(f.minimumTier) as Tier, requiresRegistration: f.requiresRegistration, requirements: f.requirements, questions: f.questions, approvalDays: num(f.approvalDays), commissionRate: num(f.commissionRate) });

function ProgramPanel({ programId, onClose, onCreated }: { programId: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const { state } = useDemoStore();
  const staffCommand = useStaffCommand();
  const allowed = useCan()('programs.manage');
  const { run: runStore } = useDemoStore();
  const { connected, refreshPrograms } = useServerData();
  const [busy, setBusy] = useState(false);
  // Without sign-in: rules run on this browser's store, role-checked and audited there.
  const local = (action: string, target: string, fn: (s: DemoState, by: string) => Result): Outcome => {
    const result = staffCommand('programs.manage', { action, target }, (s, actor) => fn(s, actor.name));
    return result.ok ? { ok: true, message: result.message, program: result.state.grants.find(g => g.id === (result.id ?? target)) } : result;
  };
  // Signed in: the API runs the same rules and stores the program; the store takes the saved copy.
  const remote = async (call: () => Promise<api.ProgramResult | api.Message>, removedId?: string): Promise<Outcome> => {
    setBusy(true);
    try {
      const res = await call();
      if ('program' in res) runStore(s => adoptServerProgram(s, res.program as Grant));
      else if (removedId) runStore(s => dropServerProgram(s, removedId));
      return { ok: true, message: res.message, program: 'program' in res ? res.program as Grant : undefined };
    } catch (err) {
      const failure = apiError(err, "Couldn't reach the server. Your changes weren't saved; try again.");
      if (failure.status === 409 || failure.status === 404) void refreshPrograms();
      return { ok: false, error: failure.error, fieldErrors: failure.fieldErrors };
    } finally { setBusy(false); }
  };
  const grant = programId ? state.grants.find(g => g.id === programId) : undefined;
  const closeRef = useRef<HTMLButtonElement>(null);
  const [seenVersion, setSeenVersion] = useState(grant?.updatedAt ?? '');
  const [form, setForm] = useState<Form>(() => toForm(grant ?? emptyProgram(new Date())));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<'close' | 'delete' | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (programId && !grant) return <ReviewFrame closeRef={closeRef} onClose={onClose} eyebrow="Program"><h2 id="admin-detail-title">Program not found</h2><p className="admin-detail-lead">It may have been deleted.</p></ReviewFrame>;

  const locked = grant && hasSubmissions(state, grant.id) ? new Set<string>(LOCKED_WHEN_SUBMITTED) : new Set<string>();
  const stale = !!grant && grant.updatedAt !== seenVersion;
  const dirty = JSON.stringify(toInput(form)) !== JSON.stringify(toInput(toForm(grant ?? emptyProgram(new Date()))));
  const budget = grant ? programBudget(state, grant.id) : null;
  const apps = grant ? state.applications.filter(a => a.grantId === grant.id && a.status !== 'Draft') : [];
  const drafts = grant ? state.applications.filter(a => a.grantId === grant.id && a.status === 'Draft').length : 0;

  const set = <K extends keyof Form>(key: K, value: Form[K]) => { setForm(f => ({ ...f, [key]: value })); setErrors(({ [key]: _, ...rest }) => rest); setConfirm(null); };
  const after = async (pending: Outcome | Promise<Outcome>, onOk?: (outcome: Outcome & { ok: true }) => void) => {
    const outcome = await pending;
    setConfirm(null);
    if (!outcome.ok) { setErrors(outcome.fieldErrors ?? {}); setFlash({ tone: 'error', text: outcome.error }); return; }
    setErrors({}); setFlash({ tone: 'ok', text: outcome.message });
    if (outcome.program) { setSeenVersion(outcome.program.updatedAt); setForm(toForm(outcome.program)); }
    onOk?.(outcome);
  };
  const now = () => new Date();
  const version = { version: seenVersion };
  const saveForm = () => grant
    ? after(connected
      ? remote(() => api.updateProgram(grant.id, { version: seenVersion, program: toInput(form) as api.ProgramInput }))
      : local('Edit program', grant.id, (s, by) => updateProgram(s, grant.id, seenVersion, toInput(form), by, now())))
    : after(connected
      ? remote(() => api.createProgram(toInput(form) as api.ProgramInput))
      : local('Create program', '', (s, by) => createProgram(s, toInput(form), by, now())), o => o.program && onCreated(o.program.id));
  const doDelete = (id: string) => after(connected ? remote(() => api.deleteProgram(id, version), id) : local('Delete program', id, s => deleteProgram(s, id, seenVersion)), onClose);
  const doClose = (id: string) => after(connected ? remote(() => api.closeProgram(id, version)) : local('Close program', id, (s, by) => closeProgram(s, id, seenVersion, by, now())));
  const doPublish = (id: string, action: string) => after(connected ? remote(() => api.publishProgram(id, version)) : local(action, id, (s, by) => publishProgram(s, id, seenVersion, by, now())));
  const setQuestion = (i: number, patch: Partial<ProgramQuestion>) => set('questions', form.questions.map((q, j) => j === i ? { ...q, ...patch } : q));

  const field = (key: keyof Form, label: string, input: React.ReactNode, hint?: string) => <label className="admin-review-field" key={key}>
    <span>{label}{locked.has(key) && <Lock size={11} style={{ marginLeft: 5, verticalAlign: '-1px' }} aria-label="Locked" />}</span>
    {input}
    {errors[key] ? <small className="admin-field-error">{errors[key]}</small> : hint ? <small>{hint}</small> : null}
  </label>;
  const text = (key: 'name' | 'focus' | 'minimumRequest' | 'maxFunding' | 'budget' | 'deadline' | 'approvalDays' | 'commissionRate', type = 'text', step = '0.01') => <input className="admin-input" type={type} inputMode={type === 'number' ? 'decimal' : undefined} step={type === 'number' ? step : undefined} value={form[key]} disabled={locked.has(key)} onChange={e => set(key, e.target.value)} aria-invalid={!!errors[key]} data-testid={`input-admin-program-${key}`} />;

  return <ReviewFrame closeRef={closeRef} onClose={onClose} eyebrow={grant ? `${grant.id} / Program` : 'New program'}>
    <div className="admin-review-title"><h2 id="admin-detail-title" data-testid="text-admin-detail-title">{grant ? grant.name : 'New program'}</h2>{grant && <span className={`admin-badge ${grant.status.toLowerCase()}`} data-testid="status-admin-program">{grant.status}</span>}</div>
    <RoleNotice permission="programs.manage" />
    <p className="admin-detail-lead">{grant ? `${grant.focus} · last changed ${when(grant.updatedAt)}` : 'New programs start as drafts. Applicants see them only after you publish.'}</p>

    {stale && <div className="admin-review-stale" role="alert" data-testid="notice-admin-program-stale"><span>This program changed since you opened it.</span><button type="button" onClick={() => { setSeenVersion(grant!.updatedAt); setForm(toForm(grant!)); setErrors({}); setFlash(null); }} data-testid="button-admin-program-load-latest">Load latest</button></div>}
    {flash && <div className={`admin-review-flash ${flash.tone}`} role="status" data-testid="status-admin-program-flash">{flash.text}</div>}

    {grant && budget && <dl className="admin-detail-fields">
      <div className="admin-detail-field"><dt>Budget awarded</dt><dd>{usd(budget.awarded)} of {usd(budget.budget)}</dd></div>
      <div className="admin-detail-field"><dt>Submitted applications</dt><dd>{apps.length}{apps.length ? ` (${apps.filter(a => a.status === 'Submitted' || a.status === 'Under review').length} awaiting a decision)` : ''}</dd></div>
      <div className="admin-detail-field"><dt>Applicant drafts</dt><dd>{drafts}</dd></div>
    </dl>}

    {grant && <section className="admin-review-section admin-review-actions" aria-label="Program status">
      <h3>Status</h3>
      {grant.status === 'Draft' && <p className="admin-review-hint">Only staff can see a draft. Publishing makes it visible and open to eligible applicants.</p>}
      {grant.status === 'Open' && <p className="admin-review-hint">Accepting applications until {day(grant.deadline)}. Closing stops new submissions; submitted applications continue through review{drafts ? `, and ${drafts} applicant${drafts === 1 ? '' : 's'} with drafts will be notified` : ''}.</p>}
      {grant.status === 'Closed' && <p className="admin-review-hint">Not accepting new applications. Reopen it to accept them again (the deadline must be in the future).</p>}
      {dirty && grant.status !== 'Open' && <p className="admin-review-hint">Save or discard your edits before changing the status.</p>}
      <div className="admin-review-buttons">
        {confirm && <button type="button" className="admin-btn" onClick={() => setConfirm(null)} data-testid="button-admin-program-cancel">Cancel</button>}
        {grant.status === 'Draft' && !apps.length && !drafts && <button type="button" className="admin-btn" disabled={stale || !allowed || busy} onClick={() => confirm === 'delete' ? doDelete(grant.id) : setConfirm('delete')} data-testid="button-admin-program-delete"><Trash2 size={13} style={{ verticalAlign: '-2px' }} /> {confirm === 'delete' ? 'Confirm delete' : 'Delete'}</button>}
        {grant.status === 'Open'
          ? <button type="button" className="admin-btn danger" disabled={stale || !allowed || busy} onClick={() => confirm === 'close' ? doClose(grant.id) : setConfirm('close')} data-testid="button-admin-program-close">{confirm === 'close' ? 'Confirm close' : 'Close to new applications'}</button>
          : <button type="button" className="admin-btn primary" disabled={stale || dirty || !allowed || busy} onClick={() => doPublish(grant.id, grant.status === 'Draft' ? 'Publish program' : 'Reopen program')} data-testid="button-admin-program-publish">{grant.status === 'Draft' ? 'Publish' : 'Reopen'}</button>}
      </div>
    </section>}

    <section className="admin-review-section" aria-label="Program details">
      <h3>Details</h3>
      {locked.size > 0 && <p className="admin-review-hint"><Lock size={11} style={{ verticalAlign: '-1px' }} /> Eligibility criteria are locked because applications have been submitted. The maximum award can only go up.</p>}
      {field('name', 'Program name', text('name'))}
      {field('focus', 'Focus (staff label)', text('focus'), 'e.g. Small businesses')}
      {field('summary', 'Summary (shown to applicants)', <textarea className="admin-input" rows={3} value={form.summary} onChange={e => set('summary', e.target.value)} aria-invalid={!!errors.summary} data-testid="input-admin-program-summary" />)}
      <div className="admin-form-row">
        {field('minimumRequest', 'Minimum request (USD)', text('minimumRequest', 'number'))}
        {field('maxFunding', 'Maximum award (USD)', text('maxFunding', 'number'))}
      </div>
      <div className="admin-form-row">
        {field('budget', 'Total budget (USD)', text('budget', 'number'), budget ? `${usd(budget.awarded)} already awarded` : undefined)}
        {field('deadline', 'Application deadline', text('deadline', 'date'))}
      </div>
      <div className="admin-form-row">
        {field('approvalDays', 'Approval time (days)', text('approvalDays', 'number', '1'), `Shown to applicants: "usually decided within ${form.approvalDays.trim() || 'N'} days"`)}
        {field('commissionRate', 'Commission (% of the amount approved)', text('commissionRate', 'number'), commissionHint(form))}
      </div>
      <div className="admin-form-row">
        {field('minimumTier', 'Minimum account tier', <select className="admin-input" value={form.minimumTier} disabled={locked.has('minimumTier')} onChange={e => set('minimumTier', e.target.value)} data-testid="select-admin-program-tier"><option value="1">Tier 1</option><option value="2">Tier 2</option><option value="3">Tier 3</option></select>)}
        <label className="admin-review-field admin-check"><span>Registration number {locked.has('requiresRegistration') && <Lock size={11} aria-label="Locked" />}</span><span className="admin-check-row"><input type="checkbox" checked={form.requiresRegistration} disabled={locked.has('requiresRegistration')} onChange={e => set('requiresRegistration', e.target.checked)} data-testid="checkbox-admin-program-registration" /> Required</span>{errors.requiresRegistration && <small className="admin-field-error">{errors.requiresRegistration}</small>}</label>
      </div>
      <fieldset className="admin-review-field admin-requirements" disabled={locked.has('requirements')}>
        <legend>Required documents {locked.has('requirements') && <Lock size={11} aria-label="Locked" />}</legend>
        <small>Optional. Each one needs an uploaded file before the applicant can submit. You can also add document fields to the application form below.</small>
        {form.requirements.map((req, i) => <div className="admin-requirement" key={i}><input className="admin-input" value={req} onChange={e => set('requirements', form.requirements.map((r, j) => j === i ? e.target.value : r))} aria-label={`Requirement ${i + 1}`} data-testid={`input-admin-program-requirement-${i}`} /><button type="button" className="admin-icon-button" onClick={() => set('requirements', form.requirements.filter((_, j) => j !== i))} aria-label={`Remove requirement ${i + 1}`} data-testid={`button-admin-program-remove-requirement-${i}`}><X size={14} /></button></div>)}
        {form.requirements.length < MAX_REQUIREMENTS && <button type="button" className="admin-btn" onClick={() => set('requirements', [...form.requirements, ''])} data-testid="button-admin-program-add-requirement"><Plus size={13} style={{ verticalAlign: '-2px' }} /> Add requirement</button>}
        {errors.requirements && <small className="admin-field-error">{errors.requirements}</small>}
      </fieldset>
      <fieldset className="admin-review-field admin-requirements" disabled={locked.has('questions')} data-testid="fieldset-admin-program-questions">
        <legend>Application form {locked.has('questions') && <Lock size={11} aria-label="Locked" />}</legend>
        <small>The fields applicants fill in after the basics: text, numbers, yes/no, or a document upload (PDF, JPEG, or PNG, checked for hidden content). Up to {MAX_QUESTIONS}; blank ones are dropped.</small>
        {form.questions.map((q, i) => <div className="admin-question" key={q.id || `new-${i}`}>
          <input className="admin-input" value={q.label} placeholder={q.type === 'file' ? 'e.g. Latest bank statement' : 'e.g. How many people will this help?'} onChange={e => setQuestion(i, { label: e.target.value })} aria-label={`Field ${i + 1}`} data-testid={`input-admin-program-question-${i}`} />
          <select className="admin-input" value={q.type} onChange={e => setQuestion(i, { type: e.target.value as ProgramQuestion['type'] })} aria-label={`Type of field ${i + 1}`} data-testid={`select-admin-program-question-type-${i}`}>{QUESTION_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
          <label className="admin-check-row"><input type="checkbox" checked={q.required} onChange={e => setQuestion(i, { required: e.target.checked })} data-testid={`checkbox-admin-program-question-required-${i}`} /> Required</label>
          <button type="button" className="admin-icon-button" onClick={() => set('questions', form.questions.filter((_, j) => j !== i))} aria-label={`Remove field ${i + 1}`} data-testid={`button-admin-program-remove-question-${i}`}><X size={14} /></button>
        </div>)}
        {form.questions.length < MAX_QUESTIONS && <button type="button" className="admin-btn" onClick={() => set('questions', [...form.questions, { id: '', label: '', type: 'text', required: true }])} data-testid="button-admin-program-add-question"><Plus size={13} style={{ verticalAlign: '-2px' }} /> Add field</button>}
        {errors.questions && <small className="admin-field-error">{errors.questions}</small>}
      </fieldset>
      <div className="admin-review-buttons">
        {grant && dirty && <button type="button" className="admin-btn" onClick={() => { setForm(toForm(grant)); setErrors({}); setFlash(null); }} data-testid="button-admin-program-discard">Discard edits</button>}
        <button type="button" className="admin-btn primary" disabled={stale || (!!grant && !dirty) || !allowed || busy} onClick={saveForm} data-testid="button-admin-program-save">{grant ? 'Save changes' : 'Create draft'}</button>
      </div>
    </section>

    {grant && <section className="admin-review-section"><h3>Change log</h3><ol className="admin-review-history">{[...grant.changeLog].reverse().map(c => <li key={`${c.at}-${c.summary}`}><strong>{c.summary}</strong><span>{when(c.at)} · {c.by}</span></li>)}</ol></section>}

    <div className="admin-detail-note"><Info size={17} /><span>{connected
      ? 'Programs are saved on the server and shown to every applicant. Until applications move to the server, locked criteria and the awarded budget are checked in this browser only.'
      : 'Preview program management. Changes are saved in this browser only and apply to the applicant preview here. Changes are role-checked and audited, but there is no real staff sign-in yet.'}</span></div>
  </ReviewFrame>;
}
