import { appName, renderEmail } from "./email";

// Supabase Auth's own emails (sign-up confirmation, password reset, invites,
// email change, sign-in links, reauthentication codes), worded like the app's
// other mail under the application name saved in the admin.
//
// Two ways to deliver them:
// - Supabase's Send Email Hook (preferred): Supabase calls POST
//   /api/auth/email-hook for every auth email and this server renders and sends
//   it through Resend (routes/authEmailHook.ts, `hookEmails` below).
// - Supabase's own mailer through Resend's SMTP relay, with these templates
//   pushed through the Management API from Settings → Email (they must be
//   pushed again after the name changes). There the values are Supabase's Go
//   template placeholders ({{ .X }}).

export const RESEND_SMTP = { host: "smtp.resend.com", port: "465", user: "resend" } as const;

/** What each email is filled in with: real values for the hook, Supabase's placeholders for pushed templates. */
type Values = { link: string; token: string; email: string; newEmail: string };
const PLACEHOLDERS: Values = { link: "{{ .ConfirmationURL }}", token: "{{ .Token }}", email: "{{ .Email }}", newEmail: "{{ .NewEmail }}" };

function templates(name: string, v: Values = PLACEHOLDERS) {
  const footer = `You're receiving this because of an account request at ${name}. If it wasn't you, you can ignore this email.`;
  return {
    confirmation: {
      subject: `Confirm your ${name} email`,
      ...renderEmail({ greeting: `Welcome to ${name}.`, paragraphs: ["Confirm this email address to finish creating your account."], action: { label: "Confirm email", href: v.link }, footer }),
    },
    recovery: {
      subject: `Reset your ${name} password`,
      ...renderEmail({ greeting: "Hello,", paragraphs: [`Someone asked to reset the password for this ${name} account. The link works once and expires soon.`], action: { label: "Choose a new password", href: v.link }, footer }),
    },
    invite: {
      subject: `You've been invited to ${name}`,
      ...renderEmail({ greeting: "Hello,", paragraphs: [`You've been invited to create a ${name} account.`], action: { label: "Accept the invitation", href: v.link }, footer }),
    },
    magic_link: {
      subject: `Your ${name} sign-in link`,
      ...renderEmail({ greeting: "Hello,", paragraphs: [`Use this link to sign in to ${name}. It works once and expires soon.`], action: { label: "Sign in", href: v.link }, footer }),
    },
    email_change: {
      subject: `Confirm your new ${name} email`,
      ...renderEmail({ greeting: "Hello,", paragraphs: [`Confirm that you want to change your ${name} email from ${v.email} to ${v.newEmail}.`], action: { label: "Confirm the change", href: v.link }, footer }),
    },
    reauthentication: {
      subject: `Your ${name} verification code`,
      ...renderEmail({ greeting: "Hello,", paragraphs: [`Enter this code to confirm it's you: ${v.token}`, `It expires soon. Never share it with anyone, including ${name} staff.`], footer }),
    },
  };
}

/** The Management API fields that set every Supabase Auth email's subject and HTML body, under the current app name. */
export function authEmailTemplateConfig(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [kind, t] of Object.entries(templates(appName()))) {
    out[`mailer_subjects_${kind}`] = t.subject;
    out[`mailer_templates_${kind}_content`] = t.html;
  }
  return out;
}

/** Whether the project's sign-up confirmation email uses these templates under the current app name. */
export const usesAppTemplates = (config: Record<string, unknown>) => config["mailer_subjects_confirmation"] === templates(appName()).confirmation.subject;

// ---------- Send Email Hook ----------

/** The parts of Supabase's Send Email Hook payload this server uses. */
export type SendEmailHook = {
  user?: { email?: string | null; new_email?: string | null };
  email_data?: {
    token?: string; token_hash?: string; token_new?: string; token_hash_new?: string;
    redirect_to?: string; site_url?: string; email_action_type?: string; old_email?: string | null;
  };
};
export type AuthEmail = { to: string; subject: string; text: string; html: string };

/** Security notices Supabase can ask for (each only when switched on in the Supabase dashboard). */
const NOTICES: Record<string, (name: string) => { subject: string; paragraph: string }> = {
  password_changed_notification: name => ({ subject: `Your ${name} password was changed`, paragraph: `The password for your ${name} account was just changed.` }),
  email_changed_notification: name => ({ subject: `Your ${name} email address was changed`, paragraph: `The email address for your ${name} account was just changed.` }),
  phone_changed_notification: name => ({ subject: `Your ${name} phone number was changed`, paragraph: `The phone number for your ${name} account was just changed.` }),
  identity_linked_notification: name => ({ subject: `A sign-in method was added to your ${name} account`, paragraph: `A new sign-in method was just linked to your ${name} account.` }),
  identity_unlinked_notification: name => ({ subject: `A sign-in method was removed from your ${name} account`, paragraph: `A sign-in method was just removed from your ${name} account.` }),
  mfa_factor_enrolled_notification: name => ({ subject: `Two-step sign-in was set up on your ${name} account`, paragraph: `An authenticator was just added to your ${name} account.` }),
  mfa_factor_unenrolled_notification: name => ({ subject: `Two-step sign-in was removed from your ${name} account`, paragraph: `An authenticator was just removed from your ${name} account.` }),
};

/** Which template each email_action_type uses. "email" is a sign-in link or code. */
const KINDS: Record<string, keyof ReturnType<typeof templates>> = {
  signup: "confirmation", invite: "invite", magiclink: "magic_link", email: "magic_link", recovery: "recovery", email_change: "email_change", reauthentication: "reauthentication",
};

/**
 * The emails to send for one Send Email Hook call: none for a type this server
 * doesn't know, two for a secure email change (one to each address).
 * Links go to Supabase's verify endpoint, which confirms the token and then
 * redirects to `redirect_to` (or the project's Site URL).
 */
export function hookEmails(payload: SendEmailHook, supabaseUrl: string): AuthEmail[] {
  const d = payload.email_data ?? {};
  const type = d.email_action_type ?? "";
  const email = payload.user?.email ?? "";
  const newEmail = payload.user?.new_email ?? "";
  const name = appName();
  const link = (hash: string | undefined) => hash
    ? `${supabaseUrl.replace(/\/+$/, "")}/auth/v1/verify?${new URLSearchParams({ token: hash, type, redirect_to: d.redirect_to || d.site_url || "" })}`
    : "";
  const render = (kind: keyof ReturnType<typeof templates>, to: string, v: Partial<Values>): AuthEmail => {
    const t = templates(name, { link: "", token: d.token ?? "", email, newEmail, ...v })[kind];
    return { to, subject: t.subject, text: t.text, html: t.html };
  };

  const notice = NOTICES[type];
  if (notice) {
    const n = notice(name);
    const to = type === "email_changed_notification" ? d.old_email || email : email;
    if (!to) return [];
    const { text, html } = renderEmail({ greeting: "Hello,", paragraphs: [n.paragraph, `If this wasn't you, reset your password straight away and contact the ${name} team.`], footer: `You're receiving this because of a change to your ${name} account.` });
    return [{ to, subject: n.subject, text, html }];
  }
  const kind = KINDS[type];
  if (!kind) return [];
  if (type === "email_change") {
    // Supabase's field names are reversed for backward compatibility: the current
    // address gets token_hash_new, the new address gets token_hash.
    if (d.token_hash && d.token_hash_new) {
      return [
        render(kind, email, { link: link(d.token_hash_new), token: d.token ?? "" }),
        render(kind, newEmail, { link: link(d.token_hash), token: d.token_new ?? "" }),
      ].filter(m => m.to);
    }
    const to = newEmail || email;
    return to ? [render(kind, to, { link: link(d.token_hash ?? d.token_hash_new), token: d.token ?? d.token_new ?? "" })] : [];
  }
  if (!email) return [];
  return [render(kind, email, { link: link(d.token_hash) })];
}
