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
10. **Authentication and staff authorization — Not started** (Supabase or Clerk; choose one)
11. **Database and API — Not started**
   - Schema, migrations, OpenAPI contracts; move `src/domain` rules server-side.
12. **Documents, email notifications (Resend) — Not started**
13. **Real financial operations — Not started**
   - Card issuance, deposits, and provider-confirmed payouts only after provider, compliance, and ledger decisions.

## Not yet implemented

- Any server persistence: all demo data lives in the visitor's browser (`localStorage`).
- Sign-in, accounts, staff roles, and authorization; `/admin` is open to anyone with the URL (acceptable only because data is fictional and local).
- File uploads, private document storage, applicant notifications.
- Real card issuance, deposits, charges, or payouts.
- End-to-end, accessibility, and security test suites (domain unit tests exist).

## Frontend foundation

The web artifact uses React/Vite with Wouter routing. The original stack notes specify Next.js App Router; the current app is not Next.js, so SSR-specific setup such as `@supabase/ssr` does not apply.
