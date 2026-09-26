# arc.fund — project brief and implementation handoff

**Status:** Working application in two modes. **Signed in** (Supabase configured): every record — programs, profiles, account controls, applications, reviews, notifications, team activity, the audit log, and money — lives on the server behind an authorized API. **Without sign-in configured:** the original browser-only demo on fictional data. Not a live financial system: no payment provider or card network is connected. Outgoing email and the team inbox are built on Resend but haven't been tried with a real Resend account.
**Last reviewed:** 26 September 2026
**Audience:** Product designers, frontend/backend developers, QA, and security reviewers

## 1. Purpose and product boundary

arc.fund is a grant-funding workspace with two experiences: an **applicant portal** for discovering grant programs, preparing applications, and managing account activity; and an **admin workspace** for a staff team to manage programs, review requests, and process money.

**Two modes, chosen automatically.** When the Supabase settings are present (`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in the browser, `SUPABASE_URL` / `SUPABASE_ANON_KEY` on the server), people sign in with real accounts and every page reads and writes through the API; the database is the single source of truth, and records loaded from it are never kept in browser storage. Without those settings, the app runs the original demo: fictional records in the visitor's own browser (`localStorage`), an "acting as" staff switcher, and nothing leaving the browser.

**What is still not real, in either mode:** money movement (finance records by hand what happened outside the app; receiving details and cards are fictional), automated identity verification (applicants upload documents, but only staff look at them; no provider checks them), SMS and push notifications, risk signals such as sign-in location and device, and recovery codes for two-step sign-in. Email is built (copies of notifications, staff invitations, and a team inbox through Resend) but only sends once the Resend key and sender are set, and no real email has been sent yet. Policies shown at sign-up are placeholders, not legal consent.

**Live verification is outstanding.** The running app can't yet reach its Supabase database (the `SUPABASE_DATABASE_URL` secret is missing; see §6), so the server side has been checked against the real Supabase database with a stand-in for sign-in, but no real sign-up, confirmation email, or signed-in browser session has been tried. Treat the signed-in mode as built and unit/integration-tested, not yet verified end to end. **Do not load real applicant records or real money until that check has passed and the release gates in §7 are met.**

## 2. What exists now

| Area | Signed in (server) | Demo mode (browser only) | Not implemented |
| --- | --- | --- | --- |
| Two-step sign-in | Authenticator app (Supabase TOTP). Required for staff (set up at first sign-in, a code each time; `STAFF_MFA_REQUIRED`); optional for applicants in Settings. Anyone enrolled needs a two-step session for every request. Staff-required password and two-step resets block the account until completed with proof (reset-email session; new authenticator). | Preference switch only. | Recovery codes; removing a lost authenticator from the app (needs a service-role key). |
| Sign-in | Supabase Auth: applicant sign-up (details saved as account metadata) with email confirmation and resend; sign-in returning to the requested page; forgot/reset password (`/reset-password`, `/admin/reset-password`); sign-out. Staff sign in at `/admin/login`; only active staff (from `GET /api/me`) get into `/admin`. | Local validation, a visual-only code step, matching animation; `/admin` open with the "acting as" switcher. | Live check with a real project; real consent recording. |
| Applicant profile and account | Profile created on first sign-in from the sign-up details; name/phone/address editable; email is the sign-in account's. Tier, identity status, lock, and required resets come from the server. Identity check: document type, number (last four characters kept), name, and at least one uploaded photo or scan, reviewed by compliance. | Same screens on the demo profile, without uploads. | A KYC provider. |
| Grant programs | Stored on the server; staff with `programs.manage` create, edit, publish, close, reopen, and delete unused drafts. Drafts are staff-only. Eligibility criteria lock at the first submission; the budget can't go below what's awarded; closing notifies applicants holding drafts. Every change is version-checked and audited. | Same rules on browser data. | Configurable review stages, per-program reviewer assignment. |
| Applications | Drafts, per-step validation, a file uploaded for each program requirement (required to submit), submission with an eligibility re-check, resubmission after changes are requested, custom program questions, the application fee (charged from the deposit balance on first submission if finance sets one). Applicants see only their own records, never internal notes, reviewer names, or escalations. | Same, on browser data; requirements are a readiness checklist, no uploads. | Malware scanning of uploads. |
| Review | Start review, approve with an award (≤ requested, ≤ program ceiling, ≤ remaining budget; credits the applicant's grant balance), request changes, decline, internal notes, escalation to security (blocks approval until compliance clears it). Version-checked; staff can't act on their own application. | Same, with the demo reviewer. | Assignment rules, a Kanban view, a separate "Disbursed" status. |
| Money | Server ledger; balances always derived from it. Deposits (announce with an `ARC-` reference, at most 3 pending, cancel; finance confirms or rejects), payouts (enabled channels only, per-channel limits and fees fixed at request time, deposit reserve, saved masked destination; cancel; finance marks paid or failed), two-person sign-off at or above the dual-control threshold (compared by staff id), fictional cards (freeze, daily limits within tier, physical card with fees), money settings (finance), emergency lockdown (super admin). | Same rules on browser data. | Any payment provider, bank feed, card network, reconciliation, destination-ownership checks. Fees and limits are demo values. |
| Documents | Files on the API server's disk (`DOCUMENTS_DIR`), never Supabase Storage; a `documents` record in Supabase with owner, purpose, application/requirement, detected type, size, and SHA-256 (checked on every download). PDF/JPEG/PNG, 10 MB, typed by content. Frozen while under review or on record. Staff open by role; every staff view is audited. | None. | Malware scanning, retention and purge schedule, off-server backup of `DOCUMENTS_DIR`. |
| Notifications and team activity | In-app notifications per applicant and a team activity feed with read state per staff member, written in the same transaction as the change. Refreshed every 30 seconds and on focus. Email copies of notifications (applicants can turn them off) and staff invitations are queued in `email_outbox` in the same transaction and sent through Resend by a worker in the API (idempotency key per message; retries with backoff). Super admins see delivery status in Settings. | Browser-only, one shared read state; no email. | SMS, push, per-type preferences; a live send (waits on `RESEND_API_KEY` / `EMAIL_FROM` / `APP_URL`). |
| Audit log | Every staff action (programs, applications, account controls, money, staff roles): who, role, IP address, target, field-level before/after, risk score. Append-only and hash-chained; `/admin/audit` shows whether the chain is intact. Filter and export CSV/JSON. | Browser-only log, cleared by **Reset demo data**. | Retention policy, external log shipping. |
| Staff and roles | Super admin, grant reviewer, finance, compliance & risk, support (read-only), enforced by the API on every request. Super admins add staff and change roles; at least one active super admin must remain. The first super admin comes from `INITIAL_SUPER_ADMIN_EMAIL`. | "Acting as" switcher; not a security boundary. | Offboarding workflow, per-role feed filtering. |
| Risk score | Computed from server data (identity status, account age, deposit and payout velocity, destination changes, escalations). | Also uses fictional location/device signals. | Real sign-in location and device signals. |
| Application name | Super admins set it under Settings → Application name (`PUT /api/branding`, audited; stored in `email_settings.app_name`). Everyone sees it: the wordmark and brand letter, page titles, sign-in pages (public `GET /api/branding`), every email, Supabase's sign-in emails once **Reapply** is pressed, and authenticator apps for new two-step setups (the issuer). Default `arc.fund`. | Browser-only preview, like the brand colour. | Existing authenticator entries keep the old name; sample deposit details in the demo data still say arc.fund. |
| Inbox and email settings | Team mailbox: mail received at the domain through the signed Resend webhook, sending and replies through Resend, folders; any active staff member. Super admins manage the Resend key, sender, mailbox address, domain and DNS records, webhook secret, and sign-up email verification in Settings (secrets encrypted on the server, changes audited). From the same page they point Supabase's own emails (sign-up confirmation, password reset, invites, email change, sign-in links, verification codes) at Resend's SMTP relay with the saved key and sender, and replace Supabase's default wording with the app's. Brand colour: this browser only. | Fictional mailbox in page memory. | Attachment downloads in the app, shared brand setting. |

The app uses Supabase project `tynjqjukramcmtotgfdw` (EU) for sign-in and for its Postgres tables when the `SUPABASE_DATABASE_URL` secret is set (otherwise Replit's built-in `DATABASE_URL`). Clerk configuration exists in the environment but is not used. **Configured integrations and installed packages are not evidence of operational authentication, storage, or security.**

## 3. Design specification

### Visual language

- **Brand:** `arc.fund` wordmark, a small rotated `a` mark, charcoal navigation, lime as the original accent, restrained status colors, and soft light surfaces. The applicant layout has a dark vertical sidebar and light content area; the admin workspace uses a related charcoal sidebar with warm paper-like panels. Admin Settings offers preset and custom accent colors with a live preview across both experiences, stored in this browser only; **Restore original color** clears the override.
- **Typography:** DM Sans for body/UI, Space Grotesk for headings and prominent numbers; a monospace face for reference-like details (`artifacts/grant-user-portal/src/index.css`).
- **Hierarchy:** Clear page title and context; compact metric cards and status badges; section cards for forms, queues, and supporting information. Plain-language microcopy explains eligibility, progress, and the consequence of actions.
- **Interaction:** Filters and search update immediately. Actions validate inline; irreversible decisions (approve, decline, close, lockdown, paid/failed) need a second confirming click. Signed in, buttons are disabled while a request is in flight, and a record changed by someone else shows a "changed since you opened it" notice with **Load latest**.
- **Trust signals:** Wording follows the mode. Signed in, pages say records are saved to the account or the server, and still say plainly that no money moves, cards are fictional, and email isn't sent. In demo mode, "saved in this browser only" labels remain. Never label a control as performing an operation it doesn't perform.
- **Responsive behavior:** The applicant sidebar adapts to viewport height; on smaller screens the admin uses a bottom navigation bar and compact record cards. Test down to 320px and short desktop viewports.
- **Accessibility baseline:** Semantic headings, labeled inputs, keyboard-reachable navigation, visible focus, readable status text (not color alone), reduced motion. Verify focus trapping and restoration in dialogs.

Styling lives in `src/index.css` and focused page styles under `artifacts/grant-user-portal/src/pages/`. Page titles and metadata update per route in `src/App.tsx`.

### Language and content rules

Amounts, deadlines, tiers, fees, identities, bank details, and the five sample programs are illustrative, not policy or product commitments. The sign-up industry options, terms, privacy policy, and retention rules must be supplied and approved before collecting real information. The matching animation is visual only.

## 4. User journeys

### Applicant (signed in)

1. `/signup`: name, email, password, then phone, country, sector, date of birth, and the placeholder-policy acknowledgement. **Create account** creates the Supabase account; **Check your email**, then the confirmation link returns to the app signed in (**Resend email** after 30 seconds).
2. The first visit creates the applicant profile from those details (Tier 1, identity not verified). **Settings → Identity check**: enter the document details; compliance reviews them. Most programs need a verified identity.
3. `/grants` lists open and closed programs with per-grant eligibility. **Start application** → three validated steps (details, requirements and program questions, review) → **Submit application**. Drafts save to the account.
4. `/applications` tracks status and history. **Changes requested** shows the reviewer's message; edit and **Resubmit**. An approval credits the award to the grant balance.
5. **Add funds** (`/deposits`): announce an amount and get a reference; the balance is credited when finance confirms. **Settings → Payout destinations**, then **Withdrawals**: request a payout from the grant balance (the deposit reserve must stay in place); cancel while pending. Cards: freeze, set limits, request a physical card.
6. The bell shows notifications for review outcomes, identity checks, tier changes, locks, deposits, payouts, and closed programs.

### Staff (signed in)

1. A super admin adds staff by email in **Settings → Team & roles**. Each person signs in at `/admin/login` with that email once it's confirmed in Supabase; their record links on first sign-in.
2. **Applications**: open a request, **Start review**, then **Approve** (award, confirm), **Request changes**, or **Decline** (reason, confirm); add internal notes; **Escalate** to security (compliance clears it).
3. **Applicants**: identity checks (approve, reject, ask to verify again), tier changes (reason required), lock/unlock, require a password or two-step reset.
4. **Payments → Deposits**: confirm received or reject with a reason. **Payments → Payouts**: send the money outside the app, then **Mark as paid** or **Mark as failed**; large payouts need a release approval from compliance or a super admin first, and a different person marks them paid.
5. **Grants**: create, edit, publish, close, reopen programs. **Settings → Money settings** (finance): channels, limits, fees, deposit rules, dual-control threshold, application fee. **Security**: identity queue, escalations, risk watchlist, emergency lockdown (super admin). **Audit log** (super admin, compliance): every action with IP and field changes, and the integrity check.
6. The team activity bell lists applicant actions that need attention; read state is per person.

### Demo mode (no Supabase settings)

The same pages run on fictional records in the visitor's browser: `/` and `/admin` open without signing in, `/admin` has an **Acting as** switcher for the five demo staff, and **Settings → Reset demo data** restores the seed records. Sign-up, sign-in, and reset pages show preview feedback without creating sessions. Nothing leaves the browser.

### Intended live journeys — still to design

- Explicit acceptance of published, versioned policies; provider-confirmed deposits and payouts with reconciliation. (Document upload and email copies of notifications, previously listed here, are built.)
- Exception paths: expired sessions, failed notifications, reviewer conflicts, retried submissions, and provider failures each need explicit feedback and safe recovery.

## 5. System logic and backend (built)

### Architecture

- **One set of rules.** The business rules are pure functions in `lib/domain` (`@workspace/domain`): state in, result out. The browser demo runs them on its local store; the API runs the same functions on records loaded from the database and stores what changed. Server-only rules layered on top: ownership from the sign-in token, conflict-of-interest checks (staff can't act on their own applicant account, application, or money), staff-id comparison for the two-person payout rule, and $0 application fee where money settings aren't loaded.
- **The current-applicant slot.** The rules were written around one "current applicant". The server runs them with the real applicant loaded into that slot (`applicantState` / `readApplicantSlot` in `lib/domain/src/server.ts`) and maps ids back when saving; staff rules on another applicant are called with the slot id.
- **Effects.** Notifications and feed items a rule creates, and an audit entry for every staff action (built with the same `recordAudit` the demo uses), are written in the same transaction as the change (`artifacts/api-server/src/lib/activity.ts`). Refused actions leave nothing behind.

### Concurrency and consistency

| Change | Lock (Postgres advisory, per transaction) | Why |
| --- | --- | --- |
| Anything on a program or its applications (edits, drafts, submissions, reviews) | The program | Budgets can't be overspent by simultaneous approvals; criteria lock atomically with the first submission; one active application per applicant per program. |
| An applicant's money (deposits, payouts, cards, destinations) and application fees | The system (shared), then the applicant | Balance and reserve checks can't be raced; nothing slips through while a lockdown starts. |
| Money settings, lockdown | The system (exclusive) | Settings and the lockdown change atomically. |
| Audit entries | The audit chain | Each entry links to the previous entry's hash. |

Lock order is always program → system → applicant, so there are no cycles. Records also carry versions (`updated_at`); edits based on an outdated copy get **409** and the page offers **Load latest**. Versions are compared at millisecond precision (Postgres keeps microseconds). Postgres `jsonb` reorders object keys, so storage code rebuilds nested objects in the domain's key order before rules compare them.

### Data (Supabase Postgres, Drizzle schema in `lib/db/src/schema/`)

`staff_members`; `programs`; `applicant_profiles` (profile, account controls, identity check, fictional cards, masked payout destinations); `applications`; `ledger_entries` (signed amounts; balances are always derived); `system_settings` (one row: money settings and lockdown); `email_outbox` (queued, sent, failed, and skipped email, plus delivery results); `email_settings` (one row; secrets encrypted); `inbox_messages` (team mailbox); `documents` (records of uploaded files; the files are on the API server's disk under `DOCUMENTS_DIR`, keyed `<owner id>/<random uuid>`, mode 0600); `notifications`; `staff_events` + `staff_event_reads`; `audit_events` (hash-chained). Every table has row-level security **on with no policies**, so Supabase's public REST API (the publishable key) can neither read nor write them; the API connects as the table owner. New tables must call `.enableRLS()`. Ids: `PRG-3001…`, `APP-5001…`, ledger `TX-` and deposit `ARC-` numbers from a sequence that advances in blocks of ten (one block per request). On startup the API creates the first super admin (if the staff table is empty), the default money settings row, and the five sample programs (if the programs table is empty, keeping their ids).

### API (`artifacts/api-server`, contract `lib/api-spec/openapi.yaml`)

Every route except `GET /api/healthz` verifies a Supabase bearer token (503 until sign-in is configured). Ownership always comes from the token.

- **Signed-in anyone:** `GET /api/me`; `GET /api/programs` (drafts only for staff); `GET/PATCH /api/profile`, `POST /api/profile/identity`, `/profile/credential-reset`; `GET /api/applications/mine`, `POST /api/applications/save`, `/submit`, `/{id}/delete`; `GET /api/notifications` and mark read; `GET /api/money/mine` and `POST /api/money/deposits`, `/deposits/{id}/cancel`, `/withdrawals`, `/withdrawals/{id}/cancel`, `/cards/freeze`, `/cards/limit`, `/cards/physical`, `/destinations`, `/destinations/{channel}/remove`; `GET/PUT /api/profile/email-preference`; `GET /api/documents/mine`, `POST /api/documents` (raw file body), `/documents/{id}/delete`, `GET /api/documents/{id}/file`.
- **Active staff:** `GET /api/documents?applicantId=|applicationId=` (only kinds the role may open), `GET /api/applicants`, `/api/applications` (queue), `/api/staff-feed` (+ mark read), `/api/money/ledger`, `/api/money/settings`.
- **By permission:** programs (`programs.manage`); account controls (`accounts.tier`, `accounts.manage`, `kyc.review`); review (`applications.review`, `notes.add`, `applications.escalate`, `applications.clearEscalation`); deposits and payouts (`payments.process`, `payments.release`); money settings (`treasury.manage`); lockdown (`security.lockdown`); audit log (`audit.view`); staff, email settings, domain, sign-up verification, and delivery status under `/api/email/*` (`staff.manage`); team inbox `/api/inbox*` (any active staff). Public: `POST /api/email/webhook` (Resend signature required).
- Protections: security headers on every response (`Cache-Control: no-store`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, HSTS, `default-src 'none'`); rate limits per signed-in user (300 requests and 60 changes a minute, 30 uploads per 10 minutes) and per address for failed sign-ins (30 per 10 minutes), answered with 429 and `Retry-After`. Counters live in the process's memory: with several API instances, move them to a shared store.
- CORS: `CORS_ORIGINS` plus the Replit domains and same-host requests. The audit IP is `req.ip` with `trust proxy` = `TRUST_PROXY_HOPS` (default 1, Replit's proxy — unverified; if every entry shows the same address, adjust it).

### Portal integration (`artifacts/grant-user-portal`)

`ServerDataProvider` (`src/lib/serverData.tsx`) loads server records into the same store every page reads — programs, the applicant's profile and applications and money, or for staff the directory, review queue, ledger, settings, team feed, and audit log — and refreshes activity and money every 30 seconds and on focus. Actions call the generated API client (`lib/api-client-react`) and put the saved record back into the store (`lib/domain/src/sync.ts`). `forStorage` strips every server-loaded record before the store writes to `localStorage`. After signing out, the demo records return.

### Still to decide or build

- **Money:** a licensed provider and compliance model, bank-feed or webhook matching for deposits, provider-confirmed payouts, reconciliation, and refunds for cancelled deposits that arrive anyway. The ledger is authoritative for the app but not for real funds.
- **Identity:** a KYC provider (documents are uploaded and reviewed by hand today), versioned policy acceptance, two-step recovery codes.
- **Documents:** malware scanning, a retention and purge schedule, and backups of `DOCUMENTS_DIR` alongside the database (the files exist only on the server's disk).
- **Email:** outgoing mail, the team inbox (received through the signed Resend webhook), and the email settings page are built; save the Resend key, sender, and portal address (in Settings → Email or as environment variables), add the domain and its DNS records, point Resend's webhook at `POST /api/email/webhook`, then send a test. Supabase's own sign-up, reset, and verification-code emails are switched to Resend from the same page (**Use Resend**, refused while the saved domain isn't verified; press again after changing the key or sender), and **Use arc.fund wording** installs the app's subjects and text for them. The Supabase access token these need should be a scoped Project token for this project only, with Auth read & write, everything else None, and a short expiry (a legacy token can manage every project in the account); remove it once setup is done. The app checks only its shape (project API keys are refused) and then asks Supabase to accept it before saving. Supabase's email rate limit (Authentication → Rate Limits) is shown but not changed from the app. Still to build: downloading received attachments in the app.
- **Branding:** a shared, staff-authorized brand setting if a site-wide color is wanted.

## 6. Status and delivery

**Built (all committed on branch `money-flows`):** the browser demo (phases 1–10); Supabase sign-in for applicants and staff with server-enforced roles (phase 11); phase 12, moving every record to the server in five slices — shared rules package, programs and profiles, account controls and identity checks, applications and review, notifications/activity/audit, and money; and from phase 13, document uploads (files on the API server's disk), email through Resend (outbox and sending worker, email settings in the admin, domain setup, signed webhook, team inbox, sign-up verification switch), two-step sign-in with enforced staff-required resets, and API security headers and rate limits. See `BUILD_STATUS.md` for the per-slice record.

**Blocking the live check:** the running app can't reach its Supabase database. As of 26 Sep 2026 the workspace sees `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `INITIAL_SUPER_ADMIN_EMAIL`, but not the `SUPABASE_DATABASE_URL` secret. To fix: add it under **Tools → Secrets** in this workspace (not only in Deployments) and restart the app. `! env | grep -oE '^(SUPABASE|VITE_SUPABASE|INITIAL_SUPER)[A-Z_]*'` shows whether the workspace sees them. Supabase → Authentication → URL configuration must list the app's addresses (done for the dev address).

**Next, in order:**

1. The live check: sign up at `/signup` as the first super admin's email, confirm it, sign in at `/admin/login`; then one full pass through an application, a review, a deposit, and a payout, and a look at the audit log's IP addresses.
2. Committed end-to-end, accessibility, and security test suites (see §7).
3. Product decisions: real programs and eligibility, application fields, policy text, data retention, and whether money features are in scope.
4. Phase 13: add the Resend secrets and confirm a real email arrives. Documents and outgoing email are built.
5. Phase 14: real financial operations, only after provider, compliance, and ledger decisions.

`BUILD_STATUS.md` is the short phase checklist kept in sync with this brief; this brief is the detailed source of truth.

## 7. Testing and release gates

**Current evidence (26 Sep 2026):**

- `pnpm test` runs **157 rule tests** (`lib/domain/src/*.test.ts`, 14 files: eligibility, validation, every status transition, stale versions, budgets, ledger balances, fees and limits, deposits, payouts and dual control, lockdown, programs, notifications, roles and audit, risk, identity and account controls, saved-data migrations, the server state helpers, and the browser/server sync including what may be stored) and **96 API tests** (`artifacts/api-server/src/api.test.ts`, against in-memory storage: authentication and CORS; staff management; each resource's permissions per role; ownership (applicant A can't read or change applicant B's records); conflict-of-interest refusals; version conflicts; applicants never seeing staff-only fields; concurrent approvals and concurrent payout requests where exactly one succeeds; the two-person payout rule by staff id; lockdown; notifications, per-person read state, audit entries, and tamper detection; documents: accepted types and size, identity and requirement files required, frozen evidence, who may open what, audited staff views, changed-file detection, draft deletion removing files; email: notification copies and opt-out, staff invitations with escaped content, status for super admins only, skipped when unconfigured, Resend idempotency keys, retry and give-up rules; protections: security headers, per-user request, change, and upload limits, and failed sign-in limits per address; two-step: staff blocked until two-step, enrolled users need a code, required resets blocked until proven by a reset-email session or a new authenticator, staff requirement switchable; email administration: super-admin only, keys checked with Resend and never returned or audited in full, sign-up verification, Resend SMTP for Supabase's emails (refused on an unverified domain, key never audited), and the app's email wording through the Supabase Management API, domain creation, signed webhooks only (bad or stale signatures refused), received mail stored once, sending and replying with thread headers, delivery status).
- **Against the real Supabase database** (the real storage code and API routes, with a stand-in for sign-in, test data removed afterwards): programs (13 checks), account controls (9), applications and review (10, including simultaneous approvals under real transactions), notifications/activity/audit (7, including 10 concurrent audited actions and detection of a direct database edit), and money (17, including concurrent payout requests, the two-person rule, lockdown, settings conflicts, and exact ledger totals); documents against Replit's database and a real disk directory (10: record and SHA-256 stored, file mode 0600, same bytes back, changed file detected, delete removes the file and keeps the record); email outbox (7: copies queued in the change's transaction and not for opted-out applicants, none when the change fails, concurrent claims take a row once, retry scheduling, skipped when unconfigured). These checks found and fixed three real bugs the in-memory tests couldn't: jsonb key reordering, microsecond timestamps breaking version checks, and a schema-push failure on Replit's database.
- **Not yet tested:** the portal's signed-in mode in a browser, any real Supabase sign-in or email, and no committed end-to-end, accessibility, or security suites. The demo mode was verified in a headless browser earlier (39 checks) but hasn't been re-run since phase 12's portal changes. Passing typechecks and builds is not proof of user-flow correctness.

| Test area | Required before live use |
| --- | --- |
| Rules and API | **In place**; extend with every rule and endpoint. |
| UI and journeys | Browser runs of both modes: every applicant and admin flow, errors and 409 handling, 320px layouts. |
| Authentication | Real sign-up, confirmation, sign-in, recovery, session expiry, sign-out, staff linking on first sign-in. |
| Authorization and privacy | **API level in place.** Add: nothing sensitive in logs, analytics, bundles, exports, or browser storage (check `localStorage` after using each page signed in). |
| Documents | **Type/size limits, private access, and changed-file detection in place** (API tests and real-disk checks). Add: malware handling, retention. |
| Email | **Signed webhooks, server-side encrypted secrets, and retry/give-up rules in place** (API tests). Add: a real send, a real received message, and delivery failures through a real Resend account. |
| Finance | Provider sandbox tests, reconciliation, retries, duplicate prevention — before any real money. |
| Operational security | **API security headers and rate limits in place.** Add: threat model, dependency and static scans, headers on the portal's static hosting, logging/alerting, backups (database and `DOCUMENTS_DIR`), penetration review. |
| Accessibility | Labels and announcements, contrast, focus, dialogs, reduced motion. |

**Release gate:** do not load real applicant records until the live sign-in check, a browser run of the signed-in mode, and the privacy checks above pass. Do not present money features as real until an approved provider and reconciliation flow has passed its own security and operational reviews.

## 8. Developer orientation

**Workspace**

- Rules: `lib/domain/src/` — applicant `rules.ts`, review `review.ts`, programs `programs.ts`, accounts and identity `accounts.ts` / `applicants.ts`, money `money.ts` / `deposits.ts` / `payouts.ts` / `treasury.ts`, lockdown `security.ts`, notifications `notifications.ts`, feed `activity.ts`, audit `audit.ts`, risk `risk.ts`, roles and `asStaff` `staff.ts`, types `model.ts`, seed data `seed.ts`, saved-data upgrades `migrate.ts` (add a step whenever `DemoState` changes shape), server helpers `server.ts`, browser/server sync and storage filter `sync.ts`.
- Roles and permissions: `lib/authz/src/index.ts` (`@workspace/authz`).
- Database: schema `lib/db/src/schema/`; connection `lib/db/src/connection.ts` (`SUPABASE_DATABASE_URL` via the transaction pooler with Supabase's root CA pinned, expiring Apr 2031; otherwise Replit's `DATABASE_URL`). Apply schema changes to both databases with `pnpm --filter @workspace/db run push` (it prints which database it uses; set or unset `SUPABASE_DATABASE_URL` to choose).
- API contract: `lib/api-spec/openapi.yaml`; regenerate clients with `pnpm --filter @workspace/api-spec run codegen` (no empty `description:` fields — orval fails on them and empties the generated folders).

**API server** (`artifacts/api-server/src/`)

- Entry `index.ts` (startup seeding), app `app.ts`, routes `routes/` (`me`, `staff`, `programs`, `profile`, `applicants`, `applications`, `money`, `activity`, `documents`, `email`), auth middleware `middlewares/auth.ts` (`authenticate`, `loadStaff`, `requireStaff`, `requirePermission`, `auditContext`).
- Storage: each resource has an interface with an in-memory version for tests (`lib/*Repo.ts`) and a Drizzle version (`lib/*Repo.db.ts`); locking in `applicationRepo.db.ts` (`withProgram`) and `moneyRepo.db.ts` (`withApplicant`, `withSystem`); effects and the audit chain in `lib/activity.ts` / `activity.db.ts`; ledger writes in `lib/ledger.ts`; document records `lib/documentRepo*.ts` and files `lib/fileStore.ts`; email rendering, sending, and the worker `lib/email.ts`, outbox `lib/emailOutbox.db.ts`; account rules in `lib/applicantRules.ts`.
- Tests: `api.test.ts` (`pnpm --filter @workspace/api-server run test`).
- Environment: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DATABASE_URL`, `INITIAL_SUPER_ADMIN_EMAIL` / `INITIAL_SUPER_ADMIN_NAME`, `CORS_ORIGINS` (optional), `TRUST_PROXY_HOPS` (optional, default 1), `STAFF_MFA_REQUIRED` (optional, default on), `DOCUMENTS_DIR` (optional; set it to a persistent, backed-up directory on the VPS), `RESEND_API_KEY` / `EMAIL_FROM` / `EMAIL_REPLY_TO` / `APP_URL` (email).

**Portal** (`artifacts/grant-user-portal/src/`)

- Routes and applicant pages `App.tsx`; admin pages `pages/Admin*.tsx`; sign-in pages `pages/AuthPages.tsx` and `pages/AdminLogin.tsx`.
- Session: `lib/supabase.ts`, `lib/session.tsx`. Store: `lib/store.tsx` (key `arc.fund.demoState.v2`; saves `forStorage(state)`). Server data and action hooks: `lib/serverData.tsx` (`ServerDataProvider`, `useMoneyAction`, `useStaffMoney`, `apiError`).
- Environment: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

**Commands:** `pnpm run typecheck`, `pnpm test`, `pnpm run build`; portal build needs `PORT` and `BASE_PATH` (e.g. `PORT=1 BASE_PATH=/`). The API runs on port 8080 at `/api`.

Never infer functionality from a styled control, installed dependency, configured integration, or example number: trace the request, the server's authorization, the stored record, and what the page shows.
