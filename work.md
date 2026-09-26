# arc.fund — project brief and implementation handoff

**Status:** Browser-only working prototype (applicant, admin review, payouts, program management, and in-app notifications; no backend); not a live grant, identity, or financial system  
**Last reviewed:** 26 September 2026  
**Audience:** Product designers, frontend/backend developers, QA, and security reviewers

## 1. Purpose and product boundary

arc.fund is a proposed grant-funding workspace with two experiences: an **applicant portal** for discovering grant programs, preparing applications, and understanding account activity; and an **admin workspace** for a future staff team to manage programs and review requests. The product aims to make eligibility, application progress, and funding activity understandable without losing the trust and controls required for sensitive applicant data and money movement.

**Today, both experiences run on fictional demo data stored in the visitor's own browser (localStorage).** The applicant portal and `/admin` share one local store: an applicant can draft and submit, a reviewer in `/admin` can start a review, request changes, approve (crediting the demo grant balance), or decline; finance can mark applicant withdrawal requests paid or failed (a failure returns the funds); program managers can create, edit, publish, close, and reopen grant programs; applicants get in-app notifications for each of these outcomes. Each side sees the other's changes, even across tabs. Nothing leaves the browser: no visitor is authenticated, nothing is stored on a server, no real grant is awarded, and no card, deposit, or payout is issued. The admin workspace is reachable by URL without staff authorization; that is acceptable only because every record is fictional and local to the viewer. Its brand-color setting affects only the current browser, not the site for everyone. **Do not connect real applicant records or email to this route until server-side staff authorization and privacy controls exist.**

The current objective is to establish and iterate on the interface. A production implementation requires decisions on policies, identity, eligibility, data ownership, review governance, and any regulated financial partners before operational logic is enabled.

## 2. What exists now

| Area | Implemented UI / local behavior | Not implemented |
| --- | --- | --- |
| Applicant access | Sign-in, four-step sign-up, password-reset screens; local form validation and feedback. Sign-up plays an illustrative matching animation, then navigates to the demo dashboard after roughly four seconds. | Accounts, login sessions, email or code delivery/verification, actual grant matching, password reset, real consent recording. |
| Applicant dashboard | Eligible amount, grant/deposit balances, application pulse, card, and activity computed from the browser-stored demo state (`src/domain/`). | Server-side data; balances are derived from a local ledger, not an authoritative one. |
| Grant discovery | Programs come from the shared store (managed in `/admin/grants`). Draft programs are hidden; Open programs accept applications until their deadline; Closed programs show **Closed**. Per-grant eligibility (program status, deadline, tier, identity verification, one active application per grant); Start / Resume draft / Update application / View application / Not eligible states; tier filter. | Server-side catalog and eligibility. |
| Applications | Create, save, resume, delete drafts; per-step validation (name, amount within grant min/max, registration when required, 30-char plan, requirements checklist); submit with eligibility re-check; read-only detail with status history (who acted, applicant-visible messages, award amount or decline reason). When a reviewer requests changes, the application reopens with the reviewer's message and can be edited and **resubmitted** (even after the deadline). Saved in this browser (localStorage). | Server persistence, file upload (checklist confirms readiness only), email/in-app notifications. |
| Cards and transactions | Freeze/unfreeze persisted; physical card request charges an $8.50 fee to the deposit balance (once). Searchable/filterable ledger including new payouts and fees; CSV export marked demo-only. | Card issuance, real transaction history, accounting. |
| Withdrawals | Validated request ($10 minimum, ≤ grant balance, 2 decimals), fee breakdown, confirmation, pending ledger entry (with fee and destination) that holds the amount, request history. When finance processes it in `/admin/payouts`, the entry shows **Paid** with the net amount received, or **Failed** with the reason, and a failed amount returns to the grant balance. | Bank/mobile-money integration, actual transfers, cancelling a pending request. The 1.25% fee capped at $14 is **demo math**, not an approved commercial rule. |
| Notifications | Topbar bell with unread count; panel lists the applicant's notifications (newest first) with relative time; selecting one marks it read and opens the related page; **Mark all as read**. Created in the same step as: review started, changes requested, approved, declined, payout paid, payout failed, and program closed while the applicant holds a draft. A draft on a closed program shows a notice that it can't be submitted. | Email/SMS delivery (Resend not connected), notification preferences, real-time push. |
| Applicant settings | Validated profile editing and two-step preference saved in this browser; tier/verification drive eligibility; **Reset demo data** restores the seed records. | Server-side profile, KYC/identity checks, actual MFA. |
| Admin `/admin` | Overview, applicant directory, email inbox, application review queue, grant programs, and settings. **Review workflow** (`src/domain/review.ts`, `pages/AdminReviewPanel.tsx`): the queue and overview are computed from the shared store (drafts are never shown to staff); a review panel shows the request, confirmed requirements, program budget left, full history, and staff-only internal notes. Actions: **Start review** (Submitted → Under review, assigns the demo reviewer "Avery Taylor"); **Approve** with an award amount (≤ requested, ≤ program ceiling, ≤ remaining program budget; two-step confirm; credits the applicant's grant ledger); **Request changes** (message ≥ 10 chars, sent to applicant); **Decline** (reason ≥ 10 chars, two-step confirm). Approved/Declined are final. Stale-version guard: if the record changed after the reviewer opened it, actions are blocked until **Load latest**. **Grant programs** (`/admin/grants`, `src/domain/programs.ts`, `pages/AdminPrograms.tsx`): cards show status, award range, budget left, deadline, and submitted count, with a status filter. **New program** creates a Draft; the program panel edits name, focus, summary, minimum request, maximum award, budget, deadline, minimum tier, registration requirement, and 1–8 requirements, with validation. **Publish** (Draft → Open), **Close to new applications** (Open → Closed, two-step; notifies applicants holding drafts), **Reopen** (Closed → Open, deadline must be in the future), **Delete** (unused drafts only). Once any application is submitted, tier, requirements, registration, and minimum request are locked and the maximum award can only rise; the budget can never go below what's awarded. Every change is logged (who, when, which fields); a stale-version guard blocks edits against an outdated copy. Acting as demo program manager "Sam Rivera". The applicant directory includes the portal's demo user and each person's submitted-application count. **Payouts** (`/admin/payouts`, `src/domain/payouts.ts`, `pages/AdminPayouts.tsx`): metrics (waiting, amount held, paid, failed), searchable/filterable list (pending oldest first), and a panel showing destination, gross, fee, and net. Finance (demo operator "Jordan Lee", deliberately not the reviewer) can **Mark as paid** or **Mark as failed** with an applicant-visible reason (≥ 10 chars), each with a two-step confirm. Only a Pending payout can be processed, and only once. The overview shows payouts waiting. Email inbox and brand color unchanged (page-memory mailbox; browser-only color). | Staff accounts/roles and authorization (reviewer / finance / program manager are labels only, not enforced), custom application questions per program, reviewer assignment rules/conflict-of-interest checks, payment-provider integration and reconciliation, document inspection, configurable review stages, program editing, applicant notifications/email, Resend connection, site-wide branding, server-side audit log. Other visitors do not see this browser's decisions or color. |
| API / data | Express server with `GET /api/healthz` returning `{ "status": "ok" }`; OpenAPI and generated client/schema scaffolding; PostgreSQL/Drizzle connection package. | Domain API endpoints, database tables/migrations, real persistence, authorization middleware, app-to-API integration. |

The workspace has a Supabase connection available for future work, but this app does not use it yet. Clerk-related configuration is present in the environment, but the frontend and API do not currently use Clerk. **Configured integrations and installed packages are not evidence of operational authentication, storage, or security.**

## 3. Design specification

### Visual language

- **Brand:** `arc.fund` wordmark, a small rotated `a` mark, charcoal navigation, lime as the original accent, restrained status colors, and soft light surfaces. The applicant layout has a dark vertical sidebar and light content area; the admin workspace uses a related charcoal sidebar with warm paper-like panels. Admin Settings offers preset and custom accent colors with a live preview across both experiences. The choice is stored in this browser only; **Restore original color** clears the override.
- **Typography:** DM Sans for body/UI, Space Grotesk for headings and prominent numbers; a monospace face for reference-like details. These are defined in `artifacts/grant-user-portal/src/index.css`.
- **Hierarchy:** Clear page title and context; compact metric cards and status badges; section cards for forms, queues, and supporting information. Use plain-language microcopy to explain eligibility, progress, and the consequence of actions.
- **Interaction:** Local filters/search update immediately; navigational links lead to the appropriate preview. Applicant and review actions validate inline, and irreversible review decisions (approve, decline) require a second confirming click. Applicant, grant-program, and inbox detail views remain read-only. Inbox folders, search, read/star/archive/trash actions, and drafts work only in page memory. The brand-color control updates shared accents immediately and remembers the choice in local browser storage. Provide explicit empty states and feedback. Review decisions are the one exception to "no approve affordances": they operate only on browser-local demo records and say so. Avoid pay, upload, send, or publish affordances that imply a real operation until the backend is ready.
- **Trust signals:** Demo labels must remain visible wherever the experience could be mistaken for a live account, legal consent, verification, grant decision, email delivery, or money movement. The former full-width admin preview banner was removed; the topbar preview badge, sidebar note, inbox-specific disconnected notice, and the review panel's "demo review workflow / browser only / no staff authorization" note remain. Do not show real personal data in the public preview.
- **Responsive behavior:** The applicant sidebar adapts to viewport height without independently scrolling. On smaller screens, navigation and content reflow; the admin uses a bottom navigation bar and compact record cards for applicants/applications. Test widths down to the site's 320px minimum as well as short desktop viewports.
- **Accessibility baseline:** Semantic headings, labeled inputs and controls, keyboard-reachable navigation, visible focus, readable status text (not color alone), and reduced-motion handling. For future live dialogs, verify focus trapping and focus restoration rather than assuming visual presentation provides accessible modal behavior.

Current styling lives in `src/index.css` and focused page styles under `artifacts/grant-user-portal/src/pages/`. Shared accent variables let the browser-only choice affect both applicant and admin screens while keeping their layouts separate. Page titles and description/social metadata update per route in `src/App.tsx`.

### Language and content rules

Amounts, deadlines, tiers, statuses, identities, bank details, and sample program descriptions are illustrative, not policy or product commitments. The sign-up industry options are examples; the real option set, terms, privacy policy, and retention rules must be supplied and approved before collecting real information. The current matching animation is visual only, not a recommendation engine.

## 4. User journeys

### Applicant: explore without an account — working preview

1. Visit `/` or `/dashboard` directly; no authentication gate currently exists.
2. Inspect sample eligibility and activity, then open `/grants`; filter programs by tier. The bell in the top bar shows unread notifications; select one to open the related application or the Withdrawals page.
3. Select **Start application** (or **Resume draft** / **Update application**) to reach `/applications/new/:grantId` or `/applications/:id`. Each **Continue** validates the step and saves a draft in this browser; confirm each requirement on step 2.
4. Select **Submit application** on the Review step. The record becomes Submitted, read-only, and appears in `/admin/applications`. Nothing is sent anywhere else.
5. Track it in `/applications`. If a reviewer requests changes, the application shows **Changes requested** with the reviewer's message; edit and **Resubmit**. Approvals appear in the history and credit the grant balance on the dashboard and Withdrawals page; declines show the reviewer's reason.
6. Withdrawals, card freeze/physical-card request, and profile edits also persist in this browser. A withdrawal stays Pending until finance processes it in `/admin/payouts`; the Withdrawals and Transactions pages then show Paid (with the net received) or Failed (with the reason, and the amount back in the grant balance). **Settings → Reset demo data** restores the seed records.

### Applicant: account preview — working UI, no identity operation

1. `/signup` collects account fields with local validation (including password confirmation), then contact/country/sector/date-of-birth fields and acknowledgement that policy documents are placeholders.
2. The email step shows a code input solely for visual preview: no code is sent or checked, and it can be skipped.
3. The matching animation plays; after about four seconds the browser goes to `/dashboard`. This is **navigation, not sign-in**.
4. `/login` locally validates a nonempty password and email and then displays preview feedback; `/forgot-password` locally validates an email and displays preview feedback. Neither sends a request or creates a session.

### Staff: admin review — works on browser-local demo data, no staff access control

1. Visit `/admin` directly. Metrics and the review queue (oldest submission first) are computed from this browser's demo data.
2. Open `/admin/applications`, filter by status, and select a request to open the review panel. These are the **same records** the applicant portal uses (the demo user "Alex Morgan" plus six fictional applicants).
3. For a Submitted request, **Start review**. For one Under review, choose **Approve** (enter the award, confirm), **Request changes** (write the message), or **Decline** (write the reason, confirm). Add staff-only internal notes at any time.
4. The applicant portal (same browser, any tab) reflects the decision immediately; an approval credits the award to that applicant's grant balance. A Changes-requested application returns to the queue as Submitted when the applicant resubmits.
5. `/admin/applicants` shows profiles with submitted-application counts (read-only).
6. `/admin/payouts` lists withdrawal requests. Open one, send the net amount outside the app (no provider is connected), then **Mark as paid**, or **Mark as failed** with a reason; confirm either. The applicant's ledger updates immediately.
7. Explore `/admin/inbox` for fictional conversations, folders, search, local read/star/move actions, and drafts. **Preview send** does not transmit anything, and incoming mail does not appear automatically. Reloading resets local mailbox changes.
8. Open `/admin/grants` to manage programs: create a draft with **New program**, edit details in the program panel, **Publish**, **Close to new applications**, or **Reopen**; locked criteria show a lock icon. The applicant `/grants` page reflects changes immediately. Use `/admin/settings` for preset/custom brand colors, the reset control, and proposed policy and Resend email configuration. The chosen accent appears on admin and applicant screens in this browser and survives reloads, but does not affect other visitors. API key, sending domain/address, receiving address, inbound webhook endpoint, and signature verification are shown as **not configured**; inbound MX is **not verified**. None are editable live email settings. No API key is collected in the public browser preview.
9. No server-side administrative change, publication, notification, or payout can occur. Decisions exist only in this browser. The admin workspace has no staff authorization or shared settings.

### Intended live journeys — design targets, not existing behavior

- **Applicant:** create/verify account → explicitly accept published policies → complete profile/required checks → view genuinely eligible grants → save draft → upload private evidence → validate and submit → track decisions and messages → receive any approved funds through a governed process.
- **Staff:** authenticate with a staff role → access only authorized records → configure and publish grant programs/policies with appropriate approvals → review submissions and supporting documents → record auditable decisions → notify applicants. Financial operations, if offered, require a separately approved operating model.
- **Exception paths:** expired sessions, incomplete verification, duplicate or ineligible applications, closed programs, missing/invalid documents, failed notifications, reviewer conflicts, and retried submissions must each have explicit user feedback and safe state recovery.

## 5. Proposed system logic and backend (not yet built)

The following is an implementation outline for planning, **not a claim that these rules or endpoints exist**.

### Application status model (implemented client-side in `src/domain/`)

`Draft → Submitted → Under review → Approved | Declined | Changes requested`, and `Changes requested → Submitted` on resubmission. Approved and Declined are final. Only the applicant moves Draft/Changes requested → Submitted; only a reviewer moves anything else. Drafts are private to the applicant. Every transition appends a history event (status, time, actor, applicant-visible note); internal notes are separate and staff-only. `updatedAt` is the record version: reviewer actions carry the version they read and fail if it changed. An approval writes the award to the application and a Completed `Grant` ledger entry for that applicant in the same step; approvals are capped by the program's remaining budget. These rules should move to the server unchanged, with the server deriving the actor from the authenticated identity.

### Program management (implemented client-side in `src/domain/programs.ts`)

Programs live in state (`state.grants`) with status `Draft → Open ⇄ Closed`. Drafts are staff-only and deletable if unused; published programs are never deleted, only closed, so history and budgets stay intact. Closing blocks new drafts and submissions but in-flight applications (including Changes requested resubmissions) continue. Validation: name 3–60 chars and unique, summary 10–200, focus 2–40, positive two-decimal amounts with minimum ≤ maximum ≤ budget, budget ≥ awarded, real ISO date (future for Open programs and for publishing), tier 1–3, 1–8 distinct requirements ≤ 80 chars. After the first submission, eligibility criteria are locked so earlier applicants aren't judged against changed rules. Each change appends to `changeLog` and bumps `updatedAt` (the version for stale-write checks).

### Notifications (implemented client-side in `src/domain/notifications.ts`)

Rules call `notify()` in the same pure step as the change they describe, so a notification exists exactly when the change happened. Each record has applicant, time, title, applicant-visible body, in-app link, and read flag. Only the owning applicant can see or mark it. In production, create notifications server-side in the same transaction as the change, then fan out to email via a queue.

### Payout processing (implemented client-side in `src/domain/payouts.ts`)

A withdrawal is a ledger entry created `Pending` with a negative amount (the full request), a `fee`, and a `destination`; the applicant receives amount − fee. Pending entries hold funds (they count against the grant balance). Finance moves a Pending entry to `Completed` (paid) or `Failed` (reason required, shown to the applicant) exactly once; `processedAt`/`processedBy` are recorded. Failed entries are excluded from balances, so the money returns automatically. In production, "paid" must come from the payment provider's confirmation (webhook) and reconciliation, not a button, and finance authority must be a separate enforced role from review.

### Identity and authorization

1. Choose one supported identity architecture before implementation; do not maintain parallel competing user identities merely because Supabase and Clerk are available in the workspace. Decide how applicant identities map to database records and whether staff identities live in the same provider.
2. Require verified sessions for applicant data APIs. Derive ownership from the verified server-side identity, never from a client-supplied user ID. Enforce server-side role/permission checks for every admin read and mutation; hiding `/admin` links is not security.
3. Define roles (for example applicant, reviewer, program manager, finance operator, administrator) and least-privilege permissions. Make grants and record visibility explicit; separate review decisions from payment authority. Add session expiry/revocation, MFA appropriate to risk, account recovery, and staff offboarding.
4. Version real terms/privacy documents and record affirmative consent with document version, timestamp, and required context. The current acknowledgement is only a demo and cannot serve as legal consent.

### Domain data and rules

- Candidate entities: user identity/profile, verification state, program and versioned eligibility/requirements, application and draft/submission versions, private document metadata, review assignment/decision/history, notification delivery, and audit event. Financial entities (balances, transactions, payment instructions) should be designed only after provider and reconciliation requirements are defined.
- Set explicit server-side state transitions for drafts, submitted applications, review, outcomes, and reversals. Validate prerequisites, deadlines, amounts, ownership, and required documents on the server. Avoid treating the preview's tiers, dates, $18,500 snapshot, or example statuses as real business rules.
- For concurrent review, use transactions, conflict protection/version checks, and an immutable audit trail of who did what and when. Mutations that can be retried should have idempotency controls.
- Keep sensitive documents in private object storage with short-lived authorized access, type/size checks, malware handling, and retention/deletion policy. Store metadata/references in the database rather than public document URLs or file bytes in ordinary records.
- For any money movement, establish a licensed provider/compliance model, authoritative ledger, reconciliation, limits, fraud checks, approvals, and failure handling **before** enabling cards, deposits, or withdrawals. Never use the preview balance or fee calculation as a source of truth.

### Service layout and API contract

The existing service is `artifacts/api-server` (Express); its only route is `/api/healthz`. `lib/api-spec/openapi.yaml` currently describes only that route. `lib/db/src/schema/` has no domain tables. `lib/api-client-react` and `lib/api-zod` are generated scaffolding, not evidence of portal integration. The React app is `artifacts/grant-user-portal` and currently renders hard-coded sample records without calling this API.

For implementation: specify and review domain contracts in OpenAPI, generate client types, add schema/migrations and server-side validation, then connect real frontend callers with loading/error/empty states and persistence across reloads. Use a single source of truth for records and status; admin and applicant views must reflect the same authorized application while enforcing different permissions. Do not merge live API data into the public admin preview until its access boundary is enforced.

### Making email and branding operational

- **Email:** Protect staff mail views and APIs before connecting Resend. Keep credentials and webhook signing material server-side; verify the sending domain and receiving domain/MX records, validate inbound webhook signatures, retrieve and persist message content, and handle duplicate webhook events safely. Only then replace fictional messages and the non-sending compose/reply preview. The current Settings checklist is not a working provider connection or webhook endpoint.
- **Branding:** The current color picker is a personal browser preview. To publish a color for all visitors, require staff authorization for writes, validate and store the choice server-side, and expose a read-only theme to the applicant and admin experiences. Include contrast checks and a rollback/reset path. Never treat local browser storage or the public `/admin` route as an authoritative brand setting.

## 6. Status and suggested delivery order

**Built:** Responsive applicant prototype with working browser-local logic (eligibility, drafts, submission and resubmission, ledger-derived balances, withdrawals, cards, profile); admin review workflow (start review, approve with award and budget checks, request changes, decline, internal notes, stale-version guard) payout processing (mark paid / failed with funds returned), grant program management (create, edit with locked criteria, publish, close, reopen, change log), and in-app applicant notifications, all sharing the same local store (saved-data migration v2 → v3 keeps visitors' work); Vitest unit tests for all domain rules; demo authentication screens and animation; admin directory, sample email inbox, grants with budget remaining, and settings with browser-only color preview; health-only API scaffold. The business rules are pure functions in `src/domain/` intended to move to the API; the storage is not production.

**Current focus:** Application logic is being built client-side first; the database and API come later (user decision, 25 Sep 2026). No production auth, domain backend, or secure admin workflow is implemented.

**Not built / next decisions and work:**

1. Agree product rules: target users/geography, actual grant programs and eligibility, application fields, reviewer permissions, policy text, data retention, and whether financial features are in scope at all.
2. Select and implement one authentication model and protected applicant/staff access; design the domain schema, privacy model, and API contracts.
3. Move the `src/domain/` rule modules (rules, review, payouts, programs, notifications) behind authorized API endpoints with persistent storage (profiles, drafts/submissions, review decisions, ledger), keeping the same state machine and stale-version checks; add private document handling and applicant notifications for review outcomes.
4. When staff access is protected, connect Resend for authorized email (including email copies of in-app notifications) and create a shared, server-backed brand setting if a site-wide color change is desired.
5. Connect the remaining UI to authorized APIs and replace samples route by route, removing misleading demo states only when the real replacement works end to end.
6. Treat payment/card/withdrawal functionality as a separate regulated phase, dependent on provider, risk, legal, and accounting decisions.

`BUILD_STATUS.md` is a short phase checklist kept in sync with this brief; this brief is the detailed source of truth.

## 7. Testing and release gates

**Current evidence:** `pnpm test` (root) runs Vitest unit tests for the domain rules: `src/domain/rules.test.ts`, `review.test.ts`, `payouts.test.ts`, `programs.test.ts`, `notifications.test.ts` (76 tests as of 26 Sep 2026, covering eligibility, validation, every allowed/forbidden transition, stale-version rejection, budget caps, ledger balances, payout idempotency, program validation/locking/status moves, notification creation and read state, and the v2 → v3 saved-data migration). Config: `artifacts/grant-user-portal/vitest.config.ts` (separate from `vite.config.ts`, which needs PORT/BASE_PATH). The UI flows (review loop, payouts, notifications bell, program create/publish/edit/close, 320px layout) were verified with a headless-browser run during development, but no end-to-end, accessibility, or security suites are committed yet. Passing TypeScript/build checks is not proof of user-flow correctness or security. Demo-only interaction checks should confirm that no control claims to perform an operation it cannot perform.

| Test area | Required coverage before live use |
| --- | --- |
| Domain rules | **In place** (`pnpm test`); extend with every new rule. Unit tests for `src/domain/rules.ts`, `review.ts`, `payouts.ts`, `programs.ts`, and `notifications.ts`: eligibility, amount/budget limits, every allowed and forbidden status transition, stale-version rejection, ledger-derived balances, ID uniqueness. |
| UI and journeys | Route smoke tests for applicant/auth/admin pages; keyboard/mobile/short-viewport checks; search/filter/empty states; form validation and step transitions; brand-color selection/reset across routes and reloads; clear error and retry states. |
| Authentication | Sign-up, verification, login, recovery, session expiry/revocation, MFA, logout, and account-switching; ensure unauthenticated requests and forged sessions fail. |
| Authorization and privacy | Applicant A cannot read/edit applicant B; reviewers see only assigned/authorized data; non-staff cannot call admin APIs even by URL; no private files accessible via guessed links; no sensitive values leaked to logs, analytics, client bundles, or exports. |
| Domain/API | Contract tests generated against actual request/response shapes; input boundaries; state-transition rules; duplicate requests; concurrent edits; idempotency; audit event completeness; failure and rollback behavior. |
| Documents | Type and size limits, private access, malware handling, expired links, deletion/retention, and inaccessible records after permission revocation. |
| Email and branding, if enabled | Reject forged/unsigned or duplicate inbound webhooks; restrict mailbox reads/sends to staff; keep secrets out of the client; verify sender/domain setup and delivery failures. Reject unauthorized or invalid brand updates; verify shared color and readable contrast across devices. |
| Finance, if enabled | Provider sandbox tests for payout success/failure/retries, ledger reconciliation, duplicate prevention, limits, approvals, and exception handling. No production funds in test environments. |
| Operational security | Threat model; dependency and static scans; security headers, CORS allowlist, rate limits, session/cookie/CSRF settings as applicable, secrets handling, logging/alerting, backup and recovery checks, and a penetration review before exposing real data. The current API uses permissive CORS and has no domain authorization. |
| Accessibility and quality | Semantic labels and status announcements; contrast and visible focus; dialog keyboard/focus behavior; reduced motion; cross-browser smoke checks; performance on mobile and slow connections. |

**Release gate:** Do not publish real applicant records or enable operational decisions on the public admin route until authentication, server-side staff authorization, private-data access checks, auditability, and automated negative-permission tests are in place. Do not present financial preview controls as real until an approved end-to-end provider and reconciliation flow has passed its own security and operational reviews.

## 8. Developer orientation

- Frontend routes and applicant pages: `artifacts/grant-user-portal/src/App.tsx`
- Business rules (pure functions, intended to move to the API): applicant `src/domain/rules.ts`, staff review `src/domain/review.ts`; types `src/domain/model.ts`; seed catalog/records `src/domain/seed.ts` (includes the demo applicant ID and demo reviewer name); browser-storage store with cross-tab sync `src/domain/store.tsx` (key `arc.fund.demoState.v2`; older v1 data is discarded)
- Payout rules: `src/domain/payouts.ts` (demo finance operator `DEMO_FINANCE` in `seed.ts`)
- Program rules: `src/domain/programs.ts` (demo program manager `DEMO_PROGRAM_MANAGER`; seed catalog via `seedGrants()`); admin screen and panel: `src/pages/AdminPrograms.tsx`
- Notifications: `src/domain/notifications.ts`; applicant bell: `src/components/NotificationsMenu.tsx`
- Saved-data shape is versioned (`version: 3`); `migrateState` in `src/domain/store.tsx` upgrades older data — add a step there whenever `DemoState` changes shape
- Admin review panel: `artifacts/grant-user-portal/src/pages/AdminReviewPanel.tsx` / `.css` (exports the shared `ReviewFrame` drawer); payouts screen and panel: `src/pages/AdminPayouts.tsx`
- Tests: `src/domain/*.test.ts`; run `pnpm test` from the root or `pnpm --filter @workspace/grant-user-portal run test`
- Sign-in/sign-up/reset preview and validation: `artifacts/grant-user-portal/src/pages/AuthPages.tsx`
- Admin workspace: `artifacts/grant-user-portal/src/pages/AdminPage.tsx` (queue, overview, and directory read the shared store; grant-program descriptions are still local); sample mailbox and configuration: `AdminInbox.tsx`, `AdminEmailSettings.tsx`; browser-only brand control: `BrandColorSettings.tsx`, `src/lib/brandColor.ts`
- Frontend styling: `artifacts/grant-user-portal/src/index.css` and the focused CSS files under `artifacts/grant-user-portal/src/pages/`
- API entry/routes: `artifacts/api-server/src/app.ts`, `src/routes/`
- API source of truth: `lib/api-spec/openapi.yaml`; data schema location: `lib/db/src/schema/`
- Workspace commands: `pnpm run typecheck` and `pnpm run build`; portal-specific: `pnpm --filter @workspace/grant-user-portal run typecheck` and `pnpm --filter @workspace/grant-user-portal run build`.

The Vite app uses Wouter for client-side routing and a configured artifact base path; the API is mounted at `/api`. Confirm routing and production environment behavior before adding network calls. Never infer functionality from a styled control, installed dependency, configured integration, or example number: trace the actual request, server authorization, persistence, and visible result.