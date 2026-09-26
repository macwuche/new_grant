---
name: Admin preview boundary
description: Why the admin workspace may act on browser-local demo data but must not touch real applicant data until protected workflows exist.
---

The admin workspace has no staff sign-in. Since 25–26 Sep 2026 it runs working review, deposit and payout processing, money settings, grant-program management, identity checks, account controls, lockdown, and an audit log, but only against fictional demo records stored in the viewer's own browser, shared with the applicant portal through `src/domain/store.tsx`. Staff roles are enforced by `asStaff` in `src/domain/staff.ts`, but the "Acting as" switcher lets anyone pick any staff member, so role checks demonstrate the rules and are not a security boundary. Keep the preview labels and the "no real staff sign-in" notes. Do not infer permission from visiting the admin URL, from a browser-only flag, or from the demo role switcher.

**Why:** The user asked to build the app logic before the database and auth. Local-only fictional data exposes nobody. Real applicant records behind an unprotected `/admin` would cross the agreed scope and risk exposing private information.

**How to apply:** When moving these rules to the API, derive the staff member and role from the authenticated session (replacing `state.actingStaffId` and the switcher), enforce `ROLE_PERMISSIONS` server-side, and write audit entries server-side in the same transaction before any real records are loaded. Keep the preview labels until the real workflow exists end to end.
