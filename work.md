# arc.fund — project brief and implementation handoff

**Status:** UI prototype; not a live grant, identity, or financial system  
**Last reviewed:** 25 September 2026  
**Audience:** Product designers, frontend/backend developers, QA, and security reviewers

## 1. Purpose and product boundary

arc.fund is a proposed grant-funding workspace with two experiences: an **applicant portal** for discovering grant programs, preparing applications, and understanding account activity; and an **admin workspace** for a future staff team to manage programs and review requests. The product aims to make eligibility, application progress, and funding activity understandable without losing the trust and controls required for sensitive applicant data and money movement.

**Today, both experiences are illustrative.** The applicant portal and `/admin` use fictional, locally defined records. No visitor is authenticated, no application or document is stored, no grant is awarded, and no card, deposit, or payout is issued. The admin preview is reachable by URL without staff authorization because it contains no real records or operations. **Do not connect real applicant data to this route until server-side staff authorization and privacy controls exist.**

The current objective is to establish and iterate on the interface. A production implementation requires decisions on policies, identity, eligibility, data ownership, review governance, and any regulated financial partners before operational logic is enabled.

## 2. What exists now

| Area | Implemented UI / local behavior | Not implemented |
| --- | --- | --- |
| Applicant access | Sign-in, four-step sign-up, password-reset screens; local form validation and feedback. Sign-up plays an illustrative matching animation, then navigates to the demo dashboard after roughly four seconds. | Accounts, login sessions, email or code delivery/verification, actual grant matching, password reset, real consent recording. |
| Applicant dashboard | Sample eligibility, balances, application pulse, card, and activity with demo labels. | Personalized data or computed balances/eligibility. |
| Grant discovery | Four example programs, tier filter, requirements/deadlines, navigation to an application preview. | Published program catalog, live availability, actual eligibility evaluation. |
| Applications | Sample list with status filters; three-step Basics → Requirements → Review form. | Draft persistence, file upload, submission, status updates, reviewer decisions, notifications. The “Choose file” and “Preview submission” controls are demonstrative. |
| Cards and transactions | Example cards, local reveal/freeze/request states; searchable/filterable sample ledger. Export downloads a text file explicitly marked demo-only. | Card issuance or management, real transaction history, accounting, meaningful export. |
| Withdrawals | Example amount, payout destination selector, illustrative fee preview and read-only confirmation. | Bank/mobile-money integration, payment requests, balance holds, ledger entries, payouts. The displayed 1.25% fee capped at $14 is **demo math**, not an approved commercial rule. |
| Applicant settings | Local profile editing, example verification/tier, two-step-sign-in toggle. | Persisted profile, KYC/identity checks, actual MFA/security settings. |
| Admin `/admin` | Overview, applicant directory, application review queue, grant programs, and settings. Fictional records, local search/status filters, responsive mobile cards, and read-only detail panels. Persistent preview notice. | Staff accounts/roles, real applicant data, review decisions, program changes, policies, payouts, audit history. The admin settings page describes future configuration but has no live controls. |
| API / data | Express server with `GET /api/healthz` returning `{ "status": "ok" }`; OpenAPI and generated client/schema scaffolding; PostgreSQL/Drizzle connection package. | Domain API endpoints, database tables/migrations, real persistence, authorization middleware, app-to-API integration. |

The workspace has a Supabase connection available for future work, but this app does not use it yet. Clerk-related configuration is present in the environment, but the frontend and API do not currently use Clerk. **Configured integrations and installed packages are not evidence of operational authentication, storage, or security.**

## 3. Design specification

### Visual language

- **Brand:** `arc.fund` wordmark, a small rotated `a` mark, charcoal navigation, lime accents, restrained status colors, and soft light surfaces. The applicant layout has a dark vertical sidebar and light content area; the admin workspace uses a related charcoal sidebar with warm paper-like panels.
- **Typography:** DM Sans for body/UI, Space Grotesk for headings and prominent numbers; a monospace face for reference-like details. These are defined in `artifacts/grant-user-portal/src/index.css`.
- **Hierarchy:** Clear page title and context; compact metric cards and status badges; section cards for forms, queues, and supporting information. Use plain-language microcopy to explain eligibility, progress, and the consequence of actions.
- **Interaction:** Local filters/search update immediately; navigational links lead to the appropriate preview; detail views are read-only. Provide explicit empty states and feedback. Avoid approve, pay, upload, or publish affordances that imply a real operation until the backend is ready.
- **Trust signals:** Demo labels must remain visible wherever the experience could be mistaken for a live account, legal consent, verification, grant decision, or money movement. Do not show real personal data in the public preview.
- **Responsive behavior:** The applicant sidebar adapts to viewport height without independently scrolling. On smaller screens, navigation and content reflow; the admin uses a bottom navigation bar and compact record cards for applicants/applications. Test widths down to the site's 320px minimum as well as short desktop viewports.
- **Accessibility baseline:** Semantic headings, labeled inputs and controls, keyboard-reachable navigation, visible focus, readable status text (not color alone), and reduced-motion handling. For future live dialogs, verify focus trapping and focus restoration rather than assuming visual presentation provides accessible modal behavior.

Current styling lives in `src/index.css`, `src/pages/AuthPages.css`, and `src/pages/AdminPage.css` under `artifacts/grant-user-portal/`. The admin CSS is scoped to its shell so applicant screens retain their own styles. Page titles and description/social metadata update per route in `src/App.tsx`.

### Language and content rules

Amounts, deadlines, tiers, statuses, identities, bank details, and sample program descriptions are illustrative, not policy or product commitments. The sign-up industry options are examples; the real option set, terms, privacy policy, and retention rules must be supplied and approved before collecting real information. The current matching animation is visual only, not a recommendation engine.

## 4. User journeys

### Applicant: explore without an account — working preview

1. Visit `/` or `/dashboard` directly; no authentication gate currently exists.
2. Inspect sample eligibility and activity, then open `/grants`; filter example programs by tier.
3. Select **Check eligibility** to visit `/applications/new/:grantId`; complete Basics, inspect illustrative requirements, and review the entered values.
4. Select **Preview submission**. A message confirms that no application was sent or saved. Navigating away loses the form state.
5. Use `/applications` to browse predefined example statuses, not the form just completed. Other sidebar destinations show demonstration-only financial/profile information.

### Applicant: account preview — working UI, no identity operation

1. `/signup` collects account fields with local validation (including password confirmation), then contact/country/sector/date-of-birth fields and acknowledgement that policy documents are placeholders.
2. The email step shows a code input solely for visual preview: no code is sent or checked, and it can be skipped.
3. The matching animation plays; after about four seconds the browser goes to `/dashboard`. This is **navigation, not sign-in**.
4. `/login` locally validates a nonempty password and email and then displays preview feedback; `/forgot-password` locally validates an email and displays preview feedback. Neither sends a request or creates a session.

### Staff: admin preview — working UI, no staff access

1. Visit `/admin` directly for an overview of fictional metrics and a sample review queue.
2. Navigate to `/admin/applicants` or `/admin/applications`; search/filter and open a read-only record preview. These records are **not** the applicant portal's local sample applications or real users.
3. Inspect `/admin/grants` for example program cards and `/admin/settings` for proposed locations of policy, sector, review-stage, and criteria controls.
4. No administrative change, approval, publication, or payout can occur. The preview notice explains that authorization and persistence are absent.

### Intended live journeys — design targets, not existing behavior

- **Applicant:** create/verify account → explicitly accept published policies → complete profile/required checks → view genuinely eligible grants → save draft → upload private evidence → validate and submit → track decisions and messages → receive any approved funds through a governed process.
- **Staff:** authenticate with a staff role → access only authorized records → configure and publish grant programs/policies with appropriate approvals → review submissions and supporting documents → record auditable decisions → notify applicants. Financial operations, if offered, require a separately approved operating model.
- **Exception paths:** expired sessions, incomplete verification, duplicate or ineligible applications, closed programs, missing/invalid documents, failed notifications, reviewer conflicts, and retried submissions must each have explicit user feedback and safe state recovery.

## 5. Proposed system logic and backend (not yet built)

The following is an implementation outline for planning, **not a claim that these rules or endpoints exist**.

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

## 6. Status and suggested delivery order

**Built:** Responsive applicant prototype; demo authentication screens and animation; UI-only admin overview, directory, queue, grants, and settings; health-only API scaffold. These are interfaces, not completed product workflows.

**Current focus:** The two visual workspaces are available for design review and iteration. This brief captures the gap between that UI and an operational platform. No production auth, domain backend, or secure admin workflow is currently implemented.

**Not built / next decisions and work:**

1. Agree product rules: target users/geography, actual grant programs and eligibility, application fields, reviewer permissions, policy text, data retention, and whether financial features are in scope at all.
2. Select and implement one authentication model and protected applicant/staff access; design the domain schema, privacy model, and API contracts.
3. Implement persistent profiles, drafts/submissions, private document handling, and staff review with auditable decisions and notifications.
4. Connect the existing UI to authorized APIs and replace samples route by route, removing misleading demo states only when the real replacement works end to end.
5. Treat payment/card/withdrawal functionality as a separate regulated phase, dependent on provider, risk, legal, and accounting decisions.

`BUILD_STATUS.md` is an older planning snapshot and still says the admin UI has not started. The **current source code and this brief** reflect that the admin *preview UI* has since been built; its real operations remain unbuilt.

## 7. Testing and release gates

**Current evidence:** The repository has typecheck and build scripts, but no application unit, integration, end-to-end, accessibility, or security test suites were found. Passing TypeScript/build checks is not proof of user-flow correctness or security. Demo-only interaction checks should confirm that no control claims to perform an operation it cannot perform.

| Test area | Required coverage before live use |
| --- | --- |
| UI and journeys | Route smoke tests for applicant/auth/admin pages; keyboard/mobile/short-viewport checks; search/filter/empty states; form validation and step transitions; save/reload behavior when persistence is introduced; clear error and retry states. |
| Authentication | Sign-up, verification, login, recovery, session expiry/revocation, MFA, logout, and account-switching; ensure unauthenticated requests and forged sessions fail. |
| Authorization and privacy | Applicant A cannot read/edit applicant B; reviewers see only assigned/authorized data; non-staff cannot call admin APIs even by URL; no private files accessible via guessed links; no sensitive values leaked to logs, analytics, client bundles, or exports. |
| Domain/API | Contract tests generated against actual request/response shapes; input boundaries; state-transition rules; duplicate requests; concurrent edits; idempotency; audit event completeness; failure and rollback behavior. |
| Documents | Type and size limits, private access, malware handling, expired links, deletion/retention, and inaccessible records after permission revocation. |
| Finance, if enabled | Provider sandbox tests for payout success/failure/retries, ledger reconciliation, duplicate prevention, limits, approvals, and exception handling. No production funds in test environments. |
| Operational security | Threat model; dependency and static scans; security headers, CORS allowlist, rate limits, session/cookie/CSRF settings as applicable, secrets handling, logging/alerting, backup and recovery checks, and a penetration review before exposing real data. The current API uses permissive CORS and has no domain authorization. |
| Accessibility and quality | Semantic labels and status announcements; contrast and visible focus; dialog keyboard/focus behavior; reduced motion; cross-browser smoke checks; performance on mobile and slow connections. |

**Release gate:** Do not publish real applicant records or enable operational decisions on the public admin route until authentication, server-side staff authorization, private-data access checks, auditability, and automated negative-permission tests are in place. Do not present financial preview controls as real until an approved end-to-end provider and reconciliation flow has passed its own security and operational reviews.

## 8. Developer orientation

- Frontend routes and applicant sample data: `artifacts/grant-user-portal/src/App.tsx`
- Sign-in/sign-up/reset preview and validation: `artifacts/grant-user-portal/src/pages/AuthPages.tsx`
- Admin preview and independent sample data: `artifacts/grant-user-portal/src/pages/AdminPage.tsx`
- Frontend styling: `artifacts/grant-user-portal/src/index.css`, `artifacts/grant-user-portal/src/pages/AuthPages.css`, `artifacts/grant-user-portal/src/pages/AdminPage.css`
- API entry/routes: `artifacts/api-server/src/app.ts`, `src/routes/`
- API source of truth: `lib/api-spec/openapi.yaml`; data schema location: `lib/db/src/schema/`
- Workspace commands: `pnpm run typecheck` and `pnpm run build`; portal-specific: `pnpm --filter @workspace/grant-user-portal run typecheck` and `pnpm --filter @workspace/grant-user-portal run build`.

The Vite app uses Wouter for client-side routing and a configured artifact base path; the API is mounted at `/api`. Confirm routing and production environment behavior before adding network calls. Never infer functionality from a styled control, installed dependency, configured integration, or example number: trace the actual request, server authorization, persistence, and visible result.