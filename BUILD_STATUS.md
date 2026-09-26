# Grant Platform Build Status

Short phase checklist. `work.md` is the detailed source of truth; keep the two consistent.

## Current direction

Build the application logic first, client-side, against browser-local demo data. The database, API, and authentication come later (decision of 25 Sep 2026). Business rules live as pure functions in `artifacts/grant-user-portal/src/domain/` so they can move to the server unchanged.

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
   - Needs from the team: a Supabase project, its URL and anon key as secrets, and the app's URLs in Supabase Auth settings.
   - Done: (a) shared role/permission list (`lib/authz`); (b) `staff_members` table in the existing Postgres; (c) API token check, `GET /api/me`, and staff endpoints, with 16 API tests.
   - Waiting on Supabase keys: (d) real applicant sign-up / sign-in / reset / sign-out; (e) `/admin` limited to signed-in staff, replacing the "acting as" switcher; (f) browser test of the full sign-in flow.
   - Business data (applications, money) stays browser-local until phase 12, so this phase protects who can open screens and call the API, not the demo records themselves.
12. **Database and API — Not started**
   - Schema, migrations, OpenAPI contracts; move `src/domain` rules server-side.
13. **Documents, email notifications (Resend) — Not started**
14. **Real financial operations — Not started**
   - Card issuance, deposits, and provider-confirmed payouts only after provider, compliance, and ledger decisions.

## Not yet implemented

- Any server persistence: all demo data lives in the visitor's browser (`localStorage`).
- Sign-in, accounts, and enforced authorization. Staff roles exist as rules, but anyone can pick any staff member in the "acting as" switcher; `/admin` is open to anyone with the URL (acceptable only because data is fictional and local).
- Real risk signals (IP, device fingerprint), document inspection for identity checks, and IP capture in the audit log.
- File uploads, private document storage, email/SMS notifications (in-app notifications exist).
- Real card issuance, deposits, charges, or payouts.
- Committed end-to-end, accessibility, and security test suites (domain unit tests exist: 137 tests in 12 files).

## Frontend foundation

The web artifact uses React/Vite with Wouter routing. The original stack notes specify Next.js App Router; the current app is not Next.js, so SSR-specific setup such as `@supabase/ssr` does not apply.
