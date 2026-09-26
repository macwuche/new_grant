import { useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { useSession } from '@/lib/session';

// Two-step sign-in with an authenticator app (Supabase TOTP). Used on the
// sign-in gates (auth page styling) and in applicant Settings (app styling).

type Ui = 'auth' | 'app';
const cls = (ui: Ui) => ui === 'auth'
  ? { form: 'auth-form', field: 'auth-field', label: 'auth-label', input: 'auth-input', button: 'auth-button', ghost: 'auth-inline-link auth-link-button', error: 'auth-error', hint: 'auth-lede' }
  : { form: 'stack', field: 'field', label: 'field-label', input: 'input', button: 'btn btn-primary', ghost: 'btn btn-ghost', error: 'field-error', hint: 'field-hint' };

const SIX_DIGITS = /^\d{6}$/;

function CodeField({ ui, id, code, setCode, error }: { ui: Ui; id: string; code: string; setCode: (v: string) => void; error: string | null }) {
  const c = cls(ui);
  return <div className={c.field}>
    <label className={c.label} htmlFor={id}>6-digit code from your authenticator app</label>
    <input id={id} className={c.input} value={code} onChange={e => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} data-testid="input-two-step-code" />
    {error && <p className={c.error} id={`${id}-error`} role="alert">{error}</p>}
  </div>;
}

/** Asks for a code from the account's authenticator app, upgrading this session to two-step. */
export function TwoStepCodeForm({ ui = 'auth', onVerified }: { ui?: Ui; onVerified?: () => void }) {
  const session = useSession();
  const c = cls(ui);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!SIX_DIGITS.test(code)) { setError('Enter the 6 digits shown in your authenticator app.'); return; }
    setBusy(true);
    const failure = await session.verifyTwoStep(code);
    setBusy(false);
    if (failure) { setError(failure); setCode(''); return; }
    onVerified?.();
  };
  return <form className={c.form} noValidate onSubmit={submit} data-testid="form-two-step-code">
    <CodeField ui={ui} id="two-step-code" code={code} setCode={v => { setCode(v); setError(null); }} error={error} />
    <button type="submit" className={c.button} disabled={busy} data-testid="button-two-step-verify">{busy ? <LoaderCircle size={18} className="auth-spin" aria-hidden="true" /> : null}Continue {!busy && <ArrowRight size={16} aria-hidden="true" />}</button>
  </form>;
}

/** Adds an authenticator app: scan the QR code (or type the key), then confirm with a code. */
export function TwoStepSetupForm({ ui = 'auth', onDone, onCancel }: { ui?: Ui; onDone?: () => void; onCancel?: () => void }) {
  const session = useSession();
  const c = cls(ui);
  const [setup, setSetup] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true); setError(null);
    const result = await session.startTwoStepSetup();
    setBusy(false);
    if ('error' in result) setError(result.error); else setSetup(result);
  };
  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (!setup) return;
    if (!SIX_DIGITS.test(code)) { setError('Enter the 6 digits shown in your authenticator app.'); return; }
    setBusy(true);
    const failure = await session.verifyTwoStep(code, setup.factorId);
    setBusy(false);
    if (failure) { setError(failure); setCode(''); return; }
    onDone?.();
  };
  if (!setup) return <div className={c.form}>
    <p className={c.hint}>You'll need an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator, 1Password, or Authy.</p>
    {error && <p className={c.error} role="alert">{error}</p>}
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      <button type="button" className={c.button} onClick={() => void start()} disabled={busy} data-testid="button-two-step-start">{busy ? 'Starting…' : 'Set up authenticator app'}</button>
      {onCancel && <button type="button" className={c.ghost} onClick={onCancel}>Cancel</button>}
    </div>
  </div>;
  return <form className={c.form} noValidate onSubmit={confirm} data-testid="form-two-step-setup">
    <p className={c.hint}>Scan this code with your authenticator app, then enter the 6-digit code it shows.</p>
    <img src={setup.qr} alt="QR code to add arc.fund to your authenticator app" width={180} height={180} style={{ background: '#fff', borderRadius: 8, padding: 6 }} data-testid="img-two-step-qr" />
    <p className={c.hint}>Can't scan it? Enter this key instead: <code style={{ wordBreak: 'break-all' }} data-testid="text-two-step-secret">{setup.secret}</code></p>
    <CodeField ui={ui} id="two-step-setup-code" code={code} setCode={v => { setCode(v); setError(null); }} error={error} />
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      <button type="submit" className={c.button} disabled={busy} data-testid="button-two-step-confirm">{busy ? 'Checking…' : 'Turn on two-step sign-in'}</button>
      {onCancel && <button type="button" className={c.ghost} onClick={onCancel}>Cancel</button>}
    </div>
  </form>;
}
