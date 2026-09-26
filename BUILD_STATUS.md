# Grant Platform Build Status

Short phase checklist. `work.md` is the detailed source of truth; keep the two consistent.

## Current direction

Build the application logic first, client-side, against browser-local demo data. The database, API, and authentication come later (decision of 25 Sep 2026). Business rules live as pure functions in `lib/domain/src/` so they can move to the server unchanged.

## Build plan

1. **Applicant UI prototype — Complete**
2. **Applicant logic (browser-only) — Complete**
   - Eligibility, drafts, validated submission and resubmission, ledger-derived balances, withdrawals, card actions, profile edits, reset demo data.
3. **Admin UI — Complete (preview)**
   - Overview, applicants, email inbox (page-memory only), review queue, grant programs, settings with browser-only brand color.
4. **Admin review logic (browser-only) — Complete**
   - Start review, approve with award (≤ requested, ≤ ceiling, ≤ program budget; credits applicant ledger), request changes (applicant edits and resubmits), decline with reason, internal notes, stale-version guard, cross-tab sync.
5. **Payout processing (browser-only) — Complete**
   - `/admin/payouts`: finance marks withdrawal requests paid or failed (reason required; failed funds return to the applicant). No payment provider.
6. **Domain unit tests — Complete** (`pnpm test`, Vitest)
7. **Grant program management (browser-only) — Complete**
   - `/admin/grants`: create drafts, edit with validation, publish, close, reopen, delete unused drafts; eligibility criteria lock after the first submission; change log.
8. **In-app notifications (browser-only) — Complete**
   - Applicant bell for review outcomes, payouts, deposits, and program closures. Email delivery not connected.
9. **Deposits, money settings, withdrawal upgrades, staff activity feed (browser-only) — Complete**
   - Applicants announce deposits with a reference; finance confirms or rejects. Finance sets payout channels (on/off, limits, fees), card fees, deposit limits, the deposit reserve, and the high-value flag. Only enabled channels are offered; applicants can cancel pending deposits and payouts. Staff bell and overview feed of applicant actions.
10. **Spec gaps, browser-only — Complete** (26 Sep 2026)
   - Staff roles (super admin, reviewer, finance, compliance, support) with per-action permission checks via a demo "acting as" switcher; append-only audit log with field-level changes, filters, and CSV/JSON export; automated fraud risk score (0–100) with explained factors and staff alerts; identity checks (applicant submits, compliance approves/rejects/asks again); applicant tier changes, account lock, forced password/2FA resets; escalation of applications to security (blocks approval); two-person sign-off on payouts at or above a threshold; emergency system lockdown; custom questions per program; application processing fee; saved payout destinations; card daily limits and PIN reveal; transaction tabs, date filter, and receipts; spec overview metrics.
11. **Authentication and staff authorization — In progress** (Supabase Auth, chosen 26 Sep 2026; plan in `work.md` §6)
   - Supabase project connected (26 Sep 2026, EU region): URL and publishable key are shared env vars in `.replit`; the app tables (`staff_members`, row-level security on) live in Supabase's Postgres via the `SUPABASE_DATABASE_URL` secret (transaction pooler, Supabase root CA pinned). First super admin: `INITIAL_SUPER_ADMIN_EMAIL`.
   - Still needed from the team: the `SUPABASE_DATABASE_URL` Replit Secret, and the app's URLs in Supabase → Authentication → URL configuration.
   - Done: (a) shared role/permission list (`lib/authz`); (b) `staff_members` table in the existing Postgres; (c) API token check, `GET /api/me`, and staff endpoints, with 16 API tests.
   - Done (26 Sep 2026): (e) staff login page `/admin/login` with password reset (`/admin/reset-password`) and sign-out; `/admin` requires a signed-in, active staff member once the Supabase keys are set, and the signed-in person replaces the "acting as" switcher. Until the keys are set, the login page says sign-in isn't set up and the admin stays in demo mode.
   - Done (26 Sep 2026): (d) real applicant sign-up (with email confirmation), sign-in, forgot/reset password, and sign-out; applicant pages require a session once the keys are set, demo mode otherwise.
   - (f) Live check: partly done. The API against the real project and database answers health, rejects missing and forged tokens, and created the first super admin; Supabase rejects wrong passwords. A browser run of sign-up → confirmation email → sign-in → admin access is still to do once the secret and URLs are set.
   - Business data (applications, money) stays browser-local until phase 12, so this phase protects who can open screens and call the API, not the demo records themselves.
12. **Database and API — In progress** (started 26 Sep 2026)
   - Plan, in slices: (1) shared rules package; (2) grant programs and applicant profiles; (3) applications and review; (4) notifications, staff feed, audit log; (5) money (ledger, deposits, payouts, settings), still without a payment provider. Each slice: tables with row-level security, OpenAPI contract, API with permission tests, portal switched over.
   - Done (26 Sep 2026): (1) the business rules and their 139 tests moved from the portal to `lib/domain` (`@workspace/domain`), used by the portal and bundled into the API server (not yet called there). The browser store stays in the portal (`src/lib/store.tsx`); the saved-data upgrade moved to `lib/domain/src/migrate.ts`.
13. **Documents, email notifications (Resend) — Not started**
14. **Real financial operations — Not started**
   - Card issuance, deposits, and provider-confirmed payouts only after provider, compliance, and ledger decisions.

## Not yet implemented

- Any server persistence: all demo data lives in the visitor's browser (`localStorage`).
- Sign-in, accounts, and enforced authorization. Staff roles exist as rules, but anyone can pick any staff member in the "acting as" switcher; `/admin` is open to anyone with the URL (acceptable only because data is fictional and local).
- Real risk signals (IP, device fingerprint), document inspection for identity checks, and IP capture in the audit log.
- File uploads, private document storage, email/SMS notifications (in-app notifications exist).
- Real card issuance, deposits, charges, or payouts.
- Committed end-to-end, accessibility, and security test suites (domain unit tests exist: 139 tests in 12 files).

## Frontend foundation

The web artifact uses React/Vite with Wouter routing. The original stack notes specify Next.js App Router; the current app is not Next.js, so SSR-specific setup such as `@supabase/ssr` does not apply.
