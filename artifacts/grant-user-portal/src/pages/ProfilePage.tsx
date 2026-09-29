import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { format } from 'date-fns';
import {
  Camera, Check, KeyRound, LoaderCircle, Lock, LockKeyhole, LogOut, Mail, MonitorSmartphone, Pencil, ShieldCheck, Smartphone, Trash2, Upload, X,
} from 'lucide-react';
import {
  checkPassword, completeCredentialReset as completeServerReset, getAvatar, getProfile, listSecurityEvents, removeAvatar, reportPasswordChanged, reportSecurityEvent,
  setPrivacy as saveServerPrivacy, updateProfile as saveServerProfile, uploadAvatar,
  type Profile as ApiProfile, type SecurityEvent, type SecurityEventReportKind,
} from '@workspace/api-client-react';
import { accountOf } from '@workspace/domain/applicants';
import { completeCredentialReset } from '@workspace/domain/accounts';
import type { DemoState, Tier } from '@workspace/domain/model';
import {
  cleanPersonalDetails, MIN_PASSWORD_SCORE, passwordStrength, personalDetailsOf, privacyOf, profileHandle, setPrivacy, updatePersonalDetails, validatePersonalDetails,
  type PersonalDetails, type PrivacyPreferences,
} from '@workspace/domain/profile';
import { setTwoFactor } from '@workspace/domain/rules';
import { CURRENT_APPLICANT_ID } from '@workspace/domain/seed';
import { adoptServerProfile, type ServerAccount } from '@workspace/domain/sync';
import { TwoStepSetupForm } from '@/components/TwoStep';
import { apiError, useServerData } from '@/lib/serverData';
import { useSession } from '@/lib/session';
import { useDemoStore } from '@/lib/store';
import './ProfilePage.css';

// The applicant's Profile & Account Settings Center (/profile): photo, personal
// details, security and privacy switches, and recent security activity.
// Signed in, everything is saved through the API (the photo on the API
// server's disk, never Supabase Storage); in the browser-only preview the same
// screens work on the sample profile, and account changes that need a real
// sign-in (password, email, other devices) explain that instead.

type Toast = (message: string) => void;

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PHOTO_ACCEPT = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp';

/** Calling codes offered next to the phone number; anything else can be typed with its own "+" code. */
const DIAL_CODES: { code: string; label: string }[] = [
  { code: '+234', label: 'NG +234' }, { code: '+1', label: 'US/CA +1' }, { code: '+44', label: 'UK +44' }, { code: '+233', label: 'GH +233' },
  { code: '+254', label: 'KE +254' }, { code: '+27', label: 'ZA +27' }, { code: '+353', label: 'IE +353' }, { code: '+49', label: 'DE +49' },
  { code: '+33', label: 'FR +33' }, { code: '+34', label: 'ES +34' }, { code: '+39', label: 'IT +39' }, { code: '+31', label: 'NL +31' },
  { code: '+971', label: 'AE +971' }, { code: '+91', label: 'IN +91' }, { code: '+61', label: 'AU +61' }, { code: '+55', label: 'BR +55' },
];
const OTHER_CODE = 'other';

/** "+234 803 555 0100" → { dialCode: '+234', number: '803 555 0100' }; unknown codes keep the whole number under "Other". */
function splitPhone(phone: string): { dialCode: string; number: string } {
  const value = phone.trim();
  if (!value) return { dialCode: DIAL_CODES[0]!.code, number: '' };
  const compact = value.replace(/[\s()-]/g, '');
  const match = [...DIAL_CODES].sort((a, b) => b.code.length - a.code.length).find(d => compact.startsWith(d.code));
  if (match) {
    const rest = value.slice(value.indexOf(match.code) + match.code.length).trim();
    return { dialCode: match.code, number: rest };
  }
  return { dialCode: OTHER_CODE, number: value };
}
const joinPhone = (dialCode: string, number: string) => {
  const n = number.trim();
  if (!n) return '';
  return dialCode === OTHER_CODE ? n : `${dialCode} ${n.replace(/^\+?0+/, '')}`;
};

const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]!.toUpperCase()).join('') || '?';
const fmtDate = (iso: string) => format(new Date(iso.length === 10 ? `${iso}T00:00:00` : iso), 'MMM d, yyyy');
const fmtDateTime = (iso: string) => format(new Date(iso), 'MMM d, yyyy · HH:mm');
const adopt = (p: ApiProfile) => (s: DemoState) => adoptServerProfile(s, { ...p, tier: p.tier as Tier }, p.account as ServerAccount);

// ---------- Small building blocks ----------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A dialog that traps focus, closes on Escape or a backdrop click, and returns focus to what opened it. */
function Modal({ title, subtitle, onClose, children, testId }: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; testId: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    (panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); close.current(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const [head, tail] = [items[0]!, items[items.length - 1]!];
      if (event.shiftKey && document.activeElement === head) { event.preventDefault(); tail.focus(); }
      else if (!event.shiftKey && document.activeElement === tail) { event.preventDefault(); head.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey, true); document.body.style.overflow = overflow; opener?.focus?.(); };
  }, []);
  return <div className="pf-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={panel} className="pf-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}>
      <header className="pf-modal-head"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button type="button" className="pf-icon-btn" onClick={onClose} aria-label="Close" data-testid="button-profile-modal-close"><X size={16} /></button></header>
      <div className="pf-modal-body">{children}</div>
    </div>
  </div>;
}

function Toggle({ on, label, disabled, onChange, testId }: { on: boolean; label: string; disabled?: boolean; onChange: () => void; testId: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`pf-switch ${on ? 'on' : ''}`} disabled={disabled} onClick={onChange} data-testid={testId}><span /></button>;
}

function Pill({ tone, children, testId }: { tone: 'ok' | 'warn' | 'bad' | 'muted' | 'lime'; children: ReactNode; testId?: string }) {
  return <span className={`pf-pill ${tone}`} data-testid={testId}>{children}</span>;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <span className="pf-error" id={id} role="alert">{message}</span> : null;
}

// ---------- Module 1: photo and header ----------

function useAvatar(connected: boolean, version: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!connected || !version) { setUrl(null); return; }
    let live = true;
    let created: string | null = null;
    getAvatar().then(blob => { if (!live) return; created = URL.createObjectURL(blob); setUrl(created); }).catch(() => { if (live) setUrl(null); });
    return () => { live = false; if (created) URL.revokeObjectURL(created); };
  }, [connected, version]);
  return url;
}

function PhotoHeader({ onToast, avatarVersion, setAvatarVersion }: { onToast: Toast; avatarVersion: string | null; setAvatarVersion: (v: string | null) => void }) {
  const { state, run } = useDemoStore();
  const { connected } = useServerData();
  const { profile } = state;
  const input = useRef<HTMLInputElement>(null);
  const saved = useAvatar(connected, avatarVersion);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const shown = preview ?? saved;
  const replacePreview = (next: string | null) => setPreview(prev => { if (prev && prev !== next) URL.revokeObjectURL(prev); return next; });
  useEffect(() => () => { setPreview(prev => { if (prev) URL.revokeObjectURL(prev); return null; }); }, []);

  const choose = async (file: File | undefined) => {
    if (input.current) input.current.value = '';
    if (!file) return;
    const typeOk = PHOTO_TYPES.includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
    if (!typeOk) { onToast('Choose a JPG, PNG, or WEBP image.'); return; }
    if (file.size > MAX_PHOTO_BYTES) { onToast('That photo is over 5 MB. Choose a smaller one.'); return; }
    const local = URL.createObjectURL(file);
    replacePreview(local); // shown straight away, before the upload finishes
    setConfirmRemove(false);
    if (!connected) { onToast('Profile photo updated for this preview. Preview photos aren\'t saved.'); return; }
    setBusy(true);
    try {
      const saved = await uploadAvatar(file);
      run(adopt(saved));
      setAvatarVersion(saved.avatarUpdatedAt ?? null);
      onToast('Profile photo updated successfully');
    } catch (err) {
      replacePreview(null);
      onToast(apiError(err, "Couldn't upload your photo. Try again.").error);
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setConfirmRemove(false);
    if (!connected) { replacePreview(null); onToast('Profile photo removed.'); return; }
    setBusy(true);
    try {
      const saved = await removeAvatar();
      run(adopt(saved));
      replacePreview(null);
      setAvatarVersion(null);
      onToast('Profile photo removed.');
    } catch (err) { onToast(apiError(err, "Couldn't remove your photo. Try again.").error); }
    finally { setBusy(false); }
  };

  const verified = profile.identityVerified;
  return <section className="pf-card pf-header" aria-labelledby="pf-header-name" data-testid="section-profile-header">
    <div className="pf-banner" aria-hidden="true"><span className="pf-banner-glow" /></div>
    <div className="pf-header-body">
      <div className="pf-avatar-wrap">
        <button type="button" className="pf-avatar" onClick={() => input.current?.click()} disabled={busy} aria-label="Change photo" data-testid="button-avatar-change">
          {shown ? <img src={shown} alt="" data-testid="img-avatar" /> : <span className="pf-initials" data-testid="text-avatar-initials">{initialsOf(profile.name)}</span>}
          <span className="pf-avatar-overlay" aria-hidden="true"><Camera size={18} /><small>Change Photo</small></span>
          {busy && <span className="pf-avatar-busy" aria-hidden="true"><LoaderCircle size={22} className="pf-spin" /></span>}
        </button>
        <span className="pf-camera-badge" aria-hidden="true"><Camera size={13} /></span>
        <input ref={input} type="file" accept={PHOTO_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={e => void choose(e.target.files?.[0])} data-testid="input-avatar-file" />
      </div>
      <div className="pf-identity">
        <h2 id="pf-header-name" data-testid="text-profile-name">{profile.name}</h2>
        <p className="pf-handle" data-testid="text-profile-handle">{profileHandle(profile)}</p>
        <div className="pf-meta">
          <Pill tone={verified ? 'lime' : 'warn'} testId="status-profile-level">{verified ? <ShieldCheck size={12} /> : <LockKeyhole size={12} />}Tier {profile.tier} {verified ? 'Verified' : 'Unverified'}</Pill>
          <span className="pf-joined" data-testid="text-profile-joined">Member since {fmtDate(profile.joined)}</span>
        </div>
      </div>
      <div className="pf-photo-actions">
        <button type="button" className="pf-btn primary" onClick={() => input.current?.click()} disabled={busy} data-testid="button-avatar-upload"><Upload size={14} /> Upload New Photo</button>
        {shown && (confirmRemove
          ? <span className="pf-inline-confirm"><button type="button" className="pf-text-btn danger" onClick={() => void remove()} disabled={busy} data-testid="button-avatar-remove-confirm">Yes, remove</button><button type="button" className="pf-text-btn" onClick={() => setConfirmRemove(false)}>Keep</button></span>
          : <button type="button" className="pf-text-btn" onClick={() => setConfirmRemove(true)} disabled={busy} data-testid="button-avatar-remove">Remove Photo</button>)}
        <span className="pf-hint">JPG, PNG, or WEBP · up to 5 MB</span>
      </div>
    </div>
  </section>;
}

// ---------- Module 2: personal information ----------

type PersonalForm = { name: string; displayName: string; dialCode: string; phoneNumber: string; telegram: string; birthDate: string; address: string };
const toDetails = (v: PersonalForm): PersonalDetails => ({ name: v.name, displayName: v.displayName, phone: joinPhone(v.dialCode, v.phoneNumber), telegram: v.telegram, birthDate: v.birthDate, address: v.address });
/** The form's Zod schema runs the shared domain rule, so the browser and the API give the same errors. */
export const personalSchema = z.object({
  name: z.string(), displayName: z.string(), dialCode: z.string(), phoneNumber: z.string(), telegram: z.string(), birthDate: z.string(), address: z.string(),
}).superRefine((values, ctx) => {
  const errors = validatePersonalDetails(toDetails(values), new Date());
  for (const [key, message] of Object.entries(errors)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key === 'phone' ? 'phoneNumber' : key], message });
});

function InfoRow({ label, value, empty = 'Not added yet', action, testId, icon }: { label: string; value: string; empty?: string; action?: ReactNode; testId: string; icon?: ReactNode }) {
  return <div className="pf-row" data-testid={testId}>
    <span className="pf-row-label">{label}</span>
    <span className={`pf-row-value ${value ? '' : 'empty'}`}>{icon}{value || empty}</span>
    {action && <span className="pf-row-action">{action}</span>}
  </div>;
}

function PersonalInfo({ onToast, onRequestEmailChange }: { onToast: Toast; onRequestEmailChange: () => void }) {
  const { state, run } = useDemoStore();
  const { connected } = useServerData();
  const { profile } = state;
  const [editing, setEditing] = useState(false);
  const current = personalDetailsOf(profile);
  const phone = splitPhone(current.phone);
  const defaults: PersonalForm = { name: current.name, displayName: current.displayName, dialCode: phone.dialCode, phoneNumber: phone.number, telegram: current.telegram, birthDate: current.birthDate, address: current.address };
  const form = useForm<PersonalForm>({ resolver: zodResolver(personalSchema), mode: 'onChange', defaultValues: defaults });
  const { register, handleSubmit, formState: { errors, isSubmitting }, reset, setError } = form;
  const start = () => { reset(defaults); setEditing(true); };

  const save = handleSubmit(async values => {
    const details = cleanPersonalDetails(toDetails(values));
    if (!connected) {
      const result = run(s => updatePersonalDetails(s, details, new Date()));
      if (!result.ok) { onToast(result.error); return; }
      setEditing(false); onToast('Profile details saved.');
      return;
    }
    try {
      const saved = await saveServerProfile({ name: details.name, phone: details.phone, address: details.address, displayName: details.displayName, telegram: details.telegram, birthDate: details.birthDate });
      run(adopt(saved));
      setEditing(false); onToast('Profile details saved.');
    } catch (err) {
      const failure = apiError(err, "Couldn't save your details. Try again.");
      for (const [key, message] of Object.entries(failure.fieldErrors ?? {})) setError((key === 'phone' ? 'phoneNumber' : key) as keyof PersonalForm, { message });
      if (!failure.fieldErrors) onToast(failure.error);
    }
  });

  const field = (name: keyof PersonalForm, label: string, props: Record<string, unknown> = {}, hint?: string) => {
    const id = `pf-${name}`;
    const error = errors[name]?.message;
    return <div className="pf-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="pf-input" {...register(name)} {...props} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined} data-testid={`input-profile-${name}`} />
      {error ? <FieldError id={`${id}-error`} message={error} /> : hint ? <span className="pf-hint" id={`${id}-hint`}>{hint}</span> : null}
    </div>;
  };
  const emailAction = <button type="button" className="pf-btn ghost small" onClick={onRequestEmailChange} data-testid="button-request-email-change">Request Change</button>;

  return <section className="pf-card pf-pad" aria-labelledby="pf-personal-title" data-testid="section-personal-info">
    <div className="pf-card-head">
      <div><h2 id="pf-personal-title">Personal information</h2><p>{connected ? 'Saved to your account.' : 'Saved in this browser only.'}</p></div>
      {!editing && <button type="button" className="pf-btn ghost small" onClick={start} data-testid="button-edit-personal"><Pencil size={13} /> Edit details</button>}
    </div>
    {editing ? <form className="pf-form" noValidate onSubmit={e => void save(e)} data-testid="form-personal-info">
      {field('name', 'Full name', { autoComplete: 'name' })}
      {field('displayName', 'Display name', { autoComplete: 'nickname', placeholder: 'e.g. Henderson' }, `Shown as your handle: ${profileHandle({ name: form.watch('name'), displayName: form.watch('displayName') })}`)}
      <div className="pf-field pf-field-full">
        <span className="pf-label-row"><label htmlFor="pf-email-locked">Email address</label></span>
        <div className="pf-locked"><Lock size={13} aria-hidden="true" /><input id="pf-email-locked" className="pf-input" value={profile.email} readOnly aria-readonly="true" data-testid="input-profile-email-locked" />{emailAction}</div>
        <span className="pf-hint">Your sign-in address. Changing it needs your password and a code sent to the new address.</span>
      </div>
      <div className="pf-field pf-field-full">
        <label htmlFor="pf-phoneNumber">Phone number</label>
        <div className="pf-phone">
          <select className="pf-input pf-dial" aria-label="Country code" {...register('dialCode')} data-testid="select-profile-dial-code">
            {DIAL_CODES.map(d => <option key={d.code} value={d.code}>{d.label}</option>)}<option value={OTHER_CODE}>Other (type +code)</option>
          </select>
          <input id="pf-phoneNumber" className="pf-input" type="tel" autoComplete="tel-national" placeholder="803 555 0100" {...register('phoneNumber')} aria-invalid={!!errors.phoneNumber} aria-describedby={errors.phoneNumber ? 'pf-phoneNumber-error' : undefined} data-testid="input-profile-phoneNumber" />
        </div>
        <FieldError id="pf-phoneNumber-error" message={errors.phoneNumber?.message} />
      </div>
      {field('telegram', 'Telegram handle', { autoComplete: 'off', placeholder: '@username' })}
      {field('birthDate', 'Date of birth', { type: 'date', max: new Date().toISOString().slice(0, 10) })}
      {field('address', 'Address', { autoComplete: 'street-address' }, 'Optional.')}
      <div className="pf-form-actions pf-field-full">
        <button type="button" className="pf-btn ghost" onClick={() => setEditing(false)} data-testid="button-cancel-personal">Cancel</button>
        <button type="submit" className="pf-btn primary" disabled={isSubmitting} data-testid="button-save-personal">{isSubmitting ? <LoaderCircle size={14} className="pf-spin" /> : <Check size={14} />} Save changes</button>
      </div>
    </form>
    : <div className="pf-rows">
      <InfoRow label="Full name" value={profile.name} testId="row-profile-full-name" />
      <InfoRow label="Display name" value={profile.displayName ?? ''} testId="row-profile-display-name" />
      <InfoRow label="Email address" value={profile.email} icon={<Lock size={13} className="pf-lock" aria-label="Locked" />} action={emailAction} testId="row-profile-email" />
      <InfoRow label="Phone number" value={profile.phone} testId="row-profile-phone" />
      <InfoRow label="Telegram handle" value={profile.telegram ? `@${profile.telegram}` : ''} testId="row-profile-telegram" />
      <InfoRow label="Date of birth" value={profile.birthDate ? fmtDate(profile.birthDate) : ''} testId="row-profile-birth-date" />
      {profile.address && <InfoRow label="Address" value={profile.address} testId="row-profile-address" />}
    </div>}
  </section>;
}

// ---------- Module 3: security and privacy ----------

function StrengthMeter({ password }: { password: string }) {
  const s = passwordStrength(password);
  return <div className="pf-strength" data-testid="meter-password-strength" data-score={s.score}>
    <div className="pf-strength-bars" aria-hidden="true">{[1, 2, 3, 4].map(i => <span key={i} className={i <= s.score ? `on s${s.score}` : ''} />)}</div>
    <span aria-live="polite">{password ? `${s.label}${s.missing.length ? ` · add ${s.missing.join(', ')}` : ''}` : 'Use 8+ characters with upper- and lower-case letters, a number, and a symbol.'}</span>
  </div>;
}

type PasswordForm = { current: string; next: string; confirm: string };
export const passwordSchema = z.object({ current: z.string(), next: z.string(), confirm: z.string() }).superRefine((v, ctx) => {
  if (!v.current) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['current'], message: 'Enter your current password.' });
  if (passwordStrength(v.next).score < MIN_PASSWORD_SCORE) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['next'], message: 'Choose a stronger password (at least “Good”).' });
  else if (v.next === v.current) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['next'], message: 'Choose a password different from your current one.' });
  if (!v.confirm) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirm'], message: 'Confirm your new password.' });
  else if (v.confirm !== v.next) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirm'], message: 'Passwords do not match.' });
});

function ChangePasswordModal({ onClose, onToast, onChanged }: { onClose: () => void; onToast: Toast; onChanged: () => void }) {
  const session = useSession();
  const { connected } = useServerData();
  const { register, handleSubmit, watch, setError, formState: { errors, isSubmitting } } = useForm<PasswordForm>({ resolver: zodResolver(passwordSchema), mode: 'onChange', defaultValues: { current: '', next: '', confirm: '' } });
  const submit = handleSubmit(async v => {
    try { await checkPassword({ password: v.current }); }
    catch (err) { const f = apiError(err, "Couldn't check your password. Try again."); setError('current', { message: f.fieldErrors?.['currentPassword'] ?? f.error }); return; }
    const failure = await session.changePassword(v.next);
    if (failure) { setError('next', { message: failure }); return; }
    await reportPasswordChanged().catch(() => {});
    onChanged();
    onToast('Password changed. Other devices stay signed in until you log them out below.');
    onClose();
  });
  const input = (name: keyof PasswordForm, label: string, autoComplete: string) => <div className="pf-field pf-field-full">
    <label htmlFor={`pf-pw-${name}`}>{label}</label>
    <input id={`pf-pw-${name}`} className="pf-input" type="password" autoComplete={autoComplete} {...register(name)} aria-invalid={!!errors[name]} aria-describedby={errors[name] ? `pf-pw-${name}-error` : undefined} data-testid={`input-password-${name}`} {...(name === 'current' ? { 'data-autofocus': true } : {})} />
    <FieldError id={`pf-pw-${name}-error`} message={errors[name]?.message} />
  </div>;
  return <Modal title="Change password" subtitle="Enter your current password, then choose a new one." onClose={onClose} testId="modal-change-password">
    <form className="pf-form single" noValidate onSubmit={e => void submit(e)}>
      {input('current', 'Current password', 'current-password')}
      {input('next', 'New password', 'new-password')}
      <StrengthMeter password={watch('next')} />
      {input('confirm', 'Confirm new password', 'new-password')}
      {!connected && <p className="pf-note" data-testid="note-password-preview">Sign-in isn't connected in this preview, so passwords can't be changed here.</p>}
      <div className="pf-form-actions pf-field-full">
        <button type="button" className="pf-btn ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="pf-btn primary" disabled={!connected || isSubmitting} data-testid="button-submit-password">{isSubmitting ? <LoaderCircle size={14} className="pf-spin" /> : <KeyRound size={14} />} Change password</button>
      </div>
    </form>
  </Modal>;
}

type EmailForm = { current: string; email: string };
function ChangeEmailModal({ onClose, onToast, onChanged }: { onClose: () => void; onToast: Toast; onChanged: () => void }) {
  const session = useSession();
  const { connected } = useServerData();
  const { state: { profile } } = useDemoStore();
  const [step, setStep] = useState<'details' | 'code'>('details');
  const [newEmail, setNewEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const schema = z.object({
    current: z.string().min(1, 'Enter your current password.'),
    email: z.string().trim().min(1, 'Enter the new email address.').email('Enter a valid email address.')
      .refine(v => v.toLowerCase() !== profile.email.toLowerCase(), 'That is already your email address.'),
  });
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<EmailForm>({ resolver: zodResolver(schema), mode: 'onChange', defaultValues: { current: '', email: '' } });
  const request = handleSubmit(async v => {
    try { await checkPassword({ password: v.current }); }
    catch (err) { const f = apiError(err, "Couldn't check your password. Try again."); setError('current', { message: f.fieldErrors?.['currentPassword'] ?? f.error }); return; }
    const failure = await session.requestEmailChange(v.email);
    if (failure) { setError('email', { message: failure }); return; }
    await reportSecurityEvent({ kind: 'email_change_requested' }).catch(() => {});
    setNewEmail(v.email.trim()); setStep('code'); onChanged();
  });
  const verify = async () => {
    if (!/^\d{6,10}$/.test(code)) { setCodeError('Enter the code from the email we sent to your new address.'); return; }
    setBusy(true);
    const failure = await session.verifyEmailChange(newEmail, code);
    setBusy(false);
    if (failure) { setCodeError(failure); return; }
    onChanged();
    onToast('Email change confirmed. If we also emailed your current address, confirm there too.');
    onClose();
  };
  const resend = async () => {
    setBusy(true);
    const failure = await session.requestEmailChange(newEmail);
    setBusy(false);
    onToast(failure ?? `A new code is on its way to ${newEmail}.`);
  };
  return <Modal title="Change email address" subtitle={step === 'details' ? 'Confirm it\'s you, then enter the new address.' : `Enter the code we sent to ${newEmail}.`} onClose={onClose} testId="modal-change-email">
    {step === 'details' ? <form className="pf-form single" noValidate onSubmit={e => void request(e)}>
      <div className="pf-field pf-field-full"><span className="pf-label-row"><span>Current email</span></span><div className="pf-locked"><Lock size={13} aria-hidden="true" /><span className="pf-locked-text">{profile.email}</span></div></div>
      <div className="pf-field pf-field-full"><label htmlFor="pf-em-current">Current password</label><input id="pf-em-current" className="pf-input" type="password" autoComplete="current-password" data-autofocus {...register('current')} aria-invalid={!!errors.current} aria-describedby={errors.current ? 'pf-em-current-error' : undefined} data-testid="input-email-current-password" /><FieldError id="pf-em-current-error" message={errors.current?.message} /></div>
      <div className="pf-field pf-field-full"><label htmlFor="pf-em-new">New email address</label><input id="pf-em-new" className="pf-input" type="email" autoComplete="email" {...register('email')} aria-invalid={!!errors.email} aria-describedby={errors.email ? 'pf-em-new-error' : undefined} data-testid="input-email-new" /><FieldError id="pf-em-new-error" message={errors.email?.message} /></div>
      {!connected && <p className="pf-note" data-testid="note-email-preview">Sign-in isn't connected in this preview, so the email can't be changed here.</p>}
      <div className="pf-form-actions pf-field-full">
        <button type="button" className="pf-btn ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="pf-btn primary" disabled={!connected || isSubmitting} data-testid="button-submit-email-change">{isSubmitting ? <LoaderCircle size={14} className="pf-spin" /> : <Mail size={14} />} Send verification code</button>
      </div>
    </form>
    : <form className="pf-form single" noValidate onSubmit={e => { e.preventDefault(); void verify(); }}>
      <div className="pf-field pf-field-full"><label htmlFor="pf-em-code">Verification code</label><input id="pf-em-code" className="pf-input pf-code" inputMode="numeric" autoComplete="one-time-code" maxLength={10} data-autofocus value={code} onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 10)); setCodeError(null); }} aria-invalid={!!codeError} aria-describedby={codeError ? 'pf-em-code-error' : 'pf-em-code-hint'} data-testid="input-email-code" />
        {codeError ? <FieldError id="pf-em-code-error" message={codeError} /> : <span className="pf-hint" id="pf-em-code-hint">You can also click the link in that email instead. Your sign-in email stays the same until the change is confirmed.</span>}</div>
      <div className="pf-form-actions pf-field-full">
        <button type="button" className="pf-btn ghost" onClick={() => void resend()} disabled={busy} data-testid="button-resend-email-code">Send a new code</button>
        <button type="submit" className="pf-btn primary" disabled={busy} data-testid="button-verify-email-code">{busy ? <LoaderCircle size={14} className="pf-spin" /> : <Check size={14} />} Confirm change</button>
      </div>
    </form>}
  </Modal>;
}

function TwoStepModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  return <Modal title="Set up an authenticator app" subtitle="Scan the QR code with Google Authenticator, Authy, or a similar app, then enter the 6-digit code it shows." onClose={onClose} testId="modal-two-step">
    <TwoStepSetupForm ui="app" onCancel={onClose} onDone={onDone} />
  </Modal>;
}

function SecurityPanel({ onToast, openPassword, openEmail, onActivity }: { onToast: Toast; openPassword: () => void; openEmail: () => void; onActivity: () => void }) {
  const { state, run } = useDemoStore();
  const { connected } = useServerData();
  const session = useSession();
  const { profile } = state;
  const privacy = privacyOf(profile);
  const account = accountOf(state, CURRENT_APPLICANT_ID);
  const [saving, setSaving] = useState<keyof PrivacyPreferences | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const enrolled = connected ? session.factors.length > 0 : profile.twoFactor;

  const toggle = async (key: keyof PrivacyPreferences) => {
    const next = { ...privacy, [key]: !privacy[key] };
    if (!connected) { run(s => setPrivacy(s, next)); onToast('Security preferences saved'); return; }
    setSaving(key);
    try { run(adopt(await saveServerPrivacy(next))); onToast('Security preferences saved'); }
    catch (err) { onToast(apiError(err, "Couldn't save your preferences. Try again.").error); }
    finally { setSaving(null); }
  };
  const report = (kind: SecurityEventReportKind) => reportSecurityEvent({ kind }).then(onActivity, () => {});
  const complete = async (kind: 'password' | 'twoFactor') => {
    if (!connected) { const r = run(s => completeCredentialReset(s, kind)); onToast(r.ok ? r.message : r.error); return; }
    try { run(adopt(await completeServerReset({ kind }))); onToast(kind === 'password' ? 'Password reset recorded.' : 'Two-step sign-in reset recorded.'); }
    catch (err) { onToast(apiError(err, "Couldn't record that. Try again.").error); }
  };
  const removeFactor = async (id: string) => {
    setConfirmRemove(null);
    const failure = await session.removeTwoStep(id);
    if (failure) { onToast(failure); return; }
    onToast('Authenticator app removed.');
    if (session.factors.length <= 1) void report('two_step_off');
  };

  return <section className="pf-card pf-security" aria-labelledby="pf-security-title" data-testid="section-security">
    <div className="pf-card-head dark"><div><h2 id="pf-security-title">Security &amp; privacy</h2><p>Control what's recorded and how you're alerted.</p></div><ShieldCheck size={20} className="pf-lime" aria-hidden="true" /></div>

    <div className="pf-sec-row" data-testid="row-activity-logging">
      <span className="pf-sec-icon"><MonitorSmartphone size={16} /></span>
      <div className="pf-sec-copy"><strong>Save my activity logs</strong><span>{privacy.activityLogging ? 'On · browser, device, IP address, and location are kept with each security event.' : 'Off · events are kept without device, IP address, or location.'}</span></div>
      <Toggle on={privacy.activityLogging} disabled={saving !== null} label="Save my activity logs" onChange={() => void toggle('activityLogging')} testId="toggle-activity-logging" />
    </div>
    <div className="pf-sec-row" data-testid="row-unusual-activity">
      <span className="pf-sec-icon"><Mail size={16} /></span>
      <div className="pf-sec-copy"><strong>Email me on unusual activity</strong><span>{privacy.unusualActivityEmail ? 'On · we email you when a device we haven\'t seen signs in.' : 'Off · new-device sign-ins show in your notifications only.'}</span></div>
      <Toggle on={privacy.unusualActivityEmail} disabled={saving !== null} label="Email me on unusual activity" onChange={() => void toggle('unusualActivityEmail')} testId="toggle-unusual-activity" />
    </div>

    <div className="pf-sec-row wrap" data-testid="row-two-step">
      <span className="pf-sec-icon"><Smartphone size={16} /></span>
      <div className="pf-sec-copy"><strong>Two-factor authentication <Pill tone={enrolled ? 'ok' : 'bad'} testId="status-two-step">{enrolled ? 'Enabled' : 'Disabled'}</Pill></strong>
        <span>{account.twoFactorResetRequired ? 'The grant team reset this. Remove your old authenticator app, add a new one, then confirm.' : enrolled ? 'A code from your authenticator app is needed each time you sign in.' : 'Add Google Authenticator, Authy, or a similar app so a stolen password isn\'t enough.'}</span>
        {connected && session.factors.map(f => <div key={f.id} className="pf-factor"><span>{f.name}</span><small>Added {fmtDate(f.createdAt)}</small>{confirmRemove === f.id
          ? <button type="button" className="pf-text-btn danger" onClick={() => void removeFactor(f.id)} data-testid={`button-confirm-remove-factor-${f.id}`}>Confirm remove</button>
          : <button type="button" className="pf-text-btn light" onClick={() => setConfirmRemove(f.id)} data-testid={`button-remove-factor-${f.id}`}>Remove</button>}</div>)}
      </div>
      {connected
        ? (!enrolled || account.twoFactorResetRequired) && <button type="button" className="pf-btn primary small" onClick={() => setSettingUp(true)} data-testid="button-setup-two-step">{account.twoFactorResetRequired ? 'Add new app' : 'Configure'}</button>
        : account.twoFactorResetRequired
          ? <button type="button" className="pf-btn primary small" onClick={() => void complete('twoFactor')} data-testid="button-complete-2fa-reset">Set up again</button>
          : <Toggle on={profile.twoFactor} label="Two-factor authentication (preview setting)" onChange={() => { const r = run(s => setTwoFactor(s, !profile.twoFactor)); if (r.ok) onToast(r.message); }} testId="toggle-two-step-preview" />}
    </div>
    {connected && account.twoFactorResetRequired && enrolled && <div className="pf-sec-row"><span className="pf-sec-icon"><Check size={16} /></span><div className="pf-sec-copy"><strong>Finished setting up the new app?</strong><span>Confirm so the grant team's reset is marked done.</span></div><button type="button" className="pf-btn ghost small dark" onClick={() => void complete('twoFactor')} data-testid="button-complete-2fa-reset">Confirm</button></div>}
    {account.passwordResetRequired && <div className="pf-sec-row" data-testid="row-password-reset"><span className="pf-sec-icon warn"><LockKeyhole size={16} /></span><div className="pf-sec-copy"><strong>New password required</strong><span>{connected ? 'Requested by the grant team. Sign out, use “Forgot password?” on the sign-in page, and choose a new password from the emailed link; that completes it.' : 'Requested by the grant team. Sign-in isn\'t connected, so nothing is stored.'}</span></div><button type="button" className="pf-btn ghost small dark" onClick={() => void complete('password')} data-testid="button-complete-password-reset">I've reset it</button></div>}

    <div className="pf-sec-actions">
      <button type="button" className="pf-btn lime-outline" onClick={openEmail} data-testid="button-change-email"><Mail size={14} /> Change email address</button>
      <button type="button" className="pf-btn lime-outline" onClick={openPassword} data-testid="button-change-password"><KeyRound size={14} /> Change password</button>
    </div>
    {settingUp && <TwoStepModal onClose={() => setSettingUp(false)} onDone={() => { setSettingUp(false); onToast('Two-step sign-in is on.'); void report('two_step_on'); if (account.twoFactorResetRequired) void complete('twoFactor'); }} />}
  </section>;
}

// ---------- Module 4: security activity ----------

const EVENT_LABELS: Record<SecurityEvent['kind'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }> = {
  sign_in: { label: 'Successful login', tone: 'ok' },
  new_device_sign_in: { label: 'Successful login · new device', tone: 'warn' },
  password_changed: { label: 'Password change', tone: 'muted' },
  failed_password_check: { label: 'Failed attempt', tone: 'bad' },
  email_change_requested: { label: 'Email change requested', tone: 'muted' },
  email_changed: { label: 'Email changed', tone: 'muted' },
  two_step_on: { label: 'Two-step turned on', tone: 'ok' },
  two_step_off: { label: 'Two-step turned off', tone: 'warn' },
  signed_out_others: { label: 'Other devices logged out', tone: 'muted' },
};
/** Shown in the browser-only preview so the table's layout is visible; never mixed with real records. */
const SAMPLE_EVENTS: SecurityEvent[] = [
  { id: 'sample-1', kind: 'sign_in', device: 'Chrome on Windows', ip: '102.89.34.12', location: 'Port Harcourt, NG', at: '2026-09-28T08:14:00.000Z' },
  { id: 'sample-2', kind: 'failed_password_check', device: 'Safari on iOS', ip: '102.89.40.7', location: 'Lagos, NG', at: '2026-09-26T19:02:00.000Z' },
  { id: 'sample-3', kind: 'password_changed', device: 'Chrome on Windows', ip: '102.89.34.12', location: 'Port Harcourt, NG', at: '2026-09-21T10:45:00.000Z' },
];

function SecurityActivity({ events, error, onToast, onActivity }: { events: SecurityEvent[] | null; error: string | null; onToast: Toast; onActivity: () => void }) {
  const { connected } = useServerData();
  const session = useSession();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const rows = connected ? events ?? [] : SAMPLE_EVENTS;
  const signOutOthers = async () => {
    setConfirm(false); setBusy(true);
    const failure = await session.signOutOthers();
    if (!failure) await reportSecurityEvent({ kind: 'signed_out_others' }).then(onActivity, () => {});
    setBusy(false);
    onToast(failure ?? 'Logged out of all other devices. This device stays signed in.');
  };
  const empty = (value: string | null) => value ?? <span className="pf-muted" title="Not recorded (activity logging was off)">—</span>;
  return <section className="pf-card pf-pad" aria-labelledby="pf-activity-title" data-testid="section-security-activity">
    <div className="pf-card-head">
      <div><h2 id="pf-activity-title">Recent security activity</h2><p>{connected ? 'Sign-ins and account changes, newest first.' : 'Sample rows: activity is recorded once sign-in is connected.'}</p></div>
      <div className="pf-activity-actions">{confirm
        ? <><button type="button" className="pf-btn danger small" onClick={() => void signOutOthers()} data-testid="button-confirm-logout-others">Yes, log them out</button><button type="button" className="pf-btn ghost small" onClick={() => setConfirm(false)}>Cancel</button></>
        : <button type="button" className="pf-btn ghost small" onClick={() => setConfirm(true)} disabled={!connected || busy} title={connected ? undefined : 'Available once sign-in is connected'} data-testid="button-logout-others"><LogOut size={13} /> Log Out All Other Devices</button>}</div>
    </div>
    {error && <p className="pf-note" role="alert">{error}</p>}
    <div className="pf-table-wrap">
      <table className="pf-table" data-testid="table-security-activity">
        <thead><tr><th scope="col">Device / Browser</th><th scope="col">IP Address</th><th scope="col">Location</th><th scope="col">Date &amp; Time</th><th scope="col">Status</th></tr></thead>
        <tbody>{rows.length ? rows.map(e => { const l = EVENT_LABELS[e.kind]; return <tr key={e.id} data-testid={`row-security-event-${e.id}`}>
          <td data-label="Device / Browser"><span className="pf-device"><MonitorSmartphone size={14} aria-hidden="true" />{empty(e.device)}</span>{!connected && <Pill tone="muted">Sample</Pill>}</td>
          <td data-label="IP Address" className="pf-mono">{empty(e.ip)}</td>
          <td data-label="Location">{empty(e.location)}</td>
          <td data-label="Date & Time">{fmtDateTime(e.at)}</td>
          <td data-label="Status"><Pill tone={l.tone}>{l.label}</Pill></td>
        </tr>; })
          : <tr><td colSpan={5} className="pf-empty" data-testid="empty-security-activity">{events === null && connected && !error ? 'Loading…' : 'No security activity yet. Your sign-ins and account changes will appear here.'}</td></tr>}</tbody>
      </table>
    </div>
  </section>;
}

// ---------- The page ----------

export function ProfilePage({ onToast }: { onToast: Toast }) {
  const { run } = useDemoStore();
  const { connected } = useServerData();
  const [avatarVersion, setAvatarVersion] = useState<string | null>(null);
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [modal, setModal] = useState<'password' | 'email' | null>(null);

  // The photo's version and the latest profile-center fields come from the server.
  useEffect(() => {
    if (!connected) return;
    let live = true;
    getProfile().then(p => { if (!live) return; run(adopt(p)); setAvatarVersion(p.avatarUpdatedAt ?? null); }).catch(() => {});
    return () => { live = false; };
  }, [connected, run]);

  const loadEvents = useCallback(() => {
    if (!connected) return;
    listSecurityEvents().then(e => { setEvents(e); setEventsError(null); }).catch(err => setEventsError(apiError(err, "Couldn't load your security activity.").error));
  }, [connected]);
  useEffect(() => { loadEvents(); }, [loadEvents]);

  return <div className="pf-page" data-testid="page-profile">
    <PhotoHeader onToast={onToast} avatarVersion={avatarVersion} setAvatarVersion={setAvatarVersion} />
    <div className="pf-grid">
      <PersonalInfo onToast={onToast} onRequestEmailChange={() => setModal('email')} />
      <SecurityPanel onToast={onToast} openPassword={() => setModal('password')} openEmail={() => setModal('email')} onActivity={loadEvents} />
    </div>
    <SecurityActivity events={events} error={eventsError} onToast={onToast} onActivity={loadEvents} />
    {modal === 'password' && <ChangePasswordModal onClose={() => setModal(null)} onToast={onToast} onChanged={loadEvents} />}
    {modal === 'email' && <ChangeEmailModal onClose={() => setModal(null)} onToast={onToast} onChanged={loadEvents} />}
  </div>;
}
