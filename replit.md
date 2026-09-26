# arc.fund

A grant-funding workspace: an applicant portal to find programs, apply, and manage deposits and payouts, and an admin workspace for staff to manage programs, review applications, and process money. Detailed brief: `work.md`; phase checklist: `BUILD_STATUS.md`.

## Run & Operate

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm test` — rule tests (`lib/domain`) and API tests (`artifacts/api-server`)
- `pnpm run build` — typecheck + build all packages (the portal build needs `PORT` and `BASE_PATH`)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push schema changes (to Supabase when `SUPABASE_DATABASE_URL` is set, otherwise Replit's database; it prints which)
- Environment:
  - Server: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DATABASE_URL` (secret), `INITIAL_SUPER_ADMIN_EMAIL`; optional `INITIAL_SUPER_ADMIN_NAME`, `CORS_ORIGINS`, `TRUST_PROXY_HOPS`, `DOCUMENTS_DIR` (where uploaded files are kept; default `data/documents` under the API's working directory)
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
- Portal pages: `artifacts/grant-user-portal/src/App.tsx` (applicant), `src/pages/Admin*.tsx` (staff); server data and sync: `src/lib/serverData.tsx`, `lib/domain/src/sync.ts`
- Theme: `artifacts/grant-user-portal/src/index.css`

## Architecture decisions

- The same pure rule functions run in the browser demo and on the server; the server loads records, runs the rule, and stores what changed plus its notifications, feed items, and audit entry in one transaction.
- Concurrency uses Postgres advisory locks (per program; per applicant for money; system-wide for settings and lockdown) plus version checks (409 on stale edits).
- Every table has row-level security on with no policies, so Supabase's public REST API can't reach it; only the API (table owner) reads and writes.
- The audit log is append-only and hash-chained; the API reports whether the chain is intact.
- Uploaded documents are files on the API server's disk (`DOCUMENTS_DIR`), never in Supabase Storage; Supabase holds only their records and SHA-256, checked on every download. Back up that directory with the database.
- Server-loaded records are never written to browser storage.

## Product

Applicants: sign up, verify identity (details plus an uploaded document, reviewed by compliance), upload a file for each application requirement, apply to programs, track reviews, add funds, request payouts, manage fictional cards. Staff: role-based access (super admin, reviewer, finance, compliance, support), program management, review with escalation, account controls, deposits and payouts with two-person sign-off, money settings, emergency lockdown, team activity, audit log. No payment provider, card network, or email is connected.

## User preferences

- Build in slices; commit each finished slice when asked, with a clear message.
- Keep `work.md` and `BUILD_STATUS.md` up to date with what was built and verified.

## Gotchas

- New tables must call `.enableRLS()`.
- `jsonb` reorders object keys, and Postgres timestamps have microseconds: storage code rebuilds nested objects in the domain's key order and compares versions at millisecond precision.
- An empty `description:` in the OpenAPI spec makes orval fail and empty the generated folders.
- The app currently can't see its Supabase settings; add them under Tools → Secrets in this workspace and restart (see `work.md` §6).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
