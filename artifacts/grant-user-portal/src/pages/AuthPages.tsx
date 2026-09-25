import { useEffect, useRef, useState, type ReactNode } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, ArrowRight, Eye, EyeOff, Info } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Link } from 'wouter';
import { z } from 'zod';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import './AuthPages.css';

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
        <Link href="/" data-testid="link-demo-workspace-footer">View demo workspace <ArrowRight size={13} aria-hidden="true" /></Link>
      </footer>
    </section>
  </main>;
}

function DemoFeedback({ children, testId }: { children: ReactNode; testId: string }) {
  return <div className="auth-feedback" role="status" data-testid={testId}>
    <Info size={16} aria-hidden="true" />
    <span>{children}</span>
  </div>;
}

export function LoginPage() {
  const [showPassword, setShowPassword] = useState(false);
  const [feedback, setFeedback] = useState(false);
  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  return <AuthFrame mode="login" topLink={{ href: '/signup', prefix: 'New to arc.fund?', label: 'Create an account', testId: 'link-login-signup' }}>
    <div className="auth-form-wrap">
      <div className="auth-eyebrow">Applicant access / preview</div>
      <h1>Welcome back.</h1>
      <p className="auth-lede">Your next step is easier when everything is in one place. This sign-in form is a preview and is not connected to an account.</p>
      <Form {...form}>
        <form className="auth-form" noValidate onSubmit={form.handleSubmit(() => { setFeedback(true); form.reset(); })} data-testid="form-login">
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
          <button type="submit" className="auth-button" data-testid="button-login-submit">Preview sign in <ArrowRight size={18} aria-hidden="true" /></button>
        </form>
      </Form>
      {feedback && <DemoFeedback testId="status-login-demo">Sign-in preview only. No credentials were checked or saved, and no account session was started. You can explore the demo workspace below.</DemoFeedback>}
      <p className="auth-aside">Just exploring? <Link href="/" className="auth-inline-link" data-testid="link-login-demo-workspace">Open the demo workspace</Link> without signing in.</p>
    </div>
  </AuthFrame>;
}

export function SignUpPage() {
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [step, setStep] = useState(1);
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

  const next = async () => {
    if (step === 1) {
      if (await form.trigger()) {
        form.setValue('password', '');
        form.setValue('confirmPassword', '');
        setShowPassword(false);
        setShowConfirm(false);
        setStep(2);
      }
    } else if (step === 2) {
      if (await detailsForm.trigger()) setStep(3);
    } else if (step === 3) {
      setCode('');
      setStep(4);
    }
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!event.altKey || policy || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowLeft' && step > 1) {
        event.preventDefault();
        setStep(value => value - 1);
      }
      if (event.key === 'ArrowRight' && step < 4) {
        event.preventDefault();
        void next();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  const restart = () => {
    form.reset();
    detailsForm.reset({ phone: '', country: suggestedCountry, sector: '', birthDate: '', acknowledgement: false });
    setCode('');
    setStep(1);
  };

  return <AuthFrame mode="signup" topLink={{ href: '/login', prefix: 'Already have an account?', label: 'Sign in', testId: 'link-signup-login' }}>
    <div className="auth-form-wrap auth-signup-wrap">
      <div className="auth-progress" role="progressbar" aria-label="Sign-up preview progress" aria-valuemin={1} aria-valuemax={4} aria-valuenow={step} aria-valuetext={`Step ${step} of 4`} data-testid="status-signup-progress">
        <div className="auth-progress-top"><span>Account preview</span><span>0{step} / 04</span></div>
        <div className="auth-progress-track" aria-hidden="true">{[1, 2, 3, 4].map(number => <span key={number} className={number <= step ? 'active' : ''} />)}</div>
      </div>
      {step === 1 && <section className="auth-step-pane" aria-labelledby="signup-heading">
        <div className="auth-step-index">01 — Your account</div>
        <h1 id="signup-heading" ref={headingRef} tabIndex={-1}>Start with clarity.</h1>
        <p className="auth-lede">Begin with the essentials. This is a preview: no account will be created and nothing is saved.</p>
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
        <p className="auth-lede">These details would help shape an application profile. They stay in this page only.</p>
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
              <button type="submit" className="auth-button" data-testid="button-signup-next-details">Next: Email preview <ArrowRight size={18} aria-hidden="true" /></button>
            </div>
          </form>
        </Form>
      </section>}
      {step === 3 && <section className="auth-step-pane" aria-labelledby="signup-heading">
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
        <div className="auth-step-index">04 — Grant matching preview</div>
        <h1 id="signup-heading" ref={headingRef} tabIndex={-1}>Connecting you to the best grant.</h1>
        <p className="auth-lede">A preview of the grant-matching moment that will follow confirmation when the full experience is ready.</p>
        <div className="auth-match-art" aria-hidden="true"><i /><i /><span>Possibility, in motion.</span></div>
        <div className="auth-signup-note" role="status" data-testid="status-signup-matching-preview"><Info size={16} aria-hidden="true" /><span><strong>Animation placeholder.</strong> A Lottie asset will be provided later. No grant matching is happening, and no account or application was created.</span></div>
        <div className="auth-step-actions">
          <button type="button" className="auth-back" onClick={() => setStep(3)} data-testid="button-signup-back-matching"><ArrowLeft size={16} aria-hidden="true" /> Back</button>
          <button type="button" className="auth-button" onClick={restart} data-testid="button-signup-restart">Restart preview <ArrowRight size={18} aria-hidden="true" /></button>
        </div>
      </section>}
      <p className="auth-help" style={{ marginTop: 18 }} data-testid="status-signup-keyboard">Keyboard: use Alt + Left/Right Arrow to move between steps. Forward steps still validate entered details.</p>
      <p className="auth-aside">Prefer to look around first? <Link href="/" className="auth-inline-link" data-testid="link-signup-demo-workspace">Enter the demo workspace</Link>.</p>
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
  const [feedback, setFeedback] = useState(false);
  const form = useForm<z.infer<typeof resetSchema>>({
    resolver: zodResolver(resetSchema),
    defaultValues: { email: '' },
  });

  return <AuthFrame mode="reset" topLink={{ href: '/login', prefix: 'Remembered it?', label: 'Back to sign in', testId: 'link-reset-login-top' }}>
    <div className="auth-form-wrap">
      <div className="auth-eyebrow">Account recovery / preview</div>
      <h1>Find your way back.</h1>
      <p className="auth-lede">Enter an email address to preview the reset request. This demonstration cannot send a recovery email.</p>
      <Form {...form}>
        <form className="auth-form" noValidate onSubmit={form.handleSubmit(() => { setFeedback(true); form.reset(); })} data-testid="form-reset-password">
          <FormField control={form.control} name="email" render={({ field }) => <FormItem className="auth-field">
            <FormLabel className="auth-label">Email address</FormLabel>
            <FormControl><input {...field} type="email" className="auth-input" placeholder="you@organization.org" autoComplete="email" data-testid="input-reset-email" /></FormControl>
            <FormMessage className="auth-error" data-testid="error-reset-email" />
          </FormItem>} />
          <button type="submit" className="auth-button" data-testid="button-reset-submit">Preview reset request <ArrowRight size={18} aria-hidden="true" /></button>
        </form>
      </Form>
      {feedback && <DemoFeedback testId="status-reset-demo">Reset-request preview only. No email was sent and the address was not saved. Password recovery is not connected in this demo.</DemoFeedback>}
      <p className="auth-aside"><Link href="/login" className="auth-inline-link" data-testid="link-reset-login"><ArrowLeft size={13} aria-hidden="true" /> Return to sign in</Link></p>
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