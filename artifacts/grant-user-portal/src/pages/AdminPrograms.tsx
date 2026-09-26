import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Building2, FolderOpen, Info, Leaf, Lock, Palette, Plus, Store, Trash2, X } from 'lucide-react';
import { format } from 'date-fns';
import type { DemoState, GrantInput, ProgramQuestion, Result, Tier } from '@/domain/model';
import {
  closeProgram, createProgram, deleteProgram, emptyProgram, hasSubmissions, LOCKED_WHEN_SUBMITTED,
  MAX_QUESTIONS, MAX_REQUIREMENTS, publishProgram, QUESTION_TYPES, updateProgram,
} from '@/domain/programs';
import { programBudget } from '@/domain/review';
import { useDemoStore } from '@/domain/store';
import { ReviewFrame } from './AdminReviewPanel';
import { RoleNotice, useCan, useStaffCommand } from './AdminStaff';

const icons: Record<string, typeof Store> = { momentum: Store, green: Leaf, creative: Palette, community: Building2 };
const usd = (value: number) => `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const day = (iso: string) => format(new Date(iso.length === 10 ? `${iso}T00:00:00` : iso), 'dd MMM yyyy');
const when = (iso: string) => format(new Date(iso), 'dd MMM yyyy, HH:mm');
const STATUS_ORDER = { Open: 0, Draft: 1, Closed: 2 } as const;

export function AdminPrograms() {
  const { state } = useDemoStore();
  const [filter, setFilter] = useState('All programs');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const close = useCallback(() => setEditing(null), []);
  const all = [...state.grants].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));
  const visible = all.filter(g => filter === 'All programs' || g.status === filter);
  return <>
    <div className="admin-toolbar"><span className="admin-count" data-testid="text-admin-grants-count">{visible.length} of {all.length} programs</span><div className="admin-toolbar-left" style={{ flex: '0 1 auto' }}><select className="admin-filter" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter grant programs by status" data-testid="select-admin-filter-grants"><option>All programs</option><option>Open</option><option>Draft</option><option>Closed</option></select><button type="button" className="admin-btn primary" onClick={() => setEditing('new')} data-testid="button-admin-new-program"><Plus size={14} style={{ verticalAlign: '-2px' }} /> New program</button></div></div>
    <div className="admin-program-grid">{visible.map(grant => {
      const Icon = icons[grant.id] ?? FolderOpen;
      const budget = programBudget(state, grant.id);
      const count = state.applications.filter(a => a.grantId === grant.id && a.status !== 'Draft').length;
      return <article className="admin-program-card" key={grant.id} data-testid={`card-admin-grant-${grant.id}`}>
        <div className="admin-program-top"><span className="admin-program-icon"><Icon size={19} /></span><span className={`admin-badge ${grant.status.toLowerCase()}`} data-testid={`status-admin-program-${grant.id}`}>{grant.status}</span></div>
        <h2>{grant.name}</h2><p>{grant.summary}</p>
        <div className="admin-program-meta"><div><span>Award range</span><strong>{usd(grant.minimumRequest)} – {usd(grant.maxFunding)}</strong></div><div><span>Budget left</span><strong>{usd(budget.remaining)} of {usd(budget.budget)}</strong></div><div><span>Deadline</span><strong>{day(grant.deadline)}</strong></div><div><span>Submitted</span><strong>{count} application{count === 1 ? '' : 's'}</strong></div></div>
        <button type="button" onClick={() => setEditing(grant.id)} aria-label={`Manage ${grant.name}`} data-testid={`button-manage-admin-grant-${grant.id}`}>Manage program <ArrowRight size={14} /></button>
      </article>;
    })}</div>
    {editing && <ProgramPanel programId={editing === 'new' ? null : editing} onClose={close} onCreated={id => setEditing(id)} />}
  </>;
}

type Form = { name: string; summary: string; focus: string; minimumRequest: string; maxFunding: string; budget: string; deadline: string; minimumTier: string; requiresRegistration: boolean; requirements: string[]; questions: ProgramQuestion[] };

const toForm = (g: GrantInput): Form => ({ name: g.name, summary: g.summary, focus: g.focus, minimumRequest: String(g.minimumRequest), maxFunding: String(g.maxFunding), budget: String(g.budget), deadline: g.deadline, minimumTier: String(g.minimumTier), requiresRegistration: g.requiresRegistration, requirements: g.requirements.length ? [...g.requirements] : [''], questions: g.questions.map(q => ({ ...q })) });
const num = (value: string) => value.trim() === '' ? NaN : Number(value);
const toInput = (f: Form): GrantInput => ({ name: f.name, summary: f.summary, focus: f.focus, minimumRequest: num(f.minimumRequest), maxFunding: num(f.maxFunding), budget: num(f.budget), deadline: f.deadline, minimumTier: Number(f.minimumTier) as Tier, requiresRegistration: f.requiresRegistration, requirements: f.requirements, questions: f.questions });

function ProgramPanel({ programId, onClose, onCreated }: { programId: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const { state } = useDemoStore();
  const staffCommand = useStaffCommand();
  const allowed = useCan()('programs.manage');
  const run = (action: string, target: string, fn: (s: DemoState, by: string) => Result) => staffCommand('programs.manage', { action, target }, (s, actor) => fn(s, actor.name));
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
  const after = (result: Result, onOk?: (result: Result & { ok: true }) => void) => {
    setConfirm(null);
    if (!result.ok) { setErrors(result.fieldErrors ?? {}); setFlash({ tone: 'error', text: result.error }); return; }
    setErrors({}); setFlash({ tone: 'ok', text: result.message });
    const saved = result.state.grants.find(g => g.id === (result.id ?? programId));
    if (saved) { setSeenVersion(saved.updatedAt); setForm(toForm(saved)); }
    onOk?.(result);
  };
  const now = () => new Date();
  const saveForm = () => grant
    ? after(run('Edit program', grant.id, (s, by) => updateProgram(s, grant.id, seenVersion, toInput(form), by, now())))
    : after(run('Create program', '', (s, by) => createProgram(s, toInput(form), by, now())), r => r.id && onCreated(r.id));
  const setQuestion = (i: number, patch: Partial<ProgramQuestion>) => set('questions', form.questions.map((q, j) => j === i ? { ...q, ...patch } : q));

  const field = (key: keyof Form, label: string, input: React.ReactNode, hint?: string) => <label className="admin-review-field" key={key}>
    <span>{label}{locked.has(key) && <Lock size={11} style={{ marginLeft: 5, verticalAlign: '-1px' }} aria-label="Locked" />}</span>
    {input}
    {errors[key] ? <small className="admin-field-error">{errors[key]}</small> : hint ? <small>{hint}</small> : null}
  </label>;
  const text = (key: 'name' | 'focus' | 'minimumRequest' | 'maxFunding' | 'budget' | 'deadline', type = 'text') => <input className="admin-input" type={type} inputMode={type === 'number' ? 'decimal' : undefined} step={type === 'number' ? '0.01' : undefined} value={form[key]} disabled={locked.has(key)} onChange={e => set(key, e.target.value)} aria-invalid={!!errors[key]} data-testid={`input-admin-program-${key}`} />;

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
        {grant.status === 'Draft' && !apps.length && !drafts && <button type="button" className="admin-btn" disabled={stale || !allowed} onClick={() => confirm === 'delete' ? after(run('Delete program', grant.id, s => deleteProgram(s, grant.id, seenVersion)), onClose) : setConfirm('delete')} data-testid="button-admin-program-delete"><Trash2 size={13} style={{ verticalAlign: '-2px' }} /> {confirm === 'delete' ? 'Confirm delete' : 'Delete'}</button>}
        {grant.status === 'Open'
          ? <button type="button" className="admin-btn danger" disabled={stale || !allowed} onClick={() => confirm === 'close' ? after(run('Close program', grant.id, (s, by) => closeProgram(s, grant.id, seenVersion, by, now()))) : setConfirm('close')} data-testid="button-admin-program-close">{confirm === 'close' ? 'Confirm close' : 'Close to new applications'}</button>
          : <button type="button" className="admin-btn primary" disabled={stale || dirty || !allowed} onClick={() => after(run(grant.status === 'Draft' ? 'Publish program' : 'Reopen program', grant.id, (s, by) => publishProgram(s, grant.id, seenVersion, by, now())))} data-testid="button-admin-program-publish">{grant.status === 'Draft' ? 'Publish' : 'Reopen'}</button>}
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
        {field('minimumTier', 'Minimum account tier', <select className="admin-input" value={form.minimumTier} disabled={locked.has('minimumTier')} onChange={e => set('minimumTier', e.target.value)} data-testid="select-admin-program-tier"><option value="1">Tier 1</option><option value="2">Tier 2</option><option value="3">Tier 3</option></select>)}
        <label className="admin-review-field admin-check"><span>Registration number {locked.has('requiresRegistration') && <Lock size={11} aria-label="Locked" />}</span><span className="admin-check-row"><input type="checkbox" checked={form.requiresRegistration} disabled={locked.has('requiresRegistration')} onChange={e => set('requiresRegistration', e.target.checked)} data-testid="checkbox-admin-program-registration" /> Required</span>{errors.requiresRegistration && <small className="admin-field-error">{errors.requiresRegistration}</small>}</label>
      </div>
      <fieldset className="admin-review-field admin-requirements" disabled={locked.has('requirements')}>
        <legend>Requirements applicants must confirm {locked.has('requirements') && <Lock size={11} aria-label="Locked" />}</legend>
        {form.requirements.map((req, i) => <div className="admin-requirement" key={i}><input className="admin-input" value={req} onChange={e => set('requirements', form.requirements.map((r, j) => j === i ? e.target.value : r))} aria-label={`Requirement ${i + 1}`} data-testid={`input-admin-program-requirement-${i}`} /><button type="button" className="admin-icon-button" onClick={() => set('requirements', form.requirements.filter((_, j) => j !== i))} disabled={form.requirements.length === 1} aria-label={`Remove requirement ${i + 1}`} data-testid={`button-admin-program-remove-requirement-${i}`}><X size={14} /></button></div>)}
        {form.requirements.length < MAX_REQUIREMENTS && <button type="button" className="admin-btn" onClick={() => set('requirements', [...form.requirements, ''])} data-testid="button-admin-program-add-requirement"><Plus size={13} style={{ verticalAlign: '-2px' }} /> Add requirement</button>}
        {errors.requirements && <small className="admin-field-error">{errors.requirements}</small>}
      </fieldset>
      <fieldset className="admin-review-field admin-requirements" disabled={locked.has('questions')} data-testid="fieldset-admin-program-questions">
        <legend>Application questions {locked.has('questions') && <Lock size={11} aria-label="Locked" />}</legend>
        <small>Extra questions applicants answer on the requirements step. Up to {MAX_QUESTIONS}; blank ones are dropped.</small>
        {form.questions.map((q, i) => <div className="admin-question" key={q.id || `new-${i}`}>
          <input className="admin-input" value={q.label} placeholder="e.g. How many people will this help?" onChange={e => setQuestion(i, { label: e.target.value })} aria-label={`Question ${i + 1}`} data-testid={`input-admin-program-question-${i}`} />
          <select className="admin-input" value={q.type} onChange={e => setQuestion(i, { type: e.target.value as ProgramQuestion['type'] })} aria-label={`Answer type for question ${i + 1}`} data-testid={`select-admin-program-question-type-${i}`}>{QUESTION_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
          <label className="admin-check-row"><input type="checkbox" checked={q.required} onChange={e => setQuestion(i, { required: e.target.checked })} data-testid={`checkbox-admin-program-question-required-${i}`} /> Required</label>
          <button type="button" className="admin-icon-button" onClick={() => set('questions', form.questions.filter((_, j) => j !== i))} aria-label={`Remove question ${i + 1}`} data-testid={`button-admin-program-remove-question-${i}`}><X size={14} /></button>
        </div>)}
        {form.questions.length < MAX_QUESTIONS && <button type="button" className="admin-btn" onClick={() => set('questions', [...form.questions, { id: '', label: '', type: 'text', required: true }])} data-testid="button-admin-program-add-question"><Plus size={13} style={{ verticalAlign: '-2px' }} /> Add question</button>}
        {errors.questions && <small className="admin-field-error">{errors.questions}</small>}
      </fieldset>
      <div className="admin-review-buttons">
        {grant && dirty && <button type="button" className="admin-btn" onClick={() => { setForm(toForm(grant)); setErrors({}); setFlash(null); }} data-testid="button-admin-program-discard">Discard edits</button>}
        <button type="button" className="admin-btn primary" disabled={stale || (!!grant && !dirty) || !allowed} onClick={saveForm} data-testid="button-admin-program-save">{grant ? 'Save changes' : 'Create draft'}</button>
      </div>
    </section>

    {grant && <section className="admin-review-section"><h3>Change log</h3><ol className="admin-review-history">{[...grant.changeLog].reverse().map(c => <li key={`${c.at}-${c.summary}`}><strong>{c.summary}</strong><span>{when(c.at)} · {c.by}</span></li>)}</ol></section>}

    <div className="admin-detail-note"><Info size={17} /><span>Demo program management. Changes are saved in this browser only and apply to the applicant preview here. Changes are role-checked and audited, but there is no real staff sign-in yet.</span></div>
  </ReviewFrame>;
}
