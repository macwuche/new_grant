import { appName, renderEmail } from "./email";

// Supabase Auth's own emails (sign-up confirmation, password reset, invites,
// email change, sign-in links, reauthentication codes), sent through Resend's
// SMTP relay and worded like the app's other mail, under the application name
// saved in the admin. Pushed to the Supabase project through the Management
// API from Settings → Email; they must be pushed again after the name changes.
// The {{ .X }} placeholders are Supabase's Go template variables.

export const RESEND_SMTP = { host: "smtp.resend.com", port: "465", user: "resend" } as const;

function templates(name: string) {
  const footer = `You're receiving this because of an account request at ${name}. If it wasn't you, you can ignore this email.`;
  return {
    confirmation: {
      subject: `Confirm your ${name} email`,
      ...renderEmail({ greeting: `Welcome to ${name}.`, paragraphs: ["Confirm this email address to finish creating your account."], action: { label: "Confirm email", href: "{{ .ConfirmationURL }}" }, footer }),
    },
    recovery: {
      subject: `Reset your ${name} password`,
      ...renderEmail({ greeting: "Hello,", paragraphs: [`Someone asked to reset the password for this ${name} account. The link works once and expires soon.`], action: { label: "Choose a new password", href: "{{ .ConfirmationURL }}" }, footer }),
    },
    invite: {
      subject: `You've been invited to ${name}`,
      ...renderEmail({ greeting: "Hello,", paragraphs: [`You've been invited to create a ${name} account.`], action: { label: "Accept the invitation", href: "{{ .ConfirmationURL }}" }, footer }),
    },
    magic_link: {
      subject: `Your ${name} sign-in link`,
      ...renderEmail({ greeting: "Hello,", paragraphs: [`Use this link to sign in to ${name}. It works once and expires soon.`], action: { label: "Sign in", href: "{{ .ConfirmationURL }}" }, footer }),
    },
    email_change: {
      subject: `Confirm your new ${name} email`,
      ...renderEmail({ greeting: "Hello,", paragraphs: [`Confirm that you want to change your ${name} email from {{ .Email }} to {{ .NewEmail }}.`], action: { label: "Confirm the change", href: "{{ .ConfirmationURL }}" }, footer }),
    },
    reauthentication: {
      subject: `Your ${name} verification code`,
      ...renderEmail({ greeting: "Hello,", paragraphs: ["Enter this code to confirm it's you: {{ .Token }}", `It expires soon. Never share it with anyone, including ${name} staff.`], footer }),
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
