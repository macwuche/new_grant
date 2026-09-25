import { useState, type ReactNode } from 'react';
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
const resetSchema = z.object({ email: emailRule });

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
  const [feedback, setFeedback] = useState(false);
  const form = useForm<z.infer<typeof signupSchema>>({
    resolver: zodResolver(signupSchema),
    defaultValues: { name: '', email: '', password: '', confirmPassword: '' },
  });

  return <AuthFrame mode="signup" topLink={{ href: '/login', prefix: 'Already have an account?', label: 'Sign in', testId: 'link-signup-login' }}>
    <div className="auth-form-wrap">
      <div className="auth-eyebrow">Your space / preview</div>
      <h1>Start with clarity.</h1>
      <p className="auth-lede">A place to see your funding journey clearly. Account creation is not available in this preview.</p>
      <Form {...form}>
        <form className="auth-form" noValidate onSubmit={form.handleSubmit(() => { setFeedback(true); form.reset(); })} data-testid="form-signup">
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
          <button type="submit" className="auth-button" data-testid="button-signup-submit">Preview registration <ArrowRight size={18} aria-hidden="true" /></button>
        </form>
      </Form>
      {feedback && <DemoFeedback testId="status-signup-demo">Registration preview only. No account was created and no details or credentials were saved. Explore the demo workspace instead.</DemoFeedback>}
      <p className="auth-aside">Prefer to look around first? <Link href="/" className="auth-inline-link" data-testid="link-signup-demo-workspace">Enter the demo workspace</Link>.</p>
    </div>
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