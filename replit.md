# arc.fund

A grant-funding workspace: an applicant portal to find programs, apply, and manage deposits and payouts, and an admin workspace for staff to manage programs, review applications, and process money. Detailed brief: `work.md`; phase checklist: `BUILD_STATUS.md`.

## Run & Operate

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm test` — rule tests (`lib/domain`) and API tests (`artifacts/api-server`)
- `pnpm run build` — typecheck + build all packages (the portal build needs `PORT` and `BASE_PATH`)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push schema changes (to Supabase when `SUPABASE_DATABASE_URL` is set, otherwise Replit's database; it prints which)
- Production: live on our own VPS at https://access.novabridgegrant.org (since 27 Sep 2026). Redeploy on the server: `git pull`, `sh deploy/build.sh`, `systemctl restart novabridgegrant-api`; runbook, server facts, and history in `server.md`; service file, nginx site, and build script in `deploy/`
- Environment:
  - Server: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DATABASE_URL` (secret), `INITIAL_SUPER_ADMIN_EMAIL`; optional `INITIAL_SUPER_ADMIN_NAME`, `CORS_ORIGINS`, `TRUST_PROXY_HOPS`, `DOCUMENTS_DIR` (where uploaded files are kept; default `data/documents` under the API's working directory); email: `RESEND_API_KEY` (secret), `EMAIL_FROM` (e.g. `arc.fund <grants@yourdomain>`, on a Resend-verified domain), optional `EMAIL_REPLY_TO`, `APP_URL` (portal address for links in emails); `STAFF_MFA_REQUIRED` (default on; `false` lets staff in without two-step; currently `false` in `.replit`); `SETTINGS_ENCRYPTION_KEY` (optional base64 32-byte key for secrets saved in the admin; otherwise `data/settings.key` is generated, so back it up); optional `RESEND_WEBHOOK_SECRET`, `SUPABASE_ACCESS_TOKEN`, `INBOX_ADDRESS` (all can instead be saved in Settings → Email); `SUPABASE_EMAIL_HOOK_SECRET` (`v1,whsec_…` from Supabase → Authentication → Hooks → Send Email hook; turns on `POST /api/auth/email-hook`)
  - Browser: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
  - Without the Supabase variables, the app runs as a browser-only demo.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Portal: React + Vite, Wouter routing (`artifacts/grant-user-portal`)
- API: Express 5 (`artifacts/api-server`, port 8080 at `/api`)
- Auth: Supabase Auth (email + password, email confirmation)
- DB: Supabase Postgres via Drizzle ORM (Replit Postgres as fallback)
- Validation: Zod (`zod/v4`); API codegen: Orval from `lib/api-spec/openapi.yaml`
- Tests: Vitest; build: esbuild (API), Vite (portal)

## Where things live

- Business rules (shared by the portal and the API): `lib/domain/src/`
- Roles and permissions: `lib/authz/src/index.ts`
- DB schema: `lib/db/src/schema/`; connection: `lib/db/src/connection.ts`
- API contract: `lib/api-spec/openapi.yaml`; routes: `artifacts/api-server/src/routes/`; storage: `artifacts/api-server/src/lib/*Repo*.ts`
- Portal pages: `artifacts/grant-user-portal/src/App.tsx` (applicant), `src/pages/Admin*.tsx` (staff); admin settings sections: `src/pages/AdminSettings.tsx` (add a new section to `SETTINGS_SECTIONS`); application name: `src/lib/appName.tsx`; server data and sync: `src/lib/serverData.tsx`, `lib/domain/src/sync.ts`
- Theme: `artifacts/grant-user-portal/src/index.css`

## Architecture decisions

- The same pure rule functions run in the browser demo and on the server; the server loads records, runs the rule, and stores what changed plus its notifications, feed items, and audit entry in one transaction.
- Concurrency uses Postgres advisory locks (per program; per applicant for money; system-wide for settings and lockdown) plus version checks (409 on stale edits).
- Every table has row-level security on with no policies, so Supabase's public REST API can't reach it; only the API (table owner) reads and writes.
- The audit log is append-only and hash-chained; the API reports whether the chain is intact.
- Uploaded documents are files on the API server's disk (`DOCUMENTS_DIR`), never in Supabase Storage; Supabase holds only their records and SHA-256, checked on every download. Back up that directory with the database.
- Server-loaded records are never written to browser storage.
- Two-step sign-in is Supabase TOTP; the API reads the session's `aal` from the verified token. Staff need aal2; anyone enrolled needs aal2; pending staff-required resets block the account until proven.
- Email settings saved by a super admin (encrypted) override the email environment variables. Supabase's own auth emails (sign-up confirmation, password reset, sign-in links, invites, email change, codes) are sent by this server: Supabase's Send Email Hook calls `POST /api/auth/email-hook` (signed with `SUPABASE_EMAIL_HOOK_SECRET`), and the API renders the email (`lib/authEmails.ts`) and sends it through Resend straight away. Supabase's own mailer and SMTP settings are not used (owner's rule, 28 Sep 2026); Settings → Email shows whether each step of the hook is ready. Resend webhooks (received mail, delivery results) arrive at `POST /api/email/webhook`, verified by signature.
- Sign-in and password-change alerts are reported by the portal (`POST /api/sign-ins`, `POST /api/profile/password-changed`); devices are known by a per-account hash of a random browser id (`sign_in_devices`). Security notices are emailed even when an applicant turned email copies off.
- The failed sign-in rate limit counts only requests with a token Supabase rejected; public routes (`/api/healthz`, `/api/branding`, the signed webhook) are mounted before sign-in.
- Outgoing email uses an outbox table written in the same transaction as the change; a worker in the API sends it through Resend with a per-row idempotency key and retries with backoff.

## Product

Applicants: sign up, verify identity (details plus an uploaded document, reviewed by compliance), upload a file for each application requirement, apply to programs, track reviews, add funds, request payouts, manage fictional cards (create the virtual card, fund the card balance, apply for a physical card with a shipping address, activate it when it arrives, freeze either card). Staff: role-based access (super admin, reviewer, finance, compliance, support), program management, review with escalation, account controls, deposits and payouts with two-person sign-off, card management (approve or decline physical card applications, issue cards, fund and deduct from card balances, freeze with a note, per-applicant card rules on the applicant profile page), money settings, emergency lockdown, team activity, audit log. Applicants are notified in the app and by email of their own actions (deposits, payouts, applications, identity checks, cards, password changes, sign-ins) and of staff decisions; staff get an email when their account signs in from a new device. Super admins rename the application for everyone (Settings → App branding). Admin settings are grouped into sections, one page each. Email goes through Resend once its key is set; Supabase's own sign-in emails can be switched to Resend from Settings → Email (not yet done on the real project). No payment provider or card network is connected.

## User preferences

- Build in slices; commit each finished slice when asked, with a clear message.
- Keep `work.md` and `BUILD_STATUS.md` up to date with what was built and verified.

## Gotchas

- New tables must call `.enableRLS()`.
- `email_settings.app_name`, the `sign_in_devices` table, `ledger_entries.counterpart`/`note`, and `applicant_profiles.card_funding`/`card_kyc_required` were pushed to Supabase on 27 Sep 2026 (from the production server). After any schema change, push to Supabase before restarting the API there.
- `jsonb` reorders object keys, and Postgres timestamps have microseconds: storage code rebuilds nested objects in the domain's key order and compares versions at millisecond precision.
- An empty `description:` in the OpenAPI spec makes orval fail and empty the generated folders.
- The workspace sees the Supabase URL and keys but not the `SUPABASE_DATABASE_URL` secret; add it under Tools → Secrets in this workspace and restart (see `work.md` §6).
- The first super admin is seeded from `INITIAL_SUPER_ADMIN_EMAIL` only when `staff_members` is empty; otherwise add the row yourself (SQL in `server.md` → Step 11).
- Production reaches Supabase through the session pooler (`aws-1-eu-west-1.pooler.supabase.com:5432`); the direct `db.<ref>.supabase.co` host is IPv6-only.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
