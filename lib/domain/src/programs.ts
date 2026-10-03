import type { DemoState, Grant, GrantInput, ProgramQuestion, ProgramStatus, Result, Tier } from './model';
import { fail, nextIds, roundCents } from './rules';
import { notify } from './notifications';
import { programBudget } from './review';

// Grant program management. Pure, like the other rule modules. There is no
// staff authorization yet: whoever opens /admin acts as the demo program manager.

export const MAX_REQUIREMENTS = 8;
export const MAX_REQUIREMENT_LENGTH = 80;
export const MAX_QUESTIONS = 15;
export const QUESTION_TYPES: { id: ProgramQuestion['type']; label: string }[] = [
  { id: 'text', label: 'Short text' }, { id: 'textarea', label: 'Long text' }, { id: 'number', label: 'Number' }, { id: 'yesno', label: 'Yes / no' }, { id: 'file', label: 'Document upload' },
];
export const MAX_APPROVAL_DAYS = 365;
export const MAX_COMMISSION_RATE = 100;
export { commissionFor } from './core';

/** Eligibility criteria that can't change once someone has submitted, so in-flight applications stay valid. */
export const LOCKED_WHEN_SUBMITTED: (keyof GrantInput)[] = ['minimumTier', 'requirements', 'requiresRegistration', 'minimumRequest', 'questions'];

const FIELD_LABELS: Record<keyof GrantInput, string> = {
  name: 'name', summary: 'summary', focus: 'focus', maxFunding: 'maximum award', minimumRequest: 'minimum request',
  budget: 'budget', deadline: 'deadline', minimumTier: 'minimum tier', requirements: 'requirements', requiresRegistration: 'registration requirement', questions: 'application form',
  approvalDays: 'approval days', commissionRate: 'commission',
};

const todayIso = (now: Date) => {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};
const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime()) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const isMoney = (value: number) => Number.isFinite(value) && value > 0 && roundCents(value) === value;

/** True once any application for the program has left draft. */
export const hasSubmissions = (state: DemoState, grantId: string) => state.applications.some(a => a.grantId === grantId && a.status !== 'Draft');

/** Blank questions are dropped; new ones get a stable id derived from their label. */
function normalizeQuestions(questions: ProgramQuestion[]): ProgramQuestion[] {
  const kept = questions.map(q => ({ ...q, label: q.label.trim() })).filter(q => q.label);
  const used = new Set(kept.map(q => q.id).filter(Boolean));
  return kept.map(q => {
    if (q.id) return q;
    const base = q.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'question';
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return { ...q, id };
  });
}

export function normalizeProgram(input: GrantInput): GrantInput {
  return {
    ...input,
    name: input.name.trim(),
    summary: input.summary.trim(),
    focus: input.focus.trim(),
    requirements: input.requirements.map(r => r.trim()).filter(Boolean),
    questions: normalizeQuestions(input.questions ?? []),
  };
}

/** Field-level problems with a program definition. `existing` is the saved program when editing. */
export function validateProgram(state: DemoState, raw: GrantInput, now: Date, existing?: Grant): Record<string, string> {
  const input = normalizeProgram(raw);
  const errors: Record<string, string> = {};
  if (input.name.length < 3 || input.name.length > 60) errors.name = 'Use 3–60 characters.';
  else if (state.grants.some(g => g.id !== existing?.id && g.name.toLowerCase() === input.name.toLowerCase())) errors.name = 'Another program already uses this name.';
  if (input.summary.length < 10 || input.summary.length > 200) errors.summary = 'Use 10–200 characters.';
  if (input.focus.length < 2 || input.focus.length > 40) errors.focus = 'Use 2–40 characters.';

  if (!isMoney(input.minimumRequest)) errors.minimumRequest = 'Enter a positive amount (max two decimals).';
  if (!isMoney(input.maxFunding)) errors.maxFunding = 'Enter a positive amount (max two decimals).';
  else if (!errors.minimumRequest && input.maxFunding < input.minimumRequest) errors.maxFunding = 'Must be at least the minimum request.';
  if (!isMoney(input.budget)) errors.budget = 'Enter a positive amount (max two decimals).';
  else if (!errors.maxFunding && input.budget < input.maxFunding) errors.budget = 'Must cover at least one maximum award.';
  else if (existing) {
    const { awarded } = programBudget(state, existing.id);
    if (input.budget < awarded) errors.budget = `$${awarded.toLocaleString('en-US')} is already awarded; the budget can't go below that.`;
  }

  if (!isIsoDate(input.deadline)) errors.deadline = 'Enter a valid date.';
  else if (existing?.status === 'Open' && input.deadline < todayIso(now)) errors.deadline = 'An open program needs a deadline today or later. Close it instead.';
  if (![1, 2, 3].includes(input.minimumTier)) errors.minimumTier = 'Choose tier 1, 2, or 3.';

  // Requirements are optional now that the application form can ask for documents.
  if (input.requirements.length > MAX_REQUIREMENTS) errors.requirements = `Use at most ${MAX_REQUIREMENTS} requirements.`;
  else if (input.requirements.some(r => r.length > MAX_REQUIREMENT_LENGTH)) errors.requirements = `Keep each requirement under ${MAX_REQUIREMENT_LENGTH} characters.`;
  else if (new Set(input.requirements.map(r => r.toLowerCase())).size !== input.requirements.length) errors.requirements = 'Each requirement must be different.';

  if (input.questions.length > MAX_QUESTIONS) errors.questions = `Use at most ${MAX_QUESTIONS} form fields.`;
  else if (input.questions.some(q => q.label.length < 3 || q.label.length > 120)) errors.questions = 'Keep each field label between 3 and 120 characters.';
  else if (input.questions.some(q => !QUESTION_TYPES.some(t => t.id === q.type))) errors.questions = 'Choose a type for each field.';
  else if (input.questions.some(q => typeof q.required !== 'boolean')) errors.questions = 'Say whether each field is required.';
  else if (new Set(input.questions.map(q => q.label.toLowerCase())).size !== input.questions.length) errors.questions = 'Each field must have a different label.';

  if (!Number.isInteger(input.approvalDays) || input.approvalDays < 1 || input.approvalDays > MAX_APPROVAL_DAYS) errors.approvalDays = `Enter whole days, 1–${MAX_APPROVAL_DAYS}.`;
  if (!Number.isFinite(input.commissionRate) || input.commissionRate < 0 || input.commissionRate > MAX_COMMISSION_RATE || roundCents(input.commissionRate) !== input.commissionRate) errors.commissionRate = `Enter a percentage from 0 to ${MAX_COMMISSION_RATE} (max two decimals).`;

  if (existing && hasSubmissions(state, existing.id)) {
    for (const key of LOCKED_WHEN_SUBMITTED) {
      if (JSON.stringify(input[key]) !== JSON.stringify(existing[key])) errors[key] = 'Locked: applications have already been submitted against this criterion.';
    }
    if (!errors.maxFunding && input.maxFunding < existing.maxFunding) errors.maxFunding = "Can't be lowered after applications have been submitted.";
  }
  return errors;
}

type Loaded = { ok: true; grant: Grant } | { ok: false; result: Result };

function load(state: DemoState, id: string, expectedVersion: string): Loaded {
  const grant = state.grants.find(g => g.id === id);
  if (!grant) return { ok: false, result: fail('That program could not be found.') };
  if (grant.updatedAt !== expectedVersion) return { ok: false, result: fail('This program changed since you opened it. Review the latest version and try again.') };
  return { ok: true, grant };
}

function save(state: DemoState, grant: Grant, by: string, summary: string, now: Date, changes: Partial<Grant> = {}): DemoState {
  const at = now.toISOString();
  const updated: Grant = { ...grant, ...changes, updatedAt: at, changeLog: [...grant.changeLog, { at, by, summary }] };
  return { ...state, grants: state.grants.map(g => g.id === grant.id ? updated : g) };
}

export function createProgram(state: DemoState, raw: GrantInput, by: string, now: Date): Result {
  const errors = validateProgram(state, raw, now);
  if (Object.keys(errors).length) return fail('Fix the highlighted fields.', errors);
  const ids = nextIds(state);
  const at = now.toISOString();
  const grant: Grant = { ...normalizeProgram(raw), id: ids.program, status: 'Draft', updatedAt: at, changeLog: [{ at, by, summary: 'Created as draft.' }] };
  return { ok: true, id: grant.id, message: `${grant.name} created as a draft. Publish it when it's ready for applicants.`, state: { ...state, nextId: ids.nextId, grants: [...state.grants, grant] } };
}

export function updateProgram(state: DemoState, id: string, expectedVersion: string, raw: GrantInput, by: string, now: Date): Result {
  const loaded = load(state, id, expectedVersion);
  if (!loaded.ok) return loaded.result;
  const errors = validateProgram(state, raw, now, loaded.grant);
  if (Object.keys(errors).length) return fail('Fix the highlighted fields.', errors);
  const input = normalizeProgram(raw);
  const changed = (Object.keys(FIELD_LABELS) as (keyof GrantInput)[]).filter(k => JSON.stringify(input[k]) !== JSON.stringify(loaded.grant[k]));
  if (!changed.length) return fail('Nothing has changed.');
  const summary = `Edited ${changed.map(k => FIELD_LABELS[k]).join(', ')}.`;
  return { ok: true, id, message: `${input.name} saved.`, state: save(state, loaded.grant, by, summary, now, input) };
}

const STATUS_MOVES: Record<ProgramStatus, ProgramStatus[]> = { Draft: ['Open'], Open: ['Closed'], Closed: ['Open'] };

/** Draft → Open (publish) or Closed → Open (reopen). The saved definition must be valid with a future deadline. */
export function publishProgram(state: DemoState, id: string, expectedVersion: string, by: string, now: Date): Result {
  const loaded = load(state, id, expectedVersion);
  if (!loaded.ok) return loaded.result;
  const { grant } = loaded;
  if (!STATUS_MOVES[grant.status].includes('Open')) return fail(`${grant.name} is already open.`);
  const errors = validateProgram(state, grant, now, { ...grant, status: 'Open' });
  if (Object.keys(errors).length) return fail(`Fix the program before opening it: ${Object.values(errors)[0]}`, errors);
  const reopening = grant.status === 'Closed';
  return { ok: true, id, message: `${grant.name} is ${reopening ? 'reopened' : 'published'} and accepting applications.`, state: save(state, grant, by, reopening ? 'Reopened.' : 'Published.', now, { status: 'Open' }) };
}

/** Open → Closed. In-flight applications continue; applicants holding drafts are told they can't submit. */
export function closeProgram(state: DemoState, id: string, expectedVersion: string, by: string, now: Date): Result {
  const loaded = load(state, id, expectedVersion);
  if (!loaded.ok) return loaded.result;
  const { grant } = loaded;
  if (grant.status !== 'Open') return fail(`${grant.name} isn't open.`);
  let next = save(state, grant, by, 'Closed to new applications.', now, { status: 'Closed' });
  const drafts = state.applications.filter(a => a.grantId === id && a.status === 'Draft');
  for (const draft of drafts) {
    next = notify(next, draft.applicantId, `${grant.name} closed`, 'This program stopped accepting applications, so your draft can no longer be submitted.', `/applications/${draft.id}`, now);
  }
  const suffix = drafts.length ? ` ${drafts.length} applicant${drafts.length === 1 ? '' : 's'} with drafts notified.` : '';
  return { ok: true, id, message: `${grant.name} closed to new applications. Submitted applications continue through review.${suffix}`, state: next };
}

/** Only never-used drafts can be deleted; everything else is closed instead, to keep history. */
export function deleteProgram(state: DemoState, id: string, expectedVersion: string): Result {
  const loaded = load(state, id, expectedVersion);
  if (!loaded.ok) return loaded.result;
  if (loaded.grant.status !== 'Draft') return fail('Only draft programs can be deleted. Close a published program instead.');
  if (state.applications.some(a => a.grantId === id)) return fail('This program has applications and cannot be deleted.');
  return { ok: true, message: `${loaded.grant.name} deleted.`, state: { ...state, grants: state.grants.filter(g => g.id !== id) } };
}

export const emptyProgram = (now: Date): GrantInput => {
  const deadline = new Date(now.getTime() + 90 * 86_400_000);
  return { name: '', summary: '', focus: '', maxFunding: 10000, minimumRequest: 1000, budget: 100000, deadline: todayIso(deadline), minimumTier: 1 as Tier, requirements: [], requiresRegistration: false, questions: [], approvalDays: 7, commissionRate: 0 };
};
