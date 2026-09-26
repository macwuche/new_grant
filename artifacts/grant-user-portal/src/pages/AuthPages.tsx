import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, ArrowRight, Eye, EyeOff, Info, LoaderCircle, MailCheck } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Link, Redirect, useLocation } from 'wouter';
import { useSession } from '@/lib/session';
import { z } from 'zod';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import './AuthPages.css';

const GrantMatchingAnimation = lazy(() => import('./GrantMatchingAnimation'));

const emailRule = z.string().trim().min(1, 'Enter your email address.').email('Enter a valid email address.');
const loginSchema = z.object({
  email: emailRule,
  password: z.string().min(1, 'Enter your password.'),
});
const signupSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name.'),
  email: emailRule,
  password: z.string().min(8, 'Use at least 8 characters.'),
  confirmPassword: z.string().min(1, 'Confirm your password.'),
}).refine(values => values.password === values.confirmPassword, {
  path: ['confirmPassword'],
  message: 'Passwords do not match.',
});
const detailsSchema = z.object({
  phone: z.string().trim().refine(value => /^\+?[\d ()-]+$/.test(value) && value.replace(/\D/g, '').length >= 7 && value.replace(/\D/g, '').length <= 15, 'Enter a phone number with 7–15 digits.'),
  country: z.string().trim().min(2, 'Enter your country.'),
  sector: z.string().min(1, 'Choose an illustrative sector.'),
  birthDate: z.string().refine(value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    const today = new Date();
    const todayUTC = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && date.getTime() < todayUTC;
  }, 'Enter a real date of birth in the past.'),
  acknowledgement: z.boolean().refine(value => value, 'Acknowledge that policy documents are not configured to continue this preview.'),
});
const resetSchema = z.object({ email: emailRule });
const newPasswordSchema = z.object({
  password: z.string().min(8, 'Use at least 8 characters.'),
  confirmPassword: z.string().min(1, 'Confirm your password.'),
}).refine(values => values.password === values.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match.' });

/** Where to go after sign-in: the page the person was trying to open, if it's a safe in-app path. */
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/';
}

function localeCountrySuggestion() {
  try {
    const region = new Intl.Locale(navigator.language).region;
    return region ? new Intl.DisplayNames([navigator.language], { type: 'region' }).of(region) ?? '' : '';
  } catch {
    return '';
  }
}

type AuthFrameProps = {
  children: ReactNode;
  mode: 'login' | 'signup' | 'reset' | 'not-found';
  topLink: { href: string; prefix: string; label: string; testId: string };
};

function Brand() {
  return <Link href="/" className="auth-logo" aria-label="arc.fund demo workspace" data-testid="link-auth-brand">
    <span className="auth-logo-mark" aria-hidden="true">a</span>
    <span className="auth-logo-word">arc<span>.</span>fund</span>
  </Link>;
}

function AuthFrame({ children, mode, topLink }: AuthFrameProps) {
  const live = useSession().status !== 'unconfigured';
  const is404 = mode === 'not-found';
  const story = {
    login: { number: '01 / ACCESS', title: <>Good work deserves <em>room to grow.</em></>, description: 'A quieter place to keep applications, decisions, and next steps in view.' },
    signup: { number: '02 / BEGIN', title: <>Every next chapter <em>starts somewhere.</em></>, description: 'A clear home for the work behind your next funding opportunity.' },
    reset: { number: '03 / RECOVER', title: <>Take a breath. <em>Find your way back.</em></>, description: 'The details that matter should always be easy to return to.' },
    'not-found': { number: '04 / DETOUR', title: <>A small <em>detour.</em> Not the end of the road.</>, description: 'This address does not lead to a page in the applicant workspace.' },
  }[mode];

  return <main className={`auth-page ${is404 ? 'auth-404' : ''}`}>
    <aside className="auth-story" aria-label="About arc.fund">
      <Brand />
      <div className="auth-story-center">
        <div className="auth-serial">{story.number}</div>
        <h2>{story.title}</h2>
        <p className="auth-story-text">{story.description}</p>
      </div>
      {is404 && <span className="auth-big-number" aria-hidden="true">404</span>}
      <div className="auth-story-bottom">
        <span>arc.fund / applicant workspace</span>
        <span>Clarity for what comes next.</span>
      </div>
    </aside>
    <section className="auth-content" aria-label={is404 ? 'Page not found' : 'Account preview'}>
      <div className="auth-topline">
        <span>{topLink.prefix}</span>
        <Link href={topLink.href} data-testid={topLink.testId}>{topLink.label}</Link>
      </div>
      {children}
      <footer className="auth-bottomline">
        <span>© arc.fund · Illustrative experience</span>
        {live ? <span>Applicant workspace</span> : <Link href="/" data-testid="link-demo-workspace-footer">View demo workspace <ArrowRight size={13} aria-hidden="true" /></Link>}
      </footer>
    </section>
  </main>;
}

function DemoFeedback({ children, testId, tone = 'info' }: { children: ReactNode; testId: string; tone?: 'info' | 'error' }) {
  return <div className={`auth-feedback ${tone === 'error' ? 'auth-feedback-error' : ''}`} role={tone === 'error' ? 'alert' : 'status'} data-testid={testId}>
    <Info size={16} aria-hidden="true" />
    <span>{children}</span>
  </div>;
}

export function LoginPage() {
  const session = useSession();
  const [, setLocation] = useLocation();
  const live = session.status !== 'unconfigured';
  const [showPassword, setShowPassword] = useState(false);
  const [feedback, setFeedback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });
  if (live && session.status === 'signedIn') return <Redirect to={nextPath()} replace />;
  const submit = async (values: z.infer<typeof loginSchema>) => {
    if (!live) { setFeedback(true); form.reset(); return; }
    setBusy(true); setError(null);
    const problem = await session.signIn(values.email, values.password);
    setBusy(false);
    form.setValue('password', '');
    if (problem) setError(problem); else setLocation(nextPath(), { replace: true });
  };

  return <AuthFrame mode="login" topLink={{ href: '/signup', prefix: 'New to arc.fund?', label: 'Create an account', testId: 'link-login-signup' }}>
    <div className="auth-form-wrap">
      <div className="auth-eyebrow">{live ? 'Applicant sign-in' : 'Applicant access / preview'}</div>
      <h1>Welcome back.</h1>
      <p className="auth-lede">{live ? 'Sign in to pick up your applications, balances, and next steps.' : 'Your next step is easier when everything is in one place. This sign-in form is a preview and is not connected to an account.'}</p>
      <Form {...form}>
        <form className="auth-form" noValidate onSubmit={form.handleSubmit(submit)} data-testid="form-login">
          <FormField control={form.control} name="email" render={({ field }) => <FormItem className="auth-field">
            <FormLabel className="auth-label">Email address</FormLabel>
            <FormControl><input {...field} type="email" className="auth-input" placeholder="you@organization.org" autoComplete="email" data-testid="input-login-email" /></FormControl>
            <FormMessage className="auth-error" data-testid="error-login-email" />
          </FormItem>} />
          <FormField control={form.control} name="password" render={({ field }) => <FormItem className="auth-field">
            <div className="auth-field-header">
              <FormLabel className="auth-label">Password</FormLabel>
              <Link href="/forgot-password" className="auth-inline-link" data-testid="link-login-forgot-password">Forgot password?</Link>
            </div>
            <div className="auth-password-wrap">
              <FormControl><input {...field} type={showPassword ? 'text' : 'password'} className="auth-input" placeholder="Enter your password" autoComplete="current-password" data-testid="input-login-password" /></FormControl>
              <button type="button" className="auth-show" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} data-testid="button-login-toggle-password">
                {showPassword ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
              </button>
            </div>
            <FormMessage className="auth-error" data-testid="error-login-password" />
          </FormItem>} />
          <button type="submit" className="auth-button" disabled={busy} data-testid="button-login-submit">{busy && <LoaderCircle size={18} className="auth-spin" aria-hidden="true" />}{live ? 'Sign in' : 'Preview sign in'} {!busy && <ArrowRight size={18} aria-hidden="true" />}</button>
        </form>
      </Form>
      {error && <DemoFeedback testId="status-login-error" tone="error">{error}</DemoFeedback>}
      {feedback && <DemoFeedback testId="status-login-demo">Sign-in preview only. No credentials were checked or saved, and no account session was started. You can explore the demo workspace below.</DemoFeedback>}
      {live ? <p className="auth-aside">New to arc.fund? <Link href="/signup" className="auth-inline-link" data-testid="link-login-signup-aside">Create an account</Link>.</p>
        : <p className="auth-aside">Just exploring? <Link href="/" className="auth-inline-link" data-testid="link-login-demo-workspace">Open the demo workspace</Link> without signing in.</p>}
    </div>
  </AuthFrame>;
}

export function SignUpPage() {
  const session = useSession();
  const live = session.status !== 'unconfigured';
  // Held only in memory between steps 1 and 2, then cleared once the account request is sent.
  const password = useRef('');
  const [creating, setCreating] = useState(false);
  const [signupError, setSignupError] = useState<string | null>(null);
  const [resend, setResend] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [resendWait, setResendWait] = useState(0);
  const [, setLocation] = useLocation();
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [step, setStep] = useState(1);
  const [animationStarted, setAnimationStarted] = useState(false);
  const [code, setCode] = useState('');
  const [policy, setPolicy] = useState<'terms' | 'privacy' | null>(null);
  const policyDialog = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(1);
  const [suggestedCountry] = useState(localeCountrySuggestion);
  const form = useForm<z.infer<typeof signupSchema>>({
    resolver: zodResolver(signupSchema),
    defaultValues: { name: '', email: '', password: '', confirmPassword: '' },
  });
  const detailsForm = useForm<z.infer<typeof detailsSchema>>({
    resolver: zodResolver(detailsSchema),
    defaultValues: { phone: '', country: suggestedCountry, sector: '', birthDate: '', acknowledgement: false },
  });

  useEffect(() => {
    if (policy) policyDialog.current?.showModal();
  }, [policy]);

  useEffect(() => {
    if (previousStep.current !== step) headingRef.current?.focus();
    previousStep.current = step;
  }, [step]);

  useEffect(() => {
    void import('./GrantMatchingAnimation');
  }, []);

  useEffect(() => {
    if (step !== 4 || !animationStarted) return;
    const timeout = window.setTimeout(() => setLocation('/dashboard', { replace: true }), 4000);
    return () => window.clearTimeout(timeout);
  }, [step, animationStarted, setLocation]);

  useEffect(() => {
    if (resendWait <= 0) return;
    const timer = window.setTimeout(() => setResendWait(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendWait]);

  const createAccount = async () => {
    const details = detailsForm.getValues();
    setCreating(true); setSignupError(null);
    const result = await session.signUp(form.getValues('email'), password.current, { fullName: form.getValues('name').trim(), phone: details.phone.trim(), country: details.country.trim(), sector: details.sector, birthDate: details.birthDate });
    password.current = '';
    setCreating(false);
    if (result.error) { setSignupError(`${result.error} Go back to step 1 to change your email or password.`); return; }
    setStep(result.signedIn ? 4 : 3);
  };
  const resendEmail = async () => {
    const problem = await session.resendConfirmation(form.getValues('email'));
    setResend(problem ? { tone: 'error', text: problem } : { tone: 'info', text: 'Sent again. It can take a few minutes; check your spam folder too.' });
    setResendWait(30);
  };

  const next = async () => {
    if (step === 1) {
      if (await form.trigger()) {
        password.current = form.getValues('password');
        form.setValue('password', '');
        form.setValue('confirmPassword', '');
        setShowPassword(false);
        setShowConfirm(false);
        setStep(2);
      }
    } else if (step === 2) {
      if (await detailsForm.trigger()) {
        if (live) await createAccount(); else setStep(3);
      }
    } else if (step === 3 && !live) {
      setCode('');
      setStep(4);
    }
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!event.altKey || policy || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowLeft' && step > 1 && step < (live ? 3 : 4)) {
        event.preventDefault();
        setStep(value => value - 1);
      }
      if (event.key === 'ArrowRight' && step < (live ? 3 : 4)) {
        event.preventDefault();
        void next();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  if (live && session.status === 'signedIn' && step === 1) return <Redirect to="/" replace />;
  return <AuthFrame mode="signup" topLink={{ href: '/login', prefix: 'Already have an account?', label: 'Sign in', testId: 'link-signup-login' }}>
    <div className="auth-form-wrap auth-signup-wrap">
      <div className="auth-progress" role="progressbar" aria-label="Sign-up preview progress" aria-valuemin={1} aria-valuemax={4} aria-valuenow={step} aria-valuetext={`Step ${step} of 4`} data-testid="status-signup-progress">
        <div className="auth-progress-top"><span>{live ? 'Create your account' : 'Account preview'}</span><span>0{step} / 04</span></div>
        <div className="auth-progress-track" aria-hidden="true">{[1, 2, 3, 4].map(number => <span key={number} className={number <= step ? 'active' : ''} />)}</div>
      </div>
      {step === 1 && <section className="auth-step-pane" aria-labelledby="signup-heading">
        <div className="auth-step-index">01 — Your account</div>
        <h1 id="signup-heading" ref={headingRef} tabIndex={-1}>Start with clarity.</h1>
        <p className="auth-lede">{live ? 'Begin with the essentials. You\'ll confirm your email before your account opens.' : 'Begin with the essentials. This is a preview: no account will be created and nothing is saved.'}</p>
        <Form {...form}>
        <form className="auth-form" noValidate onSubmit={event => { event.preventDefault(); void next(); }} data-testid="form-signup">
          <FormField control={form.control} name="name" render={({ field }) => <FormItem className="auth-field">
            <FormLabel className="auth-label">Full name</FormLabel>
            <FormControl><input {...field} className="auth-input" placeholder="Your name" autoComplete="name" data-testid="input-signup-name" /></FormControl>
            <FormMessage className="auth-error" data-testid="error-signup-name" />
          </FormItem>} />
          <FormField control={form.control} name="email" render={({ field }) => <FormItem className="auth-field">
            <FormLabel className="auth-label">Email address</FormLabel>
            <FormControl><input {...field} type="email" className="auth-input" placeholder="you@organization.org" autoComplete="email" data-testid="input-signup-email" /></FormControl>
            <FormMessage className="auth-error" data-testid="error-signup-email" />
          </FormItem>} />
          <FormField control={form.control} name="password" render={({ field }) => <FormItem className="auth-field">
            <FormLabel className="auth-label">Password</FormLabel>
            <div className="auth-password-wrap">
              <FormControl><input {...field} type={showPassword ? 'text' : 'password'} className="auth-input" placeholder="At least 8 characters" autoComplete="new-password" data-testid="input-signup-password" /></FormControl>
              <button type="button" className="auth-show" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} data-testid="button-signup-toggle-password">
                {showPassword ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
              </button>
            </div>
            <FormMessage className="auth-error" data-testid="error-signup-password" />
          </FormItem>} />
          <FormField control={form.control} name="confirmPassword" render={({ field }) => <FormItem className="auth-field">
            <FormLabel className="auth-label">Confirm password</FormLabel>
            <div className="auth-password-wrap">
              <FormControl><input {...field} type={showConfirm ? 'text' : 'password'} className="auth-input" placeholder="Re-enter your password" autoComplete="new-password" data-testid="input-signup-confirm-password" /></FormControl>
              <button type="button" className="auth-show" onClick={() => setShowConfirm(value => !value)} aria-label={showConfirm ? 'Hide confirmation password' : 'Show confirmation password'} aria-pressed={showConfirm} data-testid="button-signup-toggle-confirm-password">
                {showConfirm ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
              </button>
            </div>
            <FormMessage className="auth-error" data-testid="error-signup-confirm-password" />
          </FormItem>} />
          <button type="submit" className="auth-button" data-testid="button-signup-submit">Next: Your details <ArrowRight size={18} aria-hidden="true" /></button>
        </form>
        </Form>
      </section>}
      {step === 2 && <section className="auth-step-pane" aria-labelledby="signup-heading">
        <div className="auth-step-index">02 — About you</div>
        <h1 id="signup-heading" ref={headingRef} tabIndex={-1}>A little context.</h1>
        <p className="auth-lede">{live ? 'These details are saved with your account to shape your application profile.' : 'These details would help shape an application profile. They stay in this page only.'}</p>
        <Form {...detailsForm}>
          <form className="auth-form" noValidate onSubmit={event => { event.preventDefault(); void next(); }} data-testid="form-signup-details">
            <FormField control={detailsForm.control} name="phone" render={({ field }) => <FormItem className="auth-field">
              <FormLabel className="auth-label">Phone number</FormLabel>
              <FormControl><input {...field} type="tel" className="auth-input" placeholder="+1 (555) 000-0000" autoComplete="tel" data-testid="input-signup-phone" /></FormControl>
              <FormMessage className="auth-error" data-testid="error-signup-phone" />
            </FormItem>} />
            <FormField control={detailsForm.control} name="country" render={({ field }) => <FormItem className="auth-field">
              <FormLabel className="auth-label">Country</FormLabel>
              <FormControl><input {...field} className="auth-input" placeholder="Enter your country" autoComplete="country-name" data-testid="input-signup-country" /></FormControl>
              <p className="auth-help" data-testid="status-signup-country-suggestion">{suggestedCountry ? 'Approximate suggestion from your browser language setting, not your location. Please edit if needed.' : 'Enter your country. We do not request your location.'}</p>
              <FormMessage className="auth-error" data-testid="error-signup-country" />
            </FormItem>} />
            <FormField control={detailsForm.control} name="sector" render={({ field }) => <FormItem className="auth-field">
              <FormLabel className="auth-label">Industry or sector</FormLabel>
              <FormControl><select {...field} className="auth-input" data-testid="select-signup-sector">
                <option value="">Select an example</option>
                <option value="healthcare">Healthcare</option>
                <option value="military-veteran">Military / Veteran</option>
                <option value="student-education">Student / Education</option>
                <option value="government-public-service">Government / Public Service</option>
                <option value="creative">Arts / Creative</option>
                <option value="other">Other</option>
              </select></FormControl>
              <p className="auth-help" data-testid="status-signup-sector-example">Illustrative examples only. Actual options will be supplied by admin settings later.</p>
              <FormMessage className="auth-error" data-testid="error-signup-sector" />
            </FormItem>} />
            <FormField control={detailsForm.control} name="birthDate" render={({ field }) => <FormItem className="auth-field">
              <FormLabel className="auth-label">Date of birth</FormLabel>
              <FormControl><input {...field} type="date" className="auth-input" autoComplete="bday" data-testid="input-signup-birth-date" /></FormControl>
              <FormMessage className="auth-error" data-testid="error-signup-birth-date" />
            </FormItem>} />
            <div className="auth-signup-note" data-testid="status-signup-policies"><Info size={16} aria-hidden="true" /><span><strong>Policy preview only.</strong> Actual terms and privacy documents are not configured until admin settings. This is not a legal agreement and no consent is recorded.</span></div>
            <FormField control={detailsForm.control} name="acknowledgement" render={({ field }) => <FormItem className="auth-field">
              <div className="auth-ack">
                <FormControl><input id="signup-acknowledgement" type="checkbox" checked={field.value} onChange={event => field.onChange(event.target.checked)} onBlur={field.onBlur} name={field.name} ref={field.ref} data-testid="checkbox-signup-acknowledgement" /></FormControl>
                <span><label htmlFor="signup-acknowledgement">I acknowledge</label> the <button type="button" className="auth-text-button" onClick={() => setPolicy('terms')} data-testid="button-preview-terms">terms &amp; conditions preview</button> and <button type="button" className="auth-text-button" onClick={() => setPolicy('privacy')} data-testid="button-preview-privacy">privacy policy preview</button> are not configured. This does not record legal consent.</span>
              </div>
              <FormMessage className="auth-error" data-testid="error-signup-acknowledgement" />
            </FormItem>} />
            <div className="auth-step-actions">
              <button type="button" className="auth-back" onClick={() => setStep(1)} data-testid="button-signup-back-details"><ArrowLeft size={16} aria-hidden="true" /> Back</button>
              <button type="submit" className="auth-button" disabled={creating} data-testid="button-signup-next-details">{creating && <LoaderCircle size={18} className="auth-spin" aria-hidden="true" />}{live ? 'Create account' : 'Next: Email preview'} {!creating && <ArrowRight size={18} aria-hidden="true" />}</button>
            </div>
            {signupError && <DemoFeedback testId="status-signup-error" tone="error">{signupError}</DemoFeedback>}
          </form>
        </Form>
      </section>}
      {step === 3 && live && <section className="auth-step-pane" aria-labelledby="signup-heading" data-testid="section-signup-check-email">
        <div className="auth-step-index">03 — Confirm your email</div>
        <h1 id="signup-heading" ref={headingRef} tabIndex={-1}>Check your email.</h1>
        <p className="auth-lede">We sent a confirmation link to <strong>{form.getValues('email')}</strong>. Open it on this device to activate your account; it signs you in and takes you to your workspace.</p>
        <div className="auth-signup-note" role="status"><MailCheck size={16} aria-hidden="true" /><span>The link expires after 24 hours. If the address already has an account, you'll get a sign-in reminder instead.</span></div>
        <div className="auth-step-actions">
          <Link href="/login" className="auth-back" data-testid="link-signup-to-login"><ArrowLeft size={16} aria-hidden="true" /> Go to sign in</Link>
          <button type="button" className="auth-button" disabled={resendWait > 0} onClick={() => void resendEmail()} data-testid="button-signup-resend">{resendWait > 0 ? `Resend in ${resendWait}s` : 'Resend email'}</button>
        </div>
        {resend && <DemoFeedback testId="status-signup-resend" tone={resend.tone}>{resend.text}</DemoFeedback>}
      </section>}
      {step === 3 && !live && <section className="auth-step-pane" aria-labelledby="signup-heading">
        <div className="auth-step-index">03 — Email preview</div>
        <h1 id="signup-heading" ref={headingRef} tabIndex={-1}>Check your email.</h1>
        <p className="auth-lede">In a live sign-up, we would send a confirmation code to <strong>{form.getValues('email')}</strong>. You would enter it here.</p>
        <div className="auth-signup-note" role="status" data-testid="status-signup-no-email"><Info size={16} aria-hidden="true" /><span><strong>No email was sent.</strong> There is no account or code to verify in this preview.</span></div>
        <div className="auth-field" style={{ marginTop: 23 }}>
          <label className="auth-label" htmlFor="signup-code">Six-digit code (visual preview only)</label>
          <input id="signup-code" className="auth-input auth-code-input" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="······" aria-describedby="signup-code-help" data-testid="input-signup-code" />
          <p id="signup-code-help" className="auth-help">Entering a code does not verify anything. You can continue without one.</p>
        </div>
        <div className="auth-step-actions">
          <button type="button" className="auth-back" onClick={() => setStep(2)} data-testid="button-signup-back-email"><ArrowLeft size={16} aria-hidden="true" /> Back</button>
          <button type="button" className="auth-button" onClick={() => { setCode(''); setStep(4); }} data-testid="button-signup-preview-next-step">Preview next step <ArrowRight size={18} aria-hidden="true" /></button>
        </div>
      </section>}
      {step === 4 && <section className="auth-step-pane" aria-labelledby="signup-heading">
        <div className="auth-step-index">04 — Your workspace</div>
        <h1 id="signup-heading" ref={headingRef} tabIndex={-1}>Connecting you to the best grant.</h1>
        <div className="auth-match-art" data-testid="animation-signup-matching">
          <span className="sr-only">Illustration of an applicant discovering funding opportunities.</span>
          <Suspense fallback={<span className="auth-match-loading">Loading illustration…</span>}><GrantMatchingAnimation onPlay={() => setAnimationStarted(true)} /></Suspense>
        </div>
      </section>}
      {step !== 4 && !live && <p className="auth-aside">Prefer to look around first? <Link href="/" className="auth-inline-link" data-testid="link-signup-demo-workspace">Enter the demo workspace</Link>.</p>}
    </div>
    <dialog ref={policyDialog} className="auth-policy-panel" onClose={() => setPolicy(null)} aria-labelledby="signup-policy-heading" data-testid="dialog-signup-policy">
      <div className="auth-step-index">Document preview</div>
      <h2 id="signup-policy-heading">{policy === 'terms' ? 'Terms & conditions' : 'Privacy policy'}</h2>
      <p>Actual {policy === 'terms' ? 'terms and conditions' : 'privacy policy'} documents are not configured. Admin settings will provide the real document later. This panel contains no policy text; viewing or acknowledging it does not create an account, save consent, or form a legal agreement.</p>
      <button type="button" className="auth-button" onClick={() => policyDialog.current?.close()} data-testid="button-close-signup-policy">Close preview <ArrowRight size={17} aria-hidden="true" /></button>
    </dialog>
  </AuthFrame>;
}

export function ForgotPasswordPage() {
  const session = useSession();
  const live = session.status !== 'unconfigured';
  const [feedback, setFeedback] = useState(false);
  const [result, setResult] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm<z.infer<typeof resetSchema>>({
    resolver: zodResolver(resetSchema),
    defaultValues: { email: '' },
  });
  const submit = async ({ email }: z.infer<typeof resetSchema>) => {
    if (!live) { setFeedback(true); form.reset(); return; }
    setBusy(true);
    const problem = await session.sendReset(email, '/reset-password');
    setBusy(false);
    // Same answer whether or not the address has an account.
    setResult(problem ? { tone: 'error', text: problem } : { tone: 'info', text: `If ${email.trim()} has an account, a reset link is on its way. It expires after an hour.` });
  };

  return <AuthFrame mode="reset" topLink={{ href: '/login', prefix: 'Remembered it?', label: 'Back to sign in', testId: 'link-reset-login-top' }}>
    <div className="auth-form-wrap">
      <div className="auth-eyebrow">{live ? 'Account recovery' : 'Account recovery / preview'}</div>
      <h1>Find your way back.</h1>
      <p className="auth-lede">{live ? "Enter your account email and we'll send a link to choose a new password." : 'Enter an email address to preview the reset request. This demonstration cannot send a recovery email.'}</p>
      <Form {...form}>
        <form className="auth-form" noValidate onSubmit={form.handleSubmit(submit)} data-testid="form-reset-password">
          <FormField control={form.control} name="email" render={({ field }) => <FormItem className="auth-field">
            <FormLabel className="auth-label">Email address</FormLabel>
            <FormControl><input {...field} type="email" className="auth-input" placeholder="you@organization.org" autoComplete="email" data-testid="input-reset-email" /></FormControl>
            <FormMessage className="auth-error" data-testid="error-reset-email" />
          </FormItem>} />
          <button type="submit" className="auth-button" disabled={busy} data-testid="button-reset-submit">{live ? 'Send reset link' : 'Preview reset request'} <ArrowRight size={18} aria-hidden="true" /></button>
        </form>
      </Form>
      {result && <DemoFeedback testId="status-reset-result" tone={result.tone}>{result.text}</DemoFeedback>}
      {feedback && <DemoFeedback testId="status-reset-demo">Reset-request preview only. No email was sent and the address was not saved. Password recovery is not connected in this demo.</DemoFeedback>}
      <p className="auth-aside"><Link href="/login" className="auth-inline-link" data-testid="link-reset-login"><ArrowLeft size={13} aria-hidden="true" /> Return to sign in</Link></p>
    </div>
  </AuthFrame>;
}

/** /reset-password: opened from the emailed link, which signs the person in for this one purpose. */
export function ResetPasswordPage() {
  const session = useSession();
  const [, setLocation] = useLocation();
  const [result, setResult] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm<z.infer<typeof newPasswordSchema>>({ resolver: zodResolver(newPasswordSchema), defaultValues: { password: '', confirmPassword: '' } });
  const ready = session.status === 'signedIn' || session.recovery;
  const submit = async ({ password }: z.infer<typeof newPasswordSchema>) => {
    setBusy(true);
    const problem = await session.setNewPassword(password);
    setBusy(false);
    form.reset();
    if (problem) { setResult({ tone: 'error', text: problem }); return; }
    setResult({ tone: 'info', text: 'Password updated. Taking you to your workspace…' });
    window.setTimeout(() => setLocation('/', { replace: true }), 1200);
  };
  const passwordField = (name: 'password' | 'confirmPassword', label: string) => <FormField control={form.control} name={name} render={({ field }) => <FormItem className="auth-field">
    <FormLabel className="auth-label">{label}</FormLabel>
    <FormControl><input {...field} type="password" className="auth-input" autoComplete="new-password" data-testid={`input-new-${name === 'password' ? 'password' : 'confirm-password'}`} /></FormControl>
    <FormMessage className="auth-error" />
  </FormItem>} />;

  return <AuthFrame mode="reset" topLink={{ href: '/login', prefix: 'Remembered it?', label: 'Back to sign in', testId: 'link-new-password-login-top' }}>
    <div className="auth-form-wrap">
      <div className="auth-eyebrow">Account recovery</div>
      <h1>Choose a new password.</h1>
      {session.status === 'unconfigured' ? <DemoFeedback testId="status-new-password-unconfigured">Accounts aren't set up on this site yet, so there's no password to reset.</DemoFeedback>
        : session.status === 'loading' ? <p className="auth-lede">Checking your reset link…</p>
        : !ready ? <><DemoFeedback testId="status-new-password-invalid" tone="error">This reset link is invalid or has expired. Request a new one.</DemoFeedback><p className="auth-aside"><Link href="/forgot-password" className="auth-inline-link">Send a new link</Link></p></>
        : <Form {...form}><form className="auth-form" noValidate onSubmit={form.handleSubmit(submit)} data-testid="form-new-password">
          {passwordField('password', 'New password')}
          {passwordField('confirmPassword', 'Confirm new password')}
          <button type="submit" className="auth-button" disabled={busy} data-testid="button-new-password-submit">Save new password <ArrowRight size={18} aria-hidden="true" /></button>
        </form></Form>}
      {result && <DemoFeedback testId="status-new-password" tone={result.tone}>{result.text}</DemoFeedback>}
    </div>
  </AuthFrame>;
}

export function NotFoundPage() {
  return <AuthFrame mode="not-found" topLink={{ href: '/', prefix: 'Looking for your applications?', label: 'Open demo workspace', testId: 'link-notfound-workspace-top' }}>
    <div className="auth-form-wrap">
      <div className="auth-eyebrow">Page not found / 404</div>
      <h1>This path ends here.</h1>
      <p className="auth-lede">The page may have moved, or the address might need another look. Your demo workspace is still right where you left it.</p>
      <div className="auth-route-code" data-testid="text-notfound-code"><span>REQUESTED PAGE</span><strong>NOT FOUND / 404</strong></div>
      <Link href="/" className="auth-button" data-testid="link-notfound-dashboard">Back to demo dashboard <ArrowRight size={18} aria-hidden="true" /></Link>
      <p className="auth-aside">Need another starting point? <Link href="/login" className="auth-inline-link" data-testid="link-notfound-login">View sign-in preview</Link>.</p>
    </div>
  </AuthFrame>;
}