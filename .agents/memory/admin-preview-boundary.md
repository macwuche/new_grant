---
name: Admin preview boundary
description: Why the grant portal admin workspace must remain a sample-data preview until protected workflows are built.
---

The admin experience is intentionally a UI-only preview, not a real staff portal. Keep sample records clearly labeled and read-only until staff roles, server-side authorization, and private applicant data handling are in place. Do not infer permission from visiting the admin URL or from a browser-only flag.

**Why:** The user asked to build out the admin UI now and work on its real behavior later. The applicant side is also a demo, so showing real records in an unprotected admin view would cross the agreed scope and risk exposing private information.

**How to apply:** When connecting admin screens to data or decisions later, add authenticated staff authorization at the API boundary before replacing sample records; preserve the UI's explicit preview labels until the real workflow exists.