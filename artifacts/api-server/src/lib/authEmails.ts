import { renderEmail } from "./email";

// Supabase Auth's own emails (sign-up confirmation, password reset, invites,
// email change, sign-in links, reauthentication codes), sent through Resend's
// SMTP relay and worded like the app's other mail. Pushed to the Supabase
// project through the Management API from Settings → Email. The {{ .X }}
// placeholders are Supabase's Go template variables, filled in by Supabase.

export const RESEND_SMTP = { host: "smtp.resend.com", port: "465", user: "resend" } as const;

const footer = "You're receiving this because of an arc.fund account request. If it wasn't you, you can ignore this email.";

const templates = {
  confirmation: {
    subject: "Confirm your arc.fund email",
    ...renderEmail({ greeting: "Welcome to arc.fund.", paragraphs: ["Confirm this email address to finish creating your account."], action: { label: "Confirm email", href: "{{ .ConfirmationURL }}" }, footer }),
  },
  recovery: {
    subject: "Reset your arc.fund password",
    ...renderEmail({ greeting: "Hello,", paragraphs: ["Someone asked to reset the password for this arc.fund account. The link works once and expires soon."], action: { label: "Choose a new password", href: "{{ .ConfirmationURL }}" }, footer }),
  },
  invite: {
    subject: "You've been invited to arc.fund",
    ...renderEmail({ greeting: "Hello,", paragraphs: ["You've been invited to create an arc.fund account."], action: { label: "Accept the invitation", href: "{{ .ConfirmationURL }}" }, footer }),
  },
  magic_link: {
    subject: "Your arc.fund sign-in link",
    ...renderEmail({ greeting: "Hello,", paragraphs: ["Use this link to sign in to arc.fund. It works once and expires soon."], action: { label: "Sign in", href: "{{ .ConfirmationURL }}" }, footer }),
  },
  email_change: {
    subject: "Confirm your new arc.fund email",
    ...renderEmail({ greeting: "Hello,", paragraphs: ["Confirm that you want to change your arc.fund email from {{ .Email }} to {{ .NewEmail }}."], action: { label: "Confirm the change", href: "{{ .ConfirmationURL }}" }, footer }),
  },
  reauthentication: {
    subject: "Your arc.fund verification code",
    ...renderEmail({ greeting: "Hello,", paragraphs: ["Enter this code to confirm it's you: {{ .Token }}", "It expires soon. Never share it with anyone, including arc.fund staff."], footer }),
  },
} as const;

/** The Management API fields that set every Supabase Auth email's subject and HTML body. */
export function authEmailTemplateConfig(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [kind, t] of Object.entries(templates)) {
    out[`mailer_subjects_${kind}`] = t.subject;
    out[`mailer_templates_${kind}_content`] = t.html;
  }
  return out;
}

/** Whether the project's sign-up confirmation email currently uses these templates. */
export const usesAppTemplates = (config: Record<string, unknown>) => config["mailer_subjects_confirmation"] === templates.confirmation.subject;
