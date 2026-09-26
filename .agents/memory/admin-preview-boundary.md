---
name: Admin preview boundary
description: Why the admin workspace may act on browser-local demo data but must not touch real applicant data until protected workflows exist.
---

The admin workspace has no staff sign-in or authorization. Since 25–26 Sep 2026 it runs working review, payout-processing, and grant-program-management workflows (and creates applicant notifications), but only against fictional demo records stored in the viewer's own browser, shared with the applicant portal through `src/domain/store.tsx`. Keep the preview labels and the review panel's "browser only / no staff authorization" note. Do not infer permission from visiting the admin URL or from a browser-only flag.

**Why:** The user asked to build the app logic before the database and auth. Local-only fictional data exposes nobody. Real applicant records behind an unprotected `/admin` would cross the agreed scope and risk exposing private information.

**How to apply:** When moving review to the API, enforce authenticated staff authorization at the API boundary and derive the reviewer from the session (not the `DEMO_REVIEWER` constant) before any real records are loaded. Keep the preview labels until the real workflow exists end to end.
