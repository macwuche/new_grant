import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AppNameText, BrandLetter, Wordmark } from '@/lib/appName';
import { Link, Redirect, useLocation } from 'wouter';
import { ArrowRight, Eye, EyeOff, Info, LoaderCircle, LogOut, ShieldCheck } from 'lucide-react';
import { ROLE_LABELS } from '@workspace/authz';
import { adoptSessionStaff } from '@workspace/domain/staff';
import { useDemoStore } from '@/lib/store';
import { useSession } from '@/lib/session';
import { TwoStepCodeForm, TwoStepSetupForm } from '@/components/TwoStep';
import './AuthPages.css';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function StaffFrame({ serial, title, children }: { serial: string; title: ReactNode; children: ReactNode }) {
  return <main className="auth-page auth-staff">
    <aside className="auth-story" aria-label="About the admin workspace">
      <Link href="/admin/login" className="auth-logo" aria-label="Admin sign-in" data-testid="link-admin-auth-brand">
        <span className="auth-logo-mark" aria-hidden="true"><BrandLetter /></span>
        <span className="auth-logo-word"><Wordmark /></span>
      </Link>
      <div className="auth-story-center">
        <div className="auth-serial">{serial}</div>
        <h2>{title}</h2>
        <p className="auth-story-text">For the grant team: reviewers, finance, compliance, and support. Access follows the role you've been given.</p>
      </div>
      <div className="auth-story-bottom"><span><AppNameText /> / team workspace</span><span>Staff access only.</span></div>
    </aside>
    <section className="auth-content" aria-label="Staff sign-in">
      <div className="auth-topline"><span>Applying for a grant?</span><Link href="/login" data-testid="link-admin-login-applicant">Applicant sign-in</Link></div>
      {children}
      <footer className="auth-bottomline"><span>© <AppNameText /> · Team workspace</span><span>Every staff action is recorded.</span></footer>
    </section>
  </main>;
}

function Notice({ children, testId, tone = 'info' }: { children: ReactNode; testId: string; tone?: 'info' | 'error' }) {
  return <div className={`auth-feedback ${tone === 'error' ? 'auth-feedback-error' : ''}`} role={tone === 'error' ? 'alert' : 'status'} data-testid={testId}><Info size={16} aria-hidden="true" /><span>{children}</span></div>;
}

function PasswordInput({ id, value, onChange, autoComplete, invalid, testId }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; invalid: boolean; testId: string }) {
  const [show, setShow] = useState(false);
  return <div className="auth-password-wrap">
    <input id={id} type={show ? 'text' : 'password'} className="auth-input" value={value} onChange={e => onChange(e.target.value)} autoComplete={autoComplete} aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined} data-testid={testId} />
    <button type="button" className="auth-show" onClick={() => setShow(v => !v)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>{show ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}</button>
  </div>;
}

/** /admin/login: staff sign-in with Supabase, plus "forgot password". */
export function AdminLoginPage() {
  const session = useSession();
  const [mode, setMode] = useState<'signin' | 'forgot'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (session.status === 'signedIn' && session.me?.staff?.active) return <Redirect to="/admin" replace />;
  const configured = session.status !== 'unconfigured';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: typeof errors = {};
    if (!EMAIL.test(email.trim())) next.email = 'Enter your work email address.';
    if (mode === 'signin' && !password) next.password = 'Enter your password.';
    setErrors(next); setMessage(null);
    if (Object.keys(next).length || !configured) return;
    setBusy(true);
    if (mode === 'signin') {
      const error = await session.signIn(email, password);
      if (error) setMessage({ tone: 'error', text: error });
      setPassword('');
    } else {
      const error = await session.sendReset(email, '/admin/reset-password');
      // Same answer whether or not the address has an account, so this can't be used to find staff emails.
      setMessage(error ? { tone: 'error', text: error } : { tone: 'info', text: `If ${email.trim()} has an account, a reset link is on its way. It expires after an hour.` });
    }
    setBusy(false);
  };
  const switchMode = (next: 'signin' | 'forgot') => { setMode(next); setErrors({}); setMessage(null); };

  return <StaffFrame serial="01 / TEAM ACCESS" title={<>The work behind <em>every decision.</em></>}>
    <div className="auth-form-wrap">
      <div className="auth-eyebrow"><ShieldCheck size={13} aria-hidden="true" style={{ display: 'inline', verticalAlign: '-2px' }} /> Staff sign-in</div>
      <h1>{mode === 'signin' ? 'Sign in to the team workspace.' : 'Reset your password.'}</h1>
      <p className="auth-lede">{mode === 'signin' ? 'Use the work email the grant team added you with. Your role decides what you can see and do.' : "Enter your work email and we'll send a link to choose a new password."}</p>
      {!configured && <Notice testId="notice-admin-login-unconfigured">Staff sign-in isn't set up on this site yet (the Supabase keys are missing), so this form can't sign you in. <Link href="/admin" className="auth-inline-link" data-testid="link-admin-login-demo">Open the preview workspace</Link> to explore with sample staff instead.</Notice>}
      {session.status === 'signedIn' && !session.me?.staff?.active && <NoAccessMessage />}
      <form className="auth-form" noValidate onSubmit={submit} data-testid="form-admin-login">
        <div className="auth-field">
          <label className="auth-label" htmlFor="admin-email">Work email</label>
          <input id="admin-email" type="email" className="auth-input" value={email} onChange={e => { setEmail(e.target.value); setErrors(v => ({ ...v, email: undefined })); }} placeholder="you@example.org" autoComplete="username" aria-invalid={!!errors.email} aria-describedby={errors.email ? 'admin-email-error' : undefined} data-testid="input-admin-login-email" />
          {errors.email && <p className="auth-error" id="admin-email-error">{errors.email}</p>}
        </div>
        {mode === 'signin' && <div className="auth-field">
          <div className="auth-field-header"><label className="auth-label" htmlFor="admin-password">Password</label><button type="button" className="auth-inline-link auth-link-button" onClick={() => switchMode('forgot')} data-testid="button-admin-login-forgot">Forgot password?</button></div>
          <PasswordInput id="admin-password" value={password} onChange={v => { setPassword(v); setErrors(e => ({ ...e, password: undefined })); }} autoComplete="current-password" invalid={!!errors.password} testId="input-admin-login-password" />
          {errors.password && <p className="auth-error" id="admin-password-error">{errors.password}</p>}
        </div>}
        <button type="submit" className="auth-button" disabled={busy || !configured} data-testid="button-admin-login-submit">
          {busy ? <LoaderCircle size={18} className="auth-spin" aria-hidden="true" /> : null}{mode === 'signin' ? 'Sign in' : 'Send reset link'} {!busy && <ArrowRight size={18} aria-hidden="true" />}
        </button>
      </form>
      {message && <Notice testId="status-admin-login" tone={message.tone}>{message.text}</Notice>}
      <p className="auth-aside">{mode === 'signin' ? <>New to the team? Ask a super admin to add your work email, then sign up with it and confirm it.</> : <button type="button" className="auth-inline-link auth-link-button" onClick={() => switchMode('signin')} data-testid="button-admin-login-back">Back to sign in</button>}</p>
    </div>
  </StaffFrame>;
}

/** /admin/reset-password: reached from the emailed link, which signs the person in for this one purpose. */
export function AdminResetPasswordPage() {
  const session = useSession();
  const [, navigate] = useLocation();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = session.status === 'signedIn' || session.recovery;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: typeof errors = {};
    if (password.length < 8) next.password = 'Use at least 8 characters.';
    if (confirm !== password) next.confirm = "The passwords don't match.";
    setErrors(next); setMessage(null);
    if (Object.keys(next).length) return;
    setBusy(true);
    const error = await session.setNewPassword(password);
    setBusy(false);
    if (error) { setMessage({ tone: 'error', text: error }); return; }
    setMessage({ tone: 'info', text: 'Password updated. Taking you to the workspace…' });
    window.setTimeout(() => navigate('/admin'), 1200);
  };

  return <StaffFrame serial="02 / RECOVER" title={<>Back in, <em>safely.</em></>}>
    <div className="auth-form-wrap">
      <div className="auth-eyebrow">Staff password reset</div>
      <h1>Choose a new password.</h1>
      {session.status === 'unconfigured' ? <Notice testId="notice-admin-reset-unconfigured">Staff sign-in isn't set up on this site yet.</Notice>
        : session.status === 'loading' ? <p className="auth-lede">Checking your reset link…</p>
        : !ready ? <><Notice testId="notice-admin-reset-invalid" tone="error">This reset link is invalid or has expired. Request a new one from the sign-in page.</Notice><p className="auth-aside"><Link href="/admin/login" className="auth-inline-link">Back to sign in</Link></p></>
        : <form className="auth-form" noValidate onSubmit={submit} data-testid="form-admin-reset">
          <div className="auth-field"><label className="auth-label" htmlFor="new-password">New password</label><PasswordInput id="new-password" value={password} onChange={v => { setPassword(v); setErrors(e => ({ ...e, password: undefined })); }} autoComplete="new-password" invalid={!!errors.password} testId="input-admin-new-password" />{errors.password && <p className="auth-error" id="new-password-error">{errors.password}</p>}</div>
          <div className="auth-field"><label className="auth-label" htmlFor="confirm-password">Confirm new password</label><PasswordInput id="confirm-password" value={confirm} onChange={v => { setConfirm(v); setErrors(e => ({ ...e, confirm: undefined })); }} autoComplete="new-password" invalid={!!errors.confirm} testId="input-admin-confirm-password" />{errors.confirm && <p className="auth-error" id="confirm-password-error">{errors.confirm}</p>}</div>
          <button type="submit" className="auth-button" disabled={busy} data-testid="button-admin-reset-submit">Save new password <ArrowRight size={18} aria-hidden="true" /></button>
        </form>}
      {message && <Notice testId="status-admin-reset" tone={message.tone}>{message.text}</Notice>}
    </div>
  </StaffFrame>;
}

function NoAccessMessage() {
  const session = useSession();
  const text = session.meError ?? (session.me?.staff && !session.me.staff.active
    ? 'Your staff access has been disabled. Ask a super admin if you think this is a mistake.'
    : `${session.me?.user.email ?? 'This account'} isn't on the grant team. If you should have access, ask a super admin to add this email, then sign in again.`);
  return <Notice testId="notice-admin-no-access" tone="error">{text} <button type="button" className="auth-inline-link auth-link-button" onClick={() => void session.signOut()} data-testid="button-admin-no-access-signout">Sign out</button></Notice>;
}

/**
 * Guards /admin. With sign-in configured, only a signed-in, active staff member
 * gets in, and they become the acting member in the demo store. Without it, the
 * demo workspace (with its "acting as" switcher) stays open.
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const { state, run } = useDemoStore();
  const staff = session.me?.staff;
  const twoStep = session.me?.twoStep;
  // Staff need a two-step session (when the server requires it for staff, or once they've set it up).
  const needsTwoStep = session.status === 'signedIn' && !!staff?.active && !!twoStep && twoStep.level !== 'aal2' && (twoStep.requiredForStaff || twoStep.enrolled);
  const allowed = session.status === 'signedIn' && !!staff?.active && !needsTwoStep;
  useEffect(() => {
    if (allowed && staff) run(s => adoptSessionStaff(s, { id: staff.id, name: staff.name, role: staff.role }));
  }, [allowed, staff?.id, staff?.name, staff?.role, run]);

  if (session.status === 'unconfigured') return <>{children}</>;
  if (session.status === 'loading') return <div className="admin-gate-loading" role="status" data-testid="status-admin-gate-loading"><LoaderCircle size={22} className="auth-spin" aria-hidden="true" /> Checking your staff access…</div>;
  if (session.status === 'signedOut') return <Redirect to="/admin/login" replace />;
  if (needsTwoStep) return <StaffFrame serial="01 / TWO-STEP" title={<>One more <em>step.</em></>}><div className="auth-form-wrap" data-testid="panel-admin-two-step">
    <div className="auth-eyebrow"><ShieldCheck size={13} aria-hidden="true" style={{ display: 'inline', verticalAlign: '-2px' }} /> Two-step sign-in</div>
    {twoStep!.enrolled
      ? <><h1>Enter your code.</h1><p className="auth-lede">Open your authenticator app and enter the current code for <AppNameText />.</p><TwoStepCodeForm /></>
      : <><h1>Protect your staff account.</h1><p className="auth-lede">Staff access needs two-step sign-in: your password plus a code from an authenticator app. Set it up once; you'll enter a code each time you sign in.</p><TwoStepSetupForm /></>}
    <p className="auth-aside"><button type="button" className="auth-inline-link auth-link-button" onClick={() => void session.signOut()} data-testid="button-admin-two-step-signout">Sign out</button></p>
  </div></StaffFrame>;
  if (!allowed) return <StaffFrame serial="00 / NO ACCESS" title={<>This area is for <em>the grant team.</em></>}><div className="auth-form-wrap"><h1>You can't open the team workspace.</h1><NoAccessMessage /><p className="auth-aside"><Link href="/" className="auth-inline-link">Go to the applicant workspace</Link></p></div></StaffFrame>;
  if (state.actingStaffId !== staff!.id) return <div className="admin-gate-loading" role="status"><LoaderCircle size={22} className="auth-spin" aria-hidden="true" /> Opening your workspace…</div>;
  return <>{children}</>;
}

/** Top-bar identity when signed in: name, role, sign out. Replaces the demo switcher. */
export function AdminSessionMenu() {
  const session = useSession();
  const staff = session.me?.staff;
  if (!staff) return null;
  const initials = staff.name.split(' ').map(p => p[0]).join('').slice(0, 2);
  return <div className="admin-staff-switcher" data-testid="menu-admin-session">
    <span className="admin-avatar" aria-hidden="true">{initials}</span>
    <span className="admin-staff-switcher-copy"><small>{ROLE_LABELS[staff.role]}</small><strong className="admin-session-name">{staff.name}</strong></span>
    <button type="button" className="admin-icon-button" onClick={() => void session.signOut()} aria-label="Sign out" title="Sign out" data-testid="button-admin-signout"><LogOut size={15} /></button>
  </div>;
}
