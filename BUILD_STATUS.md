# Grant Platform Build Status

## Current direction

Build the applicant-facing grant portal first. Deliver the interface before connecting Supabase or implementing application and financial business logic. The admin dashboard is a separate later phase.

## Build plan

1. **Applicant UI prototype — Complete**
   - Responsive applicant workspace for dashboard, grants, applications, cards, transactions, withdrawals, and profile settings, plus login, sign-up, forgot-password, and 404 screens.
   - Use illustrative sample data and front-end-only interactions.
   - Clearly identify demo states; do not imply an account was created, a password reset was sent, an application was submitted, or a financial action completed.
2. **Supabase foundation — Not started**
   - Connect the Supabase project.
   - Define the data model, authentication, row-level security, and private document storage.
3. **Applicant workflows — Not started**
   - Implement persistent application drafts, submissions, status tracking, profile/KYC flows, and document uploads.
4. **Financial operations — Not started**
   - Define and implement card, deposit, and withdrawal flows only after the payment provider, regulatory/compliance requirements, and user protections are established.
5. **Admin portal — Not started**
   - Build a separate admin product for grant configuration, application review, financial operations, and audit/security controls.

## Completed

- Applicant and admin requirements reviewed and separated into distinct product phases.
- Grant Applicant Portal web artifact scaffolded.
- Applicant UI completed with responsive dashboard, grant explorer, application flow, cards, transactions, withdrawals, and settings screens.
- UI-only login, sign-up, forgot-password, and 404 pages added; auth forms validate inputs locally but do not sign in, create accounts, or send email.
- Demo-only interactions and sample-data notices added; front-end typecheck passes.

## Not yet implemented

- Supabase is connected to the workspace, but not wired into the app; schema, authentication, and persistence are not implemented.
- Real file uploads or private document storage.
- Real application submission, eligibility decisions, or status updates.
- Real card issuance, deposits, charges, balances, or withdrawals.
- Admin dashboard and security controls.

## Frontend foundation

The selected web artifact uses React/Vite. The original stack notes specify Next.js App Router; the current UI artifact is not Next.js, so SSR-specific setup such as `@supabase/ssr` is not part of this UI phase.