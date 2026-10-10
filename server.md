# Server & deployment runbook

How the grant portal (applicant portal + admin + API) is deployed to our VPS, step by step.
The owner runs every command on the server; paste the output of the **check** steps back so the "Server inventory" and "Decisions" sections can be filled in.

> **Status (28 Sep 2026): LIVE** at https://access.novabridgegrant.org — on the new VPS `77.68.98.14`, behind Cloudflare, HTTPS by Let's Encrypt, super admin signed in.
> **Auth emails work through our own system (evening of 28 Sep 2026):** Supabase's Send Email Hook is on, our server writes every sign-up, reset and sign-in email and **Resend** sends it from `novabridgegrant.org`. Supabase stores the data and sends no email (owner's rule). Cloudflare's **Bot Fight Mode is off**, because it was blocking Supabase's calls to the hook (the "hook: 403" sign-up error). Full story: "Auth emails — what happened on 28 Sep and why" under Step 11b.
> Still open: confirm the Supabase URL settings, the app name and the Resend webhook; the applicant smoke test; backups; rotating the secrets that were typed into the chat — see "Status" below.

> **Server history:** we started on a shared VPS (`195.20.255.153`), got as far as cloning, then moved to a **new, empty VPS** on 27 Sep 2026.
> Everything we put on the old server was removed and verified — see "Old server — retired" at the end.

> **Rule for shared servers:** (applied on the old server; the new VPS runs nothing else, but we kept the habit) Nothing below edits, restarts, or replaces anything that belongs to another app.
> We only *add* things: our own folder, our own Node.js, our own systemd service, our own nginx site file.
> nginx is only ever **reloaded** (never restarted) and only after `nginx -t` passes.

## Working on the server from Windows PowerShell (read this first)

The owner runs every command over `ssh root@77.68.98.14` from Windows PowerShell. What we learned the hard way on 27 Sep:

- **Copying from the Claude Code terminal wraps long lines**, and the wrap breaks are copied as real line breaks. Long or multi-line commands then fall apart (half-commands, `command not found`, a stray `>` that truncated the env file once). **Keep every command short (under ~90 characters) and paste one line at a time**, waiting for the prompt before the next.
- **Each right-click pastes again** — double clicks produced duplicate lines. Commands that append (`>>`) are made safe with a dedupe afterwards (`sort -u -o $F $F`), or replaced by commands that are safe to repeat.
- A `>` prompt means the shell is waiting for a closing quote: press **Ctrl+C**.
- Placeholders get pasted literally (`your-password`, `REAL-PASSWORD`, `aws-0-xxxx`). Give real values, or tell the owner to type that line by hand.
- Anything longer than a few lines (service file, nginx site, build) goes **into the repo** (`deploy/`), and the server only runs `git pull`, `cp`, or `sh`.
- On this server `sudo -E` is refused ("preserving the entire environment is not supported") — pass variables with `sudo --preserve-env=VAR1,VAR2 …` and set `PATH` with `env PATH=$PATH`.

## Target

| Item | Value |
|---|---|
| Public address | https://access.novabridgegrant.org/ |
| VPS | `77.68.98.14` (IONOS, UK) — `ssh root@77.68.98.14`; old server `195.20.255.153` retired |
| App folder | `/var/www/novabridgegrant` |
| Private Node.js 24 | `/opt/novabridgegrant-node` (does not touch the system `node` the other app may use) |
| Secrets file | `/etc/novabridgegrant/api.env` (mode `600`, never in git or in this file) |
| Uploaded documents | `/var/lib/novabridgegrant/documents` |
| API service | systemd unit `novabridgegrant-api`, listening on `127.0.0.1:3100` |
| nginx site | `/etc/nginx/sites-available/novabridgegrant` → symlinked into `sites-enabled` |
| DNS / proxy | Cloudflare in front of the VPS |
| Database | Supabase Postgres (hosted, not on the VPS); project `tynjqjukramcmtotgfdw`, session pooler `aws-1-eu-west-1.pooler.supabase.com:5432`, user `postgres.tynjqjukramcmtotgfdw` |
| Email | Resend (API key is saved in the admin settings, not in the env file) |
| Code | `https://github.com/macwuche/new_grant`, branch `main` (deployed: `91074ee`; see Status) |
| Deploy files | `deploy/novabridgegrant-api.service`, `deploy/nginx-novabridgegrant.conf`, `deploy/build.sh` (in the repo) |
| TLS | Let's Encrypt certificate from certbot, renewed automatically by `certbot.timer`; Cloudflare SSL mode Full (strict) |

### How it fits together

```
Browser ─▶ Cloudflare ─▶ nginx :80/:443 (server_name access.novabridgegrant.org)
                           ├─ /api/*  ─▶ 127.0.0.1:3100  (node, systemd: novabridgegrant-api)
                           └─ /*      ─▶ /var/www/novabridgegrant/artifacts/grant-user-portal/dist/public (static, SPA fallback)
```

nginx picks the site by `server_name` (on a shared server it shares 80/443 with the other apps), so nginx itself doesn't need a new port.
Only the **API** needs a free local port, and that port is bound to `127.0.0.1` so it is never exposed to the internet.

---

## Step 0 — Put the latest code on GitHub (in the Replit workspace, not the server)

**Done on 27 Sep 2026** — GitHub `main` is at `b930d1c`. For the record, this is what was run:

```bash
git checkout main
git merge --ff-only money-flows
git push origin main
```

The repo is private, so the server needs read access. Pick one:
- **Deploy key (recommended):** step 4 generates a key on the server; add the public key at GitHub → repo → Settings → Deploy keys (read-only).
- **Personal access token:** clone with `https://<token>@github.com/macwuche/new_grant.git` (the token then sits in `.git/config`; less tidy).

## Step 1 — Log in and look around (read-only)

```bash
ssh root@77.68.98.14
```

```bash
# System
hostnamectl; df -h; free -h; nproc
# Software already there
node -v; npm -v; pnpm -v; pm2 -v; git --version; nginx -v; certbot --version
# What's running
systemctl list-units --type=service --state=running --no-pager
pm2 ls 2>/dev/null; docker ps 2>/dev/null
# nginx sites and what they answer for
ls -la /etc/nginx/sites-enabled/ /etc/nginx/conf.d/
grep -rn "server_name\|listen\|proxy_pass\|root \|ssl_certificate " /etc/nginx/sites-enabled/ /etc/nginx/conf.d/
# Certificates and firewall
ls /etc/letsencrypt/live/ 2>/dev/null
ufw status verbose 2>/dev/null
# Make sure our names aren't taken
ls -d /var/www/novabridgegrant /etc/novabridgegrant /opt/novabridgegrant-node 2>&1
systemctl status novabridgegrant-api --no-pager 2>&1 | head -3
```

Stop and check before going on if: any `novabridgegrant` path already exists, or an nginx `server_name` already lists `access.novabridgegrant.org` (that file belongs to the other app — we'd need to decide together how to move it).

## Step 1b — Prepare the fresh server (new VPS only)

The new VPS is empty: no nginx, certbot, or swap. Add them first.

```bash
# 2 GB swap so the build doesn't run out of memory
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
swapon --show; free -h

# Pending updates, then nginx and certbot
apt update && apt -y upgrade
apt -y install nginx certbot python3-certbot-nginx
nginx -v; certbot --version
systemctl is-active nginx          # → active
curl -sI http://127.0.0.1/ | head -1   # → HTTP/1.1 200 OK (nginx's default page)
```

If `apt upgrade` says a reboot is needed (`ls /var/run/reboot-required`), run `reboot`, wait a minute, and log in again.

## Step 2 — Find a free port for the API

```bash
ss -tlnp                      # everything currently listening
for p in $(seq 3100 3199); do
  ss -tln "( sport = :$p )" | grep -q LISTEN || { echo "Free port: $p"; break; }
done
```

On the new VPS the port is **3100**, and it is written into `api.env` (`PORT`), `deploy/build.sh`, and `deploy/nginx-novabridgegrant.conf`. If you ever pick a different port, change all three.
To make the rest copy-pasteable, set it in your shell (redo this if you log in again):

```bash
export API_PORT=3100
```

## Step 3 — Install Node.js 24 + pnpm, privately

This goes into its own folder, so the system `node` (and the other app) is untouched.

```bash
cd /tmp
NODE_VER=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -oE 'node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz' | head -1)
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$NODE_VER"
mkdir -p /opt/novabridgegrant-node
tar -xJf "$NODE_VER" -C /opt/novabridgegrant-node --strip-components=1
rm "$NODE_VER"

export PATH=/opt/novabridgegrant-node/bin:$PATH
node -v                                   # → v24.x
npm install -g pnpm@10                    # installs into /opt/novabridgegrant-node only
pnpm -v
```

Every later step that runs `node`/`pnpm` assumes this `export PATH=...` is active in your shell.

## Step 4 — Create the folder and pull the app

```bash
# A system user that owns and runs the app (not root)
id novabridgegrant 2>/dev/null || useradd --system --create-home --home-dir /home/novabridgegrant --shell /usr/sbin/nologin novabridgegrant

mkdir -p /var/www/novabridgegrant
chown novabridgegrant:novabridgegrant /var/www/novabridgegrant
```

**With a deploy key** (recommended):

```bash
sudo -u novabridgegrant mkdir -p /home/novabridgegrant/.ssh
sudo -u novabridgegrant ssh-keygen -t ed25519 -N "" -C "novabridgegrant-deploy" -f /home/novabridgegrant/.ssh/id_ed25519
cat /home/novabridgegrant/.ssh/id_ed25519.pub
# → paste this into GitHub → macwuche/new_grant → Settings → Deploy keys → Add (read-only)

sudo -u novabridgegrant ssh -o StrictHostKeyChecking=accept-new -T git@github.com   # "successfully authenticated" = OK
sudo -u novabridgegrant git clone git@github.com:macwuche/new_grant.git /var/www/novabridgegrant
```

**Or with a token:**

```bash
sudo -u novabridgegrant git clone https://<token>@github.com/macwuche/new_grant.git /var/www/novabridgegrant
```

Then:

```bash
cd /var/www/novabridgegrant && sudo -u novabridgegrant git log --oneline -1   # should match the latest commit you pushed
```

## Step 5 — Secrets file and data folders

```bash
mkdir -p /etc/novabridgegrant /var/lib/novabridgegrant/documents
chown -R novabridgegrant:novabridgegrant /var/lib/novabridgegrant
chmod 700 /var/lib/novabridgegrant
```

The env file ends up with these 13 lines (order doesn't matter):

```ini
NODE_ENV=production
PORT=3100
APP_URL=https://access.novabridgegrant.org
CORS_ORIGINS=https://access.novabridgegrant.org
TRUST_PROXY_HOPS=2                      # Cloudflare → nginx → API
SUPABASE_URL=https://tynjqjukramcmtotgfdw.supabase.co
SUPABASE_ANON_KEY=sb_publishable_9TfKJrlrzqYmtZBnwUdibw_g2wPKQS8
SUPABASE_DATABASE_URL=postgresql://postgres.tynjqjukramcmtotgfdw:<password>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres
INITIAL_SUPER_ADMIN_EMAIL=info@novabridgegrant.org
INITIAL_SUPER_ADMIN_NAME="Super admin"  # quoted: the space breaks `. api.env` in a shell
STAFF_MFA_REQUIRED=false
DOCUMENTS_DIR=/var/lib/novabridgegrant/documents
SETTINGS_ENCRYPTION_KEY=<openssl rand -base64 32>
```

(The `#` comments above are notes for this file only — don't put them in `api.env`.)

- **`SUPABASE_DATABASE_URL` must be the Session pooler string** (Supabase → Connect → Session pooler; host `aws-1-eu-west-1.pooler.supabase.com`, user `postgres.tynjqjukramcmtotgfdw`). The "Direct connection" host `db.<ref>.supabase.co` is IPv6-only and this VPS has no IPv6. A password containing `@ # / ? % '` must be URL-encoded.
- **`SETTINGS_ENCRYPTION_KEY`: back it up** (password manager). Losing it means every secret saved in the admin settings (e.g. the Resend key) must be entered again. View it on the server with `grep SETTINGS /etc/novabridgegrant/api.env`.

How it was written (short lines, safe to paste from PowerShell):

```bash
F=/etc/novabridgegrant/api.env
echo 'NODE_ENV=production' >> $F
echo 'PORT=3100' >> $F
# … one echo per line above …
echo "SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> $F
sort -u -o $F $F                                   # drops lines pasted twice

# Database line, built in short pieces (safe to redo: the sed removes the old line)
sed -i '/^SUPABASE_DATABASE_URL=/d' $F
P='<database password>'
H='aws-1-eu-west-1.pooler.supabase.com'
U="postgresql://postgres.tynjqjukramcmtotgfdw:$P@$H"
echo "SUPABASE_DATABASE_URL=$U:5432/postgres" >> $F
unset P U

chown root:novabridgegrant $F
chmod 640 $F
sed -E 's/(KEY|URL)=.*/\1=<set>/' $F | cat -n     # check without showing secrets: 13 lines
```

To change one value later (e.g. the database password): redo the database-line block, then `systemctl restart novabridgegrant-api`.

## Step 6 — Install and build

```bash
cd /var/www/novabridgegrant
sh deploy/build.sh          # ends with "Build OK"
```

`deploy/build.sh` (in the repo) does, as the `novabridgegrant` user:
- `pnpm install --frozen-lockfile`;
- builds **only** the two apps we deploy, one at a time under `nice`: `@workspace/api-server` (esbuild → `artifacts/api-server/dist/index.mjs`) and `@workspace/grant-user-portal` (vite → `artifacts/grant-user-portal/dist/public/`). It skips the root `pnpm run build`, whose type check (`tsc`) is the memory hog and already runs in Replit. The libs under `lib/` export TypeScript source, so they need no build;
- passes the portal's build settings with `sudo --preserve-env` (`sudo -E` is refused on this server): `NODE_ENV=production PORT=3100 BASE_PATH=/ VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=…` — vite's config refuses to load without `PORT`;
- makes `dist` readable for nginx.

On the first deploy (27 Sep) the same thing was run by hand: install took 16 s (503 packages), the API build ~1 s, the portal build ~16 s. The warnings "Error when using sourcemap for reporting an error" (label.tsx) and "Some chunks are larger than 500 kB" are harmless.

## Step 7 — Push the database schema to Supabase (first deploy, and after schema changes)

Adds the tables/columns that so far exist only in Replit's database (`replit.md` → Gotchas).

```bash
cd /var/www/novabridgegrant
export PATH=/opt/novabridgegrant-node/bin:$PATH
set -a; . /etc/novabridgegrant/api.env; set +a
pnpm -F @workspace/db run push     # should print "using the supabase database (aws-1-eu-west-1.pooler.supabase.com)"
```

First run (27 Sep): "Pulling schema from database… Changes applied", no prompts. This also proved the pooler string and password work.

If it asks about **dropping or renaming** anything, answer no and stop — send the output back first.

## Step 8 — Run the API as a service

The unit file is in the repo: `deploy/novabridgegrant-api.service`.

```bash
cd /var/www/novabridgegrant
cp deploy/novabridgegrant-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now novabridgegrant-api
systemctl status novabridgegrant-api --no-pager
curl -s http://127.0.0.1:3100/api/healthz; echo       # expect an ok response
journalctl -u novabridgegrant-api -n 50 --no-pager    # logs, if anything is wrong
```

## Step 9 — nginx site (HTTP first)

The site file is in the repo: `deploy/nginx-novabridgegrant.conf` (API port 3100 is written into it).

```bash
cd /var/www/novabridgegrant
cp deploy/nginx-novabridgegrant.conf /etc/nginx/sites-available/novabridgegrant
ln -s /etc/nginx/sites-available/novabridgegrant /etc/nginx/sites-enabled/novabridgegrant
rm -f /etc/nginx/sites-enabled/default      # new VPS only: nginx's welcome page, nothing else uses it

# nginx runs as www-data and must be able to read the built files
chmod o+x /var/www/novabridgegrant /var/www/novabridgegrant/artifacts /var/www/novabridgegrant/artifacts/grant-user-portal
chmod -R o+rX /var/www/novabridgegrant/artifacts/grant-user-portal/dist

nginx -t && systemctl reload nginx        # only reload if the test passes
curl -s -H "Host: access.novabridgegrant.org" http://127.0.0.1/api/healthz; echo
curl -sI -H "Host: access.novabridgegrant.org" http://127.0.0.1/ | head -5
```

Once certbot has added HTTPS (step 10), the installed copy differs from the repo file — don't copy the repo file over it again without re-running certbot.

If `nginx -t` fails: `rm /etc/nginx/sites-enabled/novabridgegrant` and send the error — the other app keeps running because nginx was never reloaded.

Also check the other app still answers exactly as before (use its own domain): `curl -sI https://<other-app-domain> | head -3`.

## Step 10 — DNS and HTTPS

What was done (27 Sep 2026), in this order:

1. **Cloudflare DNS:** `access` → `A` → `77.68.98.14`, set to **DNS only (grey cloud)** so Let's Encrypt reaches the server directly. No `AAAA` record (the VPS has no IPv6).
2. **Certificate:**
   ```bash
   certbot --nginx -d access.novabridgegrant.org
   ```
   It asks for an email (used only for expiry warnings — `ovundahben@gmail.com` was given), terms (**Y**), and EFF sharing (**N**). certbot added the HTTPS server block and an HTTP→HTTPS redirect to `/etc/nginx/sites-enabled/novabridgegrant` and reloaded nginx. Certificate: `/etc/letsencrypt/live/access.novabridgegrant.org/`, expires 2026-12-26, renewed automatically by `certbot.timer`.
3. **Cloudflare:** `access` switched back to **Proxied (orange cloud)**; **SSL/TLS → Overview → Full (strict)**.
4. Checked from outside: `https://access.novabridgegrant.org/` 200, `/login` 200, `/api/healthz` `{"status":"ok"}`, `http://` → 301 to `https://`; through Cloudflare's edge: HTTP/2 200 with `server: cloudflare`.

Note: after certbot, the installed nginx file differs from `deploy/nginx-novabridgegrant.conf` (it has the 443 block). Don't copy the repo file over it again unless you re-run certbot straight after.

Renewal behind the orange cloud: certbot renews with an HTTP challenge on port 80, which Cloudflare passes through. If a renewal ever fails (`certbot renew --dry-run` to test), switch `access` to grey, run `certbot renew`, and switch back.

## Step 11 — Outside services and the first super admin

**First super admin.** On start, the API adds `INITIAL_SUPER_ADMIN_EMAIL` as a super admin **only if `staff_members` is empty**. A staff record is linked to a Supabase login on that person's first sign-in, and only once their email is **confirmed**.
On 27 Sep the Supabase database already held a super admin from earlier setup (`benmacwuche+newnovabridgegrant@gmail.com`, never signed in), so the seed was skipped and `info@novabridgegrant.org` saw "isn't on the grant team". Fixed in Supabase → SQL Editor:

```sql
insert into staff_members (email, name, role)
values ('info@novabridgegrant.org', 'Super admin', 'super')
on conflict (email) do update
  set role = 'super', active = true, auth_user_id = null, updated_at = now();

-- check
select email, name, role, active, auth_user_id is not null as linked from staff_members order by created_at;
```

After signing in again, `info@novabridgegrant.org` shows `linked: true`. (`journalctl -u novabridgegrant-api | grep -i "super admin"` prints "initial super admin created" only when the seed actually ran.)

- **Supabase** → Authentication → URL configuration: Site URL `https://access.novabridgegrant.org`; add `https://access.novabridgegrant.org/**` to Redirect URLs.
- **Resend:** sending domain verified; webhook URL `https://access.novabridgegrant.org/api/email/webhook`. Enter the Resend API key and webhook secret in the admin settings (they're stored encrypted with `SETTINGS_ENCRYPTION_KEY`).

## Step 11b — Auth emails from our own server (Supabase Send Email Hook)

Without this, Supabase sends sign-up confirmations, password resets and sign-in links itself, from `noreply@mail.app.supabase.io` with its own wording (seen on 28 Sep 2026). With the **Send Email Hook** on, Supabase sends nothing: it calls `POST https://access.novabridgegrant.org/api/auth/email-hook` for every auth email, and our API writes the email (app name and wording, `lib/authEmails.ts`) and sends it through Resend from our sender. Supabase still creates the accounts and checks the links (they go to `…supabase.co/auth/v1/verify`, which then redirects to our site).

Order matters — switch the hook on **last**, or sign-ups fail while email isn't ready:

1. **Resend:** API key; domain `novabridgegrant.org` added and **Verified** (DNS records in Cloudflare, grey cloud). Done 28 Sep: region Ireland (`eu-west-1`); records DKIM `resend._domainkey` (TXT), sending `send` and `rsend` (CNAME to Resend's `…forge.rmta.net`), receiving MX `@` → `inbound-smtp.eu-west-1.amazonaws.com`, tracking `mail` → `links2.resend-dns.com`, all "DNS only".
2. **Admin → Settings → Email:** save the Resend key, sender (e.g. `Nova Bridge Grant <noreply@novabridgegrant.org>`), reply-to, portal address `https://access.novabridgegrant.org`; send a test. **Settings → App branding:** set the application name (default "arc.fund").
3. **Supabase → Authentication → URL Configuration:** Site URL `https://access.novabridgegrant.org`, Redirect URLs `https://access.novabridgegrant.org/**`.
4. **Supabase → Authentication → Hooks → Add hook → Send Email hook:** type **HTTPS**, URL `https://access.novabridgegrant.org/api/auth/email-hook`, **Generate secret**, copy it (`v1,whsec_…`). Don't enable yet if the form allows saving disabled.
5. **Server** — add the secret and deploy the code that has the hook:
   ```bash
   F=/etc/novabridgegrant/api.env
   sed -i '/^SUPABASE_EMAIL_HOOK_SECRET=/d' $F
   echo 'SUPABASE_EMAIL_HOOK_SECRET=v1,whsec_PASTE' >> $F
   cd /var/www/novabridgegrant
   sudo -u novabridgegrant git pull --ff-only
   sh deploy/build.sh
   systemctl restart novabridgegrant-api
   ```
6. **Cloudflare:** Security → Settings → search "bot" → **Bot Fight Mode off**. Supabase calls the hook from its servers in Ireland; Bot Fight Mode answers those calls with a "Managed Challenge" (a browser check a server can't pass), which Supabase reports as `Unexpected status code returned from hook: 403`. On the free plan Bot Fight Mode can't be skipped for one path, so it has to be off. Safe for us: the hook refuses any call without Supabase's signature, and `/api/email/webhook` (Resend's calls, blocked the same way) refuses any call without Resend's. There are no custom WAF or rate-limit rules on the zone.
7. **Enable** the hook in Supabase, then sign up with a test address: the email should come from our sender with our wording.

**Admin check:** Settings → Email → "Sign-up and sign-in emails" shows the chain as a checklist: (1) Resend key and sender saved, (2) hook secret on the server, (3) hook on in Supabase at our URL (needs a Supabase access token to check; says "Not checked" without one). The badge reads RESEND when all three are done, and a warning appears if the hook is on while Resend isn't set up.

If the hook answers with an error, Supabase shows the sign-up/reset as failed and nothing is sent: check `journalctl -u novabridgegrant-api -n 50 --no-pager | grep -i "auth email"`. To go back to Supabase's mailer (emergency only: it breaks the rule below and allows only a few emails an hour from `noreply@mail.app.supabase.io`), disable the hook in Supabase.

**Which error means what** (the message Supabase shows on the sign-up page):

| Status | From | Meaning / fix |
|---|---|---|
| 403 | Cloudflare, not our app | Bot Fight Mode (or another Cloudflare protection) blocked Supabase. Check Security → Analytics → **Events**, filter *Path equals* `/api/auth/email-hook`; the "Service" column names the feature. Our hook route never answers 403. |
| 401 | our API | Signature check failed: the `SUPABASE_EMAIL_HOOK_SECRET` line doesn't match the hook's secret in Supabase. |
| 503 | our API | Resend key or sender not saved in Settings → Email, or the hook secret / `SUPABASE_URL` missing on the server. |
| 502 | our API | Resend refused or timed out (4 s). Check Resend → Logs. |

### Auth emails — what happened on 28 Sep and why

- **The rule (owner, 28 Sep):** Supabase is our database and sign-in system; its job is storing data, not sending email. **Resend is our only email driver**, and every email comes from our own address.
- **What we found:** the first test sign-up's confirmation came from `Supabase Auth <noreply@mail.app.supabase.io>` with Supabase's wording. That's Supabase's built-in mailer: generic sender, only a few emails an hour.
- **What we built:** Supabase's **Send Email Hook** (`POST /api/auth/email-hook`, `0524e86`). With it on, Supabase still creates accounts and makes the verification links, but hands every auth email to our server, which writes it in the app's wording and sends it through Resend. Supabase's mailer and its SMTP settings are unused.
- **Why the SMTP route was removed:** the admin used to offer a second route, pointing Supabase's own mailer at Resend's SMTP relay ("Use Resend", "Use app wording"). That still has Supabase sending, which breaks the rule, so it was removed (`bad06bc`). The panel now shows the hook checklist instead.
- **The sign-up error:** once the hook was switched on, sign-ups failed with *"Unexpected status code returned from hook: 403 — go back to step 1"*. Our hook code never answers 403, and unsigned calls from outside reached it and got 401, so the 403 came from in front of the app. Cloudflare → Security → Analytics → Events showed it: calls to `/api/auth/email-hook` from Ireland (Supabase's region) at 11:33 and 12:01 got **Managed Challenge** by **Bot Fight Mode**. The hook was switched off to let sign-ups work again meanwhile.
- **The fix, in order:** Resend domain verified (7:43 PM) → Resend key and sender saved in Settings → Email → **Bot Fight Mode turned off** → hook switched back on → test sign-up: the confirmation came from our address through Resend. Working since the evening of 28 Sep.

## Step 12 — Smoke test

- [ ] Home page loads over HTTPS, refreshing a deep link (e.g. `/login`) doesn't 404
- [ ] Sign up → confirmation email arrives → sign in
- [ ] Upload a document → file appears in `/var/lib/novabridgegrant/documents`
- [ ] Super admin (`info@novabridgegrant.org`) signs in to the admin area

## Step 13 — Backups

Back up, alongside the Supabase database:
- `/var/lib/novabridgegrant/documents` (uploaded files)
- `/etc/novabridgegrant/api.env` (contains `SETTINGS_ENCRYPTION_KEY`) — keep a copy off the server

---

## Redeploy an update

```bash
# In Replit: merge to main and push. Then on the server:
ssh root@77.68.98.14
cd /var/www/novabridgegrant
sudo -u novabridgegrant git pull --ff-only
sudo -u novabridgegrant git log --oneline -1   # the commit you pushed (as root, plain `git` refuses: "dubious ownership")
sh deploy/build.sh                      # install + build both apps; ends with "Build OK"
# Only if the schema changed:
#   (set -a; . /etc/novabridgegrant/api.env; set +a; PATH=/opt/novabridgegrant-node/bin:$PATH pnpm -F @workspace/db run push)
systemctl restart novabridgegrant-api
curl -s http://127.0.0.1:3100/api/healthz; echo
```

`deploy/build.sh` holds the build settings (port 3100, the public Supabase URL and anon key) and runs the build as the `novabridgegrant` user.

(nginx doesn't need a reload for code updates.)

### Grant plans editable after submissions (10 Oct 2026) — deployed 10 Oct 2026 as `4841d82` (`410c60a` + server notes)

No schema change: `git pull`, `sh deploy/build.sh`, `systemctl restart novabridgegrant-api`. Check: as the super admin, Admin → Grants → a plan with submitted applications (e.g. Celebrity Fan Funding): no field shows a lock, a note says how many applications were submitted, and changing the application form or minimum tier saves. Open a submitted application whose field was removed: its answer shows "(no longer on the form)". Details: `work.md` §6, "10 Oct 2026".

Deployed 10 Oct 2026 (~14:32, server clock): `git pull --ff-only` (`4390116..4841d82`), `sh deploy/build.sh` (Build OK, bundle `index-b4f-kQL9.js`), restart; `/api/healthz` → ok. Server rebooted for pending Ubuntu updates at ~14:37 (server clock); after it the API and nginx were `active` and `/api/healthz` → ok. Still to do: the editor check above.

### Per-applicant payout switches (9 Oct 2026) — deployed 9 Oct 2026 as `4390116` (`e14c6ee` + server notes)

No schema change (the switches live in the existing `applicant_profiles.permissions` JSON; missing means on): `git pull`, `sh deploy/build.sh`, `systemctl restart novabridgegrant-api`. Check: as the super admin, open an applicant's profile (Admin → Applicants → the applicant) → **Feature toggles**: **Identity check for payouts** and **Two staff sign-offs for large payouts** show, both On. Turn two sign-offs Off for the applicant with the $10,000 payout, then Admin → Payments → Payouts: the approver can now mark it paid. Details: `work.md` §6, "9 Oct 2026".

Deployed 9 Oct 2026 (~07:56, server clock): `git pull --ff-only` (`c32619e..4390116`), `sh deploy/build.sh` (Build OK), restart; `/api/healthz` → ok. Still to do: the Feature toggles check above.

### Eligible amount by tier (8 Oct 2026) — deployed 8 Oct 2026 as `c32619e`

No schema change (the amounts live in the existing `system_settings.treasury` JSON): `git pull`, `sh deploy/build.sh`, `systemctl restart novabridgegrant-api`. Until finance sets them every tier is 0 (not set), so dashboards keep showing the largest open award. Check: as the super admin, Admin → Settings → Money → **Eligible amount by tier**, enter the three amounts and save (the change log names the tiers); as an applicant, the dashboard's Eligible amount shows their tier's figure with "Your Tier N amount". Details: `work.md` §6, "8 Oct 2026".

Deployed 8 Oct 2026 (~21:20 UTC): `git pull --ff-only` (`f7e58e1..c32619e`), `sh deploy/build.sh` (Build OK), restart; `/api/healthz` → ok. Still to do: finance enters the three amounts, and the dashboard check above.

### Application text limits, upload disk protections, image rebuilding, and plans without a budget (7 Oct 2026) — deployed 8 Oct 2026 as `f7e58e1`

No schema change: `git pull`, `sh deploy/build.sh`, `systemctl restart novabridgegrant-api`. The build's `pnpm install` fetches the new `sharp` image library (prebuilt for Linux x64; nothing to install with apt). Before restarting, check it loads: `cd /var/www/novabridgegrant/artifacts/api-server && sudo -u novabridgegrant /opt/novabridgegrant-node/bin/node -e "import('sharp').then(s => console.log('sharp', s.default.versions.sharp))"` should print `sharp 0.35.5`. Then upload a phone photo as a profile picture and confirm it shows the right way up. Plans no longer have a Total budget (no schema push: the `programs.budget` column stays, unused); check that Admin → Grants shows "Awarded so far" and the plan form has no budget field. Optional: set `MIN_FREE_DISK_MB` in `/etc/novabridgegrant/api.env` (default 2048, i.e. uploads pause when less than 2 GB would be left; `0` turns the check off); the startup log line "document files are stored on this server's disk" shows the floor in use. Check: (1) on a plan with a long-text field, an answer of about 1,500 characters saves and submits (this failed before); (2) the long-text box stops at 2,000 characters and shows a count; (3) `curl -s http://127.0.0.1:3100/api/healthz` is ok. Details: `work.md` §6, "7 Oct 2026".

## Disk space

Uploaded files (application and identity documents, deposit receipts, profile photos, method photos, brand images) are on this server's disk under `/var/lib/novabridgegrant/documents`; the database is in Supabase. Two limits protect the disk (since the 7 Oct 2026 change):

- Each applicant keeps at most **200 MB** of documents and deposit receipts; past it, their upload is refused with a message.
- When a write would leave less than `MIN_FREE_DISK_MB` (default 2,048 MB) free, **every upload pauses** (507, "Uploads are paused because the server is low on storage") and staff get a highlighted **"Server storage is low: uploads are paused"** item in the team activity feed (at most once an hour). Everything else keeps working.

If that alert appears:

```bash
df -h /var/lib/novabridgegrant                                   # free space on the disk
du -sh /var/lib/novabridgegrant/documents                        # all uploaded files
du -sh /var/lib/novabridgegrant/documents/* | sort -h | tail -10 # the largest accounts (folder = account id)
journalctl --disk-usage                                          # system logs; shrink with: journalctl --vacuum-size=500M
```

Then free space (old logs, `apt clean`, unused files outside the documents folder) or add disk in the IONOS panel. Never delete files inside the documents folder by hand: their records stay in the database and opening them reports "the stored file is missing". Uploads resume on their own as soon as there's room; no restart is needed.

### Shared branding: logo, favicon, colours, email look (5 Oct 2026) — deployed as `1ee502b`

**Schema change: push before restarting** (new `email_settings.branding` column; the API reads it at startup, so the old schema would stop it starting). `git pull`, schema push (Step 7 / the commented line above), `sh deploy/build.sh`, `systemctl restart novabridgegrant-api`. Logos and the favicon are stored in `DOCUMENTS_DIR` like documents (back them up with it). Check: as the super admin, Settings → App branding: upload a logo and a favicon, pick and save a colour, pick an email colour and see the preview; open the portal in a private window (sign-in page shows the logo and the tab icon); send a test email (Settings → Email) and see the logo and colour. Emails need the portal address set (Settings → Email or `APP_URL`) to show the logo.

### Commission at the plan's rate at approval (5 Oct 2026) — deployed as `4f99dad`

No schema change: `git pull`, `sh deploy/build.sh`, `systemctl restart novabridgegrant-api`. Check: submit a test application on a plan with a commission, change the plan's commission, approve it, and confirm the `Commission` ledger entry uses the new rate and the application's detail page shows it.

### Identity checks for withdrawals only, and Active/Inactive plans (4 Oct 2026) — deployed as `96d6f31`

- **No schema push** and no new environment variables: `git pull` + `deploy/build.sh` + restart.
- Applying for a grant no longer needs a verified identity; every withdrawal does. Grant plans read Draft / Active / Inactive, and inactive plans are hidden from applicants (except those with an application on them).
- **Smoke test:** as staff, make a test plan inactive → it disappears from a test applicant's Grants page → make it active → it's back. As an unverified test applicant, start an application (allowed) and open Withdrawals (asks for the identity check).

### Profile center (29 Sep 2026) — deployed in `91074ee`

- **Schema:** new `applicant_profiles` columns and the `security_events` table. Run the schema push above (Step 7) before restarting the API, or `/api/profile` fails.
- **Photos** are kept under `DOCUMENTS_DIR` with the documents, so they're in the same backup.
- **Optional location:** to fill the Location column in the applicant's security activity, turn on Cloudflare → Rules → Managed Transforms → "Add visitor location headers", then add `GEO_HEADERS=cloudflare` to `/etc/novabridgegrant/api.env` and restart. Leave it unset if the API can be reached without going through Cloudflare, since clients could send those headers themselves.
- **Email change:** the email-change email now shows the verification code as well as the link; nothing to change in Supabase. With "Secure email change" on in Supabase, both addresses must confirm.
- **Smoke test after deploying:** sign in as a test applicant → My profile → upload a photo, change the password (with the current one), change the email with the code, and log out other devices from a second browser.

### Withdrawal methods (29 Sep 2026) — deployed in `91074ee`

- **Schema push required** (Step 7) before restarting the API: `ledger_entries` gains `source` and `payout_details`. Without it, withdrawals fail. The methods themselves live in `system_settings.treasury` (JSON); existing settings are filled in when read, so the four old channels appear as methods with their forms.
- **Payout details are now stored in full** (on each withdrawal and as each applicant's last answers per method) so finance can pay from them. Old masked destinations in `applicant_profiles.payout_destinations` are ignored; applicants fill the method's form on their next request.
- **Method photos** are stored under `DOCUMENTS_DIR` (owner folder `5a1e5000-0000-4000-8000-00000000f070`), so they're in the same backup, and served publicly at `/api/withdrawal-methods/<id>/photo`.
- **Smoke test:** as finance, Settings → Withdrawal methods → add a method with a photo upload and a two-field form → it appears on a test applicant's Withdrawals page → request with the form → Payments → Payouts shows the answers → make the method unavailable → it disappears for the applicant.

### Add funds page and dashboard buttons (29 Sep 2026) — deployed in `91074ee`

- Portal-only changes: no schema push and no new environment variables. They ship with the same `git pull` + `deploy/build.sh` + restart.
- `pnpm-lock.yaml` changed (the API server gained `@workspace/api-client-react` as a dev dependency for its tests); `deploy/build.sh` installs it with the rest.
- **Smoke test:** as a test applicant, dashboard → **+ Deposit** opens Add funds; announce a small deposit, copy the reference, cancel it from the history. Dashboard → **Withdraw** opens Withdrawals.
- The Add funds page still shows the placeholder receiving details; since deposit methods (below) they're edited in Admin → Settings → Deposit methods.

### Deposit methods and proof of payment (30 Sep 2026) — deployed in `894f51a`

- **Schema push required** (Step 7) before restarting the API: `ledger_entries` gains `pay_to`, `deposit_details`, `proof_required`, and `proof`. All additive. Deposit methods live in `system_settings.treasury` (JSON); the stored settings are filled in when read: Bank transfer and Mobile money with the old deposit limits and sample receiving details, and USDT (TRC-20) hidden. The old minimum/maximum deposit settings are no longer used.
- **Proof files** are stored under `DOCUMENTS_DIR` in the applicant's folder, and **method photos** under owner folder `5a1e5000-0000-4000-8000-00000000f071`, so both are in the same backup.
- **After deploying:** in Admin → Settings → Deposit methods, replace every "(placeholder)" value with the real details (the cards warn until you do), enter the USDT wallet address, then make USDT available if wanted. Check the deposit two-person threshold in Settings → Money (default $2,500).
- **Smoke test:** as a test applicant, Add funds → a method with required proof → a small deposit → the receiving details and reference show → upload a receipt → as finance, Payments → Deposits shows the receipt (opens) and confirming credits the amount less the charge. A deposit at or above the threshold needs Approve (compliance or super admin) before a different person confirms.

### Grant plans with commission (3 Oct 2026) — deployed in `894f51a`

Built on the same branch as deposit methods (`deposit-methods`), so it ships with them.

- **Schema push required** (Step 7) before restarting the API: `programs` gains `approval_days` (default 7) and `commission_rate` (default 0), and `applications` gains `commission_rate` (empty). All additive; existing plans start at 7 days and no commission, and applications already submitted take no commission. The new permission switch lives in `applicant_profiles.permissions` (JSON, no column). The application fee in `system_settings.treasury` is ignored from now on and dropped the next time finance saves Settings → Money.
- **After deploying:** set each live plan's approval days and commission in Admin → Grant programs → Manage program. Applications already in review keep no commission; new submissions take the rate the plan has when they're submitted.
- **Smoke test:** as staff, edit a plan with a commission (e.g. 10%) and a required "Document upload" form field; as a test applicant, apply: the form asks for the upload, and the review step shows the commission and the deposit balance after approval; submit (nothing is charged). As staff, approve: the applicant's ledger shows the grant credit and a `Commission` entry, and the deposit balance may go below $0. A grant payout still works; turn on **Clear a negative deposit balance before grant payouts** on the applicant's profile and it's refused until a deposit brings the balance back to $0. Try uploading a PDF with JavaScript: it's refused with a clear message.

## Server inventory (new VPS)

_Fill in from step 1's output on the new server._

| Question | Finding |
|---|---|
| Provider | IONOS VPS 1-2-60, UK data centre, created 27 Sep 2026; host name `1z0jt3t.cserverhost.cloud` |
| IP / SSH | `77.68.98.14` (IPv4 only, no IPv6); `ssh root@77.68.98.14`. The initial root password from IONOS must be changed on first login and is never written here |
| OS / resources (CPU, RAM, swap, disk) | Ubuntu 26.04; 1 vCore, 2 GB RAM, 60 GB NVMe (from IONOS — confirm swap in step 1) |
| Firewall | IONOS panel firewall ("My firewall policy") in front of the server — 22, 80, 443 confirmed open; ufw inactive |
| Other apps on it? (decides whether the "only add things" rule applies) | **None** — fresh server, only stock Ubuntu services running. The rule still costs nothing, so we keep it |
| Checked (step 1, 27 Sep 2026 22:02 UTC) | Ubuntu 26.04.1 LTS, kernel 7.0.0-34; 1 CPU; 1.8 GiB RAM (1.4 GiB available); **no swap**; 58 GB disk, 5% used |
| System Node / pnpm / pm2 | none installed; git 2.53.0 present |
| Docker | **not installed** (despite what IONOS said) — not needed |
| nginx / certbot installed? | neither at first — installed in step 1b: nginx 1.28.3, certbot 4.0.0 (apt) |
| ufw | inactive (the IONOS panel firewall is the only filter) |
| Ports already in use | 22 (sshd), 53 on 127.0.0.53/127.0.0.54 (systemd-resolved) only |
| SSH host key | ED25519 `SHA256:+m8Fxwu83IdChvepDh/JMXHO15UiDvv19i4cVIW+KM0` |

## Decisions

| Decision | Value |
|---|---|
| App folder | `/var/www/novabridgegrant` |
| Process manager | systemd (`novabridgegrant-api`) |
| Node.js | private copy in `/opt/novabridgegrant-node` (keeps any system Node untouched) |
| API port | `3100` (nothing else listens on the new server; bound to 127.0.0.1) |
| TLS method | Let's Encrypt via certbot (`certbot --nginx`), cert at `/etc/letsencrypt/live/access.novabridgegrant.org/`, renewed by `certbot.timer`; Cloudflare in front |
| Swap | 2 GB swap file `/swapfile` (the server had none; needed for the build on 1.8 GiB RAM) |
| GitHub access | read-only deploy key "novabridgegrant new VPS" (`SHA256:W1va3z6nBq9aB/iHAAJjtY6jQY3GRsBTCZunkRHyroU`) owned by `novabridgegrant` (`/home/novabridgegrant/.ssh/id_ed25519`); no access token needed for pulls. It grants nothing on the server itself. Revoke at GitHub → repo → Settings → Deploy keys |
| Build on the server | lean build: only `api-server` + `grant-user-portal`, no type check (it runs in Replit), one package at a time under `nice`. Safe on small servers; if it still runs out of memory, build in GitHub Actions and copy `dist/` over instead |

## Status

**Live since 27 Sep 2026 (~23:26 UTC)** at https://access.novabridgegrant.org. Deployed code: `91074ee` (29 Sep, ~21:09 UTC: applicant profile center, rebuilt Add funds page, dashboard Deposit/Withdraw buttons, admin-managed withdrawal methods and the rebuilt Withdrawals page); before it `5288eff` (29 Sep, user-visible "demo" wording removed); before that `2bbe3c4` (29 Sep, admin applicant directory and profile rebuilt, balance adjustments, permission switches); before that `00c13f0` (28 Sep, demo notices removed from the applicant dashboard, deposits, and payouts); before that `bad06bc` (auth emails only through the hook and Resend; Settings → Email shows the hook checklist); before that `0524e86` (adds the auth email hook); first deploy was `8dfe7be`.

Preparation (27 Sep 2026):
- [x] Reviewed the app's structure and runtime needs; wrote this runbook.
- [x] Access decision: the owner runs the commands; Claude has no key on any server.
- [x] Step 0: `money-flows` merged into `main` and pushed; GitHub `main` was at `b930d1c`.

Old server `195.20.255.153` (abandoned 27 Sep 2026 — see "Old server — retired"):
- [x] Steps 1–4 reached (port 3100, private Node, user, deploy key, clone). Nothing was built, no service or nginx site was created.
- [x] Cleanup: our folders, private Node, and the `novabridgegrant` user + home (deploy key) deleted; confirmed no service or nginx site of ours existed; final check shows every path and the user gone. Other apps untouched.
- [x] Old deploy key "novabridgegrant server" deleted on GitHub.

New VPS `77.68.98.14` (27 Sep 2026):
- [x] Details from the owner: IONOS UK, Ubuntu 26.04, 1 vCore / 2 GB RAM / 60 GB.
- [x] Step 1 — looked around: fresh server (no other apps, no nginx/certbot/Node/Docker, no swap, ufw off). "Server inventory" filled in.
- [x] Step 1b — 2 GB swap file `/swapfile` (in `/etc/fstab`); `apt upgrade` (7 packages, no reboot needed); nginx 1.28.3 + certbot 4.0.0 installed from apt.
- [x] Step 2 — API port `3100` (only 22 and 53 were in use).
- [x] Step 3 — private Node v24.21.0 + pnpm 10.34.5 in `/opt/novabridgegrant-node`.
- [x] Step 4 — system user `novabridgegrant`; deploy key generated (`SHA256:W1va3z6nBq9aB/iHAAJjtY6jQY3GRsBTCZunkRHyroU`) and added on GitHub as "novabridgegrant new VPS" (read-only); cloned at `b930d1c`.
- [x] Step 5 — data folders; `api.env` with 13 lines, locked `640 root:novabridgegrant`. (First attempts were wiped/duplicated by PowerShell paste problems; rebuilt with short lines — see "Working on the server from Windows PowerShell".)
- [x] Step 6 — install and build (portal build first failed on `sudo -E`; fixed with `sudo --preserve-env`).
- [x] Step 7 — schema pushed to Supabase through the pooler, no drop/rename prompts.
- [x] Added `deploy/` (service, nginx site, `build.sh`) to the repo, pushed as `8dfe7be`, pulled on the server.
- [x] Step 8 — `novabridgegrant-api` enabled and running; `/api/healthz` → `{"status":"ok"}`.
- [x] Step 9 — nginx site enabled, default site removed, `nginx -t` ok, reloaded; portal and API answer through nginx; port 80 reachable from outside.
- [x] Step 10 — DNS → `77.68.98.14`; Let's Encrypt certificate (expires 2026-12-26, auto-renews); Cloudflare proxied, Full (strict). Checked from outside and through Cloudflare.
- [x] IONOS firewall: 22, 80 and 443 all reach the server (80 tested directly; 443 works through Cloudflare Full (strict)).
- [x] First super admin `info@novabridgegrant.org` added in the Supabase SQL editor (seed skipped because `staff_members` already had a row); signed in and linked.

Still to do:
- [ ] Confirm Supabase → Authentication → URL configuration: Site URL `https://access.novabridgegrant.org`; `https://access.novabridgegrant.org/**` in Redirect URLs (verification links redirect here).
- [ ] Resend webhook → `https://access.novabridgegrant.org/api/email/webhook` (events `email.received`, `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`) and its signing secret in Settings → Email, for the team inbox and delivery status. Bot Fight Mode is already off, so Resend's calls get through.
New VPS, 28 Sep 2026:
- [x] Docs brought up to date with the whole deployment (this file, `BUILD_STATUS.md`, `work.md`, `replit.md`).
- [x] Found that sign-up confirmations came from Supabase's mailer (`noreply@mail.app.supabase.io`, Supabase's wording). Decision (owner): our own system sends every auth email, not Supabase.
- [x] Built Supabase's Send Email Hook: `POST /api/auth/email-hook` (`routes/authEmailHook.ts`, templates in `lib/authEmails.ts`); 5 new API tests, 110 API + 171 rule tests pass, type check clean. Pushed as `0524e86`.
- [x] 2026-09-28 — Step 11b, server side: code `0524e86` deployed (`git pull`, `sh deploy/build.sh`, restart); `SUPABASE_EMAIL_HOOK_SECRET` in `api.env`; the hook endpoint answers unsigned calls with 401 (secret loaded).
- [x] Sign-ups failed with "hook: 403"; traced to Cloudflare Bot Fight Mode (Security → Analytics → Events: Managed Challenge on `/api/auth/email-hook` from Ireland). Hook switched off meanwhile.
- [x] Owner's rule recorded: Supabase sends no email, Resend sends everything. Removed the Supabase-SMTP route from the admin and API; the email panel shows the hook checklist. 109 API + 171 rule tests pass. Pushed and deployed as `bad06bc`.
- [x] Resend: domain `novabridgegrant.org` verified (Ireland, sending + receiving + tracking); key and sender saved in the admin.
- [x] Cloudflare: Bot Fight Mode off.
- [x] Send Email hook enabled in Supabase; test sign-up confirmation arrived from our address through Resend.
- [x] Application name set to "Nova Bridge Grant" (seen on `/api/branding`, 5 Oct 2026).
- [ ] Optional: DMARC record in Cloudflare (`TXT` `_dmarc` = `v=DMARC1; p=none;`) to help deliverability. Resend lists `rsend` → `rsend-euw1.forge.rmta.net` while Cloudflare has `rsend.forge.rmta.net`; Resend shows it verified, so leave it unless it turns red.
- [ ] After go-live: regenerate the Send Email hook secret in Supabase (it was typed into the chat on 28 Sep 2026) and replace the `SUPABASE_EMAIL_HOOK_SECRET` line (Step 11b, step 5).
- [ ] Step 12 — applicant smoke test (sign up → confirmation email → apply → upload → file in `/var/lib/novabridgegrant/documents`).
- [ ] Decide about the leftover super admin `benmacwuche+newnovabridgegrant@gmail.com` (keep, or set `active = false`).
- [ ] Step 13 — backups: `api.env` copy off the server, `SETTINGS_ENCRYPTION_KEY` in a password manager, documents folder.
- [ ] Reset the Supabase database password (it was typed into the chat on 27 Sep 2026), then redo the database line in `api.env` (Step 5) and `systemctl restart novabridgegrant-api`.
- [ ] Change the VPS root password (`passwd`) — IONOS didn't force it on first login; deferred by the owner until after go-live.
- [ ] Optional hardening: SSH keys instead of the root password, then `PasswordAuthentication no`.

New VPS, 29 Sep 2026 (`91074ee`):
- [x] Built and tested in Replit: profile center (`/profile`), Add funds rebuilt, dashboard buttons, withdrawal methods (Settings → Withdrawal methods) and Withdrawals rebuilt. 198 rule tests, 131 API tests, 10 wiring tests, typecheck and builds pass; headless-browser checks in preview mode.
- [x] Committed as `91074ee` (branch `profile-deposits-withdrawal-methods`, fast-forwarded into `main`, pushed; branch deleted).
- [x] Server was on `5288eff`, clean, API active and healthy before starting.
- [x] `git pull --ff-only` → `91074ee`.
- [x] Schema pushed before building (Step 7): "Changes applied", no prompts. Added: 8 `applicant_profiles` columns (display name, Telegram, two privacy switches, four photo columns), `ledger_entries.source` and `payout_details`, and the `security_events` table. All additive, so the old API kept working meanwhile.
- [x] `sh deploy/build.sh` → Build OK (only the usual source-map and chunk-size warnings).
- [x] API restarted ~21:09 UTC: new process listening on 3100, documents folder and Resend sender logged, no errors; `/api/healthz` → ok; `/api/withdrawal-methods/bank/photo` → `{"error":"No photo."}` (new public route live).
- [ ] Browser smoke test (asked of the owner, not yet reported): as the super admin, Settings → Withdrawal methods shows the four existing methods; add a "Test method" with an uploaded logo and a two-field form; as a test applicant, the dashboard buttons, My profile (photo, details, a privacy switch), and the test method on Withdrawals; then delete the test method.
- [ ] Profile smoke test with a real applicant account: change the password (current one checked), change the email with the code, log out other devices ("Profile center" section above).
- [ ] Withdrawal smoke test end to end: a small confirmed deposit on a test applicant, a request with a method's form, the answers visible under Payments → Payouts, then mark it failed so the money returns ("Withdrawal methods" section above).
- [ ] Owner: the real deposit receiving details (after deploying deposit methods: Admin → Settings → Deposit methods, no redeploy).
- [ ] Optional: `GEO_HEADERS=cloudflare` for the Location column of security activity ("Profile center" section above).

30 Sep 2026 (deposit methods, committed as `2ae8223`, deployed 3 Oct as `894f51a`):
- [x] Built in Replit: Settings → Deposit methods (receiving details, per-method limits and charges, proof of payment, form; USDT TRC-20 added, hidden until a wallet is set), the rebuilt Add funds flow with receipt uploads, the admin deposit panel with receipts and the two-person deposit rule, and the deposit two-person threshold in Settings → Money (global deposit limits removed). 208 rule tests, 149 API tests, typecheck, and headless-browser checks pass.
- [x] Commit and merge to `main` (`2ae8223`, 3 Oct 2026).
- [x] Push `main` to GitHub (`894f51a`).
- [x] Deploy (3 Oct 2026, ~23:22 UTC): `git pull` (fast-forward `91074ee..894f51a`), **schema push** ("Changes applied", no prompts), `sh deploy/build.sh` (Build OK), restart; `/api/healthz` ok locally and from outside, and the served bundle has the new pages.
- [ ] Owner: replace every "(placeholder)" receiving detail and enter the USDT wallet address in Admin → Settings → Deposit methods; make USDT available if wanted.
- [ ] Smoke test from that section.

3 Oct 2026 (grant plans with commission, same commit `2ae8223`, deployed with it):
- [x] Built in Replit: approval days and a commission % per plan, a form builder with long-text and document-upload fields, the commission on the application summary and taken from the deposit balance on approval (negative allowed), the per-applicant switch for grant payouts while the deposit balance is negative, the application fee removed, and stricter upload checks. 215 rule tests, 156 API tests, typecheck, and a headless-browser check pass.
- [x] Deployed with deposit methods; the same schema push added `programs.approval_days`, `programs.commission_rate`, `applications.commission_rate`.
- [ ] Owner: set approval days and commission on each live plan.
- [ ] Smoke test from that section.

## Old server — retired

`195.20.255.153`, abandoned on 27 Sep 2026 for a new VPS. It was shared with ~20 other apps (pm2, system Node v20.20.2, nginx 1.28.3, certbot 4.0.0, ufw allowing 22/80/443) and had only 2 vCPU and 1.8 GB RAM (~600 MB free).

**What we added there** (nothing else was touched):

| Item | State when abandoned |
|---|---|
| `/opt/novabridgegrant-node` | Node v24.21.0 + pnpm 10.34.5 |
| System user `novabridgegrant` (uid 999, gid 986) + `/home/novabridgegrant` | holds the deploy key and a `known_hosts` entry for github.com |
| `/var/www/novabridgegrant` | git clone at `b930d1c`, not installed or built |
| `/etc/novabridgegrant`, `/var/lib/novabridgegrant` | step 5 may have been started — remove if present |
| GitHub deploy key "novabridgegrant server" | `SHA256:qqBm7jGggOTj3Rnl092o/IUAko2WtC3YtQgpRqsby2s`, read-only |
| systemd unit, nginx site, certificate, Cloudflare change, database change | **none were created** |

**Cleanup** — run on the old server as root, one line at a time. Every path is ours alone (it has `novabridgegrant` in its name), so nothing belonging to the other apps is touched; nginx and pm2 are not reloaded or restarted.

```bash
ssh root@195.20.255.153

# 1. Confirm there is no service or nginx site of ours (both should say "No such file")
ls /etc/systemd/system/novabridgegrant-api.service /etc/nginx/sites-enabled/novabridgegrant /etc/nginx/sites-available/novabridgegrant

# 2. Stop anything running as our user (normally nothing)
pkill -u novabridgegrant; true

# 3. Delete our folders
rm -rf /var/www/novabridgegrant
rm -rf /opt/novabridgegrant-node
rm -rf /etc/novabridgegrant
rm -rf /var/lib/novabridgegrant

# 4. Delete the user, its group, and its home (with the deploy key)
userdel -r novabridgegrant

# 5. Check it's all gone (each should say "No such file" / "no such user")
ls -d /var/www/novabridgegrant /opt/novabridgegrant-node /etc/novabridgegrant /var/lib/novabridgegrant /home/novabridgegrant
id novabridgegrant
```

Then on GitHub: **macwuche/new_grant → Settings → Deploy keys → "novabridgegrant server" → Delete** (its private half no longer exists).

Leftovers not worth touching: pnpm's download cache in root's `~/.npm` (shared with the other apps' npm), and the `API_PORT`/`PATH` exports, which vanish on logout. If step 5 was run, the `SETTINGS_ENCRYPTION_KEY` it generated was never used for anything; the new server gets a fresh one.

## Change log
- 2026-09-27 — Created this file; first checks from outside the server (DNS, HTTP, SSH).
- 2026-09-27 — Rewrote as a step-by-step runbook: folder `/var/www/novabridgegrant`, private Node 24, systemd service, free-port check, separate nginx site.
- 2026-09-27 — Steps 0, 2, 3, 4 done on the old server (port 3100, Node v24.21.0 + pnpm 10.34.5, deploy key, clone at `b930d1c`). Recorded its resources (2 vCPU, 1.8 GB RAM) and switched step 6 and the redeploy to a lean, low-memory build.
- 2026-09-27 — Moving to a new VPS: old server retired (inventory, cleanup steps, and deploy-key removal recorded under "Old server — retired"); runbook now targets `77.68.98.14`; today's plan added to Status.
- 2026-09-27 — Old server cleaned up and verified (folders, private Node, user and its deploy key removed; other apps untouched). Still open: deleting the old deploy key on GitHub. Next: the new VPS details from the owner, then step 1 there.
- 2026-09-27 — New VPS `77.68.98.14` (IONOS UK, Ubuntu 26.04, 1 vCore, 2 GB RAM, 60 GB) recorded; runbook points at it.
- 2026-09-27 — Step 1 on the new VPS: fresh server (no other apps, no nginx/certbot/Node/Docker, no swap). Inventory filled in, API port set to 3100, new step 1b added (swap, updates, nginx + certbot).
- 2026-09-27 — New VPS: swap, `apt upgrade`, and step 3 (Node v24.21.0 + pnpm 10.34.5) done. Tip recorded: PowerShell mangles long multi-line pastes — paste one short line at a time.
- 2026-09-27 — New VPS: nginx 1.28.3 + certbot 4.0.0 installed; app user and folder created (step 4, first half).
- 2026-09-27 — New deploy key "novabridgegrant new VPS" added on GitHub (read-only); old key "novabridgegrant server" deleted, so the old server is fully retired.
- 2026-09-27 — Code cloned on the new VPS. Step 5 notes: use Supabase's session pooler string (the VPS has no IPv6); write the env file line by line with `echo` because pasting multi-line blocks through PowerShell mangles them.
- 2026-09-27 — Step 5 on the new VPS: copying long commands from the Claude Code terminal inserts line breaks at the wrap, which broke multi-line and long pastes. Fix that worked: keep each command short (`F=/etc/novabridgegrant/api.env`, then `echo '…' >> $F`), then `sort -u -o $F $F` to drop pasted-twice lines.
- 2026-09-27 — Build and schema push done on the new VPS. Added `deploy/` to the repo (systemd unit, nginx site, `build.sh`) so steps 8–9 and redeploys are short `cp`/`sh` commands instead of long pastes; steps 8, 9 and the redeploy section now use them.
- 2026-09-27 — Steps 7–10 done: schema pushed, API service running, nginx site live, HTTPS certificate issued. The portal is live at https://access.novabridgegrant.org.
- 2026-09-28 — Docs brought up to date after go-live: status rewritten, PowerShell lessons section, steps 5/6/7/10 describe what was actually run, first-super-admin fix recorded under step 11, remaining work listed.
- 2026-09-28 — Sign-up confirmation arrived from Supabase's mailer (`noreply@mail.app.supabase.io`). Built Supabase's Send Email Hook (`POST /api/auth/email-hook`) so our server writes and sends every auth email through Resend; setup is Step 11b.
- 2026-09-28 — Hook code `0524e86` deployed; hook secret set on the server; `/api/auth/email-hook` checked from outside (401 without a signature). Hook not yet enabled in Supabase — waiting for Resend.
- 2026-09-28 — Docs updated with everything done on 27–28 Sep (status banner, 28 Sep checklist, deployed code, open items).
- 2026-09-28 — Test sign-ups failed with "Unexpected status code returned from hook: 403": the hook had been switched on before Resend was ready, and the 403 came from in front of the app (our hook route never answers 403; unsigned calls from outside reach it and get 401), most likely Cloudflare blocking Supabase's server-to-server calls. Hook to stay off until Resend is set up and Cloudflare lets `/api/auth/email-hook` and `/api/email/webhook` through (Security → Events; turn off Bot Fight Mode or add a Skip rule).
- 2026-09-28 — Owner's rule: Supabase stores data and sends no email; Resend sends everything. Deployed `bad06bc` (removed the Supabase SMTP and wording controls; Settings → Email shows the hook checklist). Build OK, service restarted, `/api/healthz` 200 and the hook still answers unsigned calls with 401.
- 2026-09-28 — Traced the "hook: 403" sign-up error in Cloudflare → Security → Analytics → Events: Supabase's calls to `/api/auth/email-hook` (Ireland) got a Managed Challenge from Bot Fight Mode. Resend domain verified, key and sender saved, **Bot Fight Mode turned off**, hook switched back on: test sign-up confirmation came from our address through Resend. Step 11b gains the Cloudflare step, an error table, and the full story of the day.
- 2026-09-28 — Deployed `00c13f0`: the phone "DEMO ONLY" banner and the demo notices on Deposits and Payouts removed (design of the banner kept in `work.md` §3). Build OK, restarted; checked from outside: `/api/healthz` 200 and the served bundle has the new wording. Open: the Deposits page still shows placeholder payment details until real ones are supplied.
- 2026-09-29 — Deployed `2bbe3c4`: admin applicant directory and user profile rebuilt, balance adjustments, per-applicant permission switches. Schema pushed to Supabase first (`applicant_profiles.permissions`, `ledger_entries.category`; "Changes applied"), build OK, service restarted, `/api/healthz` ok. The owner ran the push without the surrounding parentheses, so that shell had `api.env` exported; close it (`exit`). Next: sign in to the admin and try Applicants and a profile (adjust, toggle, lock).
- 2026-09-29 — Deployed `5288eff`: user-visible "demo" wording removed (no schema change). Build OK; API restarted 03:41:37 UTC (`active (running)`). Checked from outside: page title "Applicant workspace | arc.fund", `/api/healthz` ok, served bundle has the new admin sidebar note and no "Demo data" pill. Tip learned: paste one command at a time — lines typed during a build are lost when the SSH connection drops.
- 2026-09-29 — Deployed `91074ee`: profile center, Add funds rebuilt, dashboard Deposit/Withdraw buttons, withdrawal methods and Withdrawals rebuilt (full payout details now stored; Settings → Payout destinations removed). Pulled from `5288eff`; schema pushed first ("Changes applied", no prompts: `applicant_profiles` profile columns, `ledger_entries.source`/`payout_details`, `security_events`); build OK; API restarted ~21:09 UTC, `/api/healthz` ok, new photo route answers. Browser smoke tests still to be reported by the owner.
- 2026-09-30 — Reviewed the docs; compared deposits with withdrawals. Built deposit methods (finance-managed receiving details, limits, charges, proof of payment, forms; USDT TRC-20), receipt uploads, and the two-person deposit rule on branch `deposit-methods` (not deployed). Added the "Deposit methods and proof of payment" deploy notes (schema push needed) and the 30 Sep checklist; tidied the duplicate Target heading and the deployed commit in the table.
- 2026-10-03 — Built grant plans with commission on branch `deposit-methods` (not deployed): approval days, commission % per plan taken from the deposit balance on approval (may go negative), a form builder with document uploads, a per-applicant switch for grant payouts while the deposit balance is negative, the application fee removed, stricter upload checks. Added the "Grant plans with commission" deploy notes (schema push needed) and the 3 Oct checklist.
- 2026-10-03 — Committed deposit methods and grant plans with commission together as `2ae8223` (215 rule tests, 156 API tests, typecheck pass) and merged branch `deposit-methods` into `main`. Not yet pushed or deployed; deploy needs the schema push first (see the two sections above).
- 2026-10-03 — Deployed `894f51a` (deposit methods and grant plans with commission): pulled from `91074ee`; schema pushed to Supabase first ("Changes applied", no prompts: the four `ledger_entries` deposit columns, `programs.approval_days`/`commission_rate`, `applications.commission_rate`); Build OK (~23:22 UTC); API restarted, `/api/healthz` ok. Checked from outside: healthz ok, the page serves the new bundle `index-Tb4XJ6wa.js`, which contains the Deposit methods and the negative-balance switch. Open: real receiving details and USDT wallet, approval days and commission per live plan, both smoke tests.
- 2026-10-04 — Deployed `96d6f31` (identity checks for withdrawals only; Active/Inactive plans), which fixed every plan showing "Not eligible" to applicants without a verified identity. Pushed from Replit after `gh auth login` (the Replit Git credential had stopped working); on the server: `git pull` (fast-forward `894f51a..96d6f31`), no schema push, Build OK (~17:42 UTC), API restarted, `/api/healthz` ok. Checked from outside: the page serves `index--QTNE1ZL.js`, which has "Make inactive" and no longer has the identity-before-applying rule. Added the `git log` check (run as `novabridgegrant`) to "Redeploy an update". Open: commission % per live plan, the smoke test from that section.
- 2026-10-04 — After the deploy: "New grant applications are turned off for your account" traced to that per-applicant switch being off (turn it on in Admin → Applicants → the applicant; not a code change). A report that the dashboard deposit balance ignores a commission is being checked with the queries in `work.md` ("4 Oct 2026 session"). Planned: ClamAV on this VPS for upload virus scanning (needs ~1–1.3 GB RAM; the owner is deciding on a 4 GB upgrade); nothing installed yet.
- 2026-10-05 — Deployed `4f99dad` (commission charged at the plan's rate at approval; no schema push): pull, `sh deploy/build.sh` (Build OK), restart (the first attempt was typed during the build and swallowed; rerun on its own), `/api/healthz` ok locally and from outside, bundle `index-BrZDvpP_.js` served. Tip recorded: paste one command at a time and wait for the prompt.
- 2026-10-05 — Deployed `1ee502b` (shared branding: logo, dark logo, favicon, app colour for everyone, email colour with preview): pull, **schema push** (`email_settings.branding`; "Changes applied", no prompts), `sh deploy/build.sh` (Build OK), restart, `/api/healthz` ok locally and from outside; bundle `index-Cggam0We.js`; `/api/branding` returns the new fields. The application name is already "Nova Bridge Grant". Next: the owner uploads the logo and favicon and picks the colours in Settings → App branding.
- 2026-10-08 — Deployed `f7e58e1` (application text limits, upload disk protections, image rebuilding with `sharp`, plans without a total budget; no schema push: the two schema files changed only in comments). Server was clean on `1ee502b`; `git pull --ff-only` (fast-forward `1ee502b..f7e58e1`), `sh deploy/build.sh` (+5 packages for `sharp`; Build OK ~06:03 UTC), `sharp 0.35.5` loads as `novabridgegrant`, API restarted 06:06:56 UTC, `active (running)`, `/api/healthz` ok. Disk: 51 GB free of 58 GB (11% used), well above the 2,048 MB upload floor (`MIN_FREE_DISK_MB` not set, default in use). Owner's browser checks all passed: "Awarded so far" on plan cards and the overview with no budget field, a 1,500-character long answer saves and submits, the 2,000 limit with counters, a phone photo as profile picture shows upright. Next: the owner sets up Settings → App branding (now stored as rebuilt images).
- 2026-10-10 — Deployed `4841d82` (grant plans editable after submissions; no schema push): `git pull --ff-only` (`4390116..4841d82`), `sh deploy/build.sh` (Build OK; bundle `index-b4f-kQL9.js`), restart, `/api/healthz` ok. Server asks for a reboot ("System restart required") after package updates; not done yet.
- 2026-10-10 — Rebooted the VPS (~14:37 server clock) for pending Ubuntu updates ("System restart required"; up 8 days before). After boot: `novabridgegrant-api` and nginx `active`, `/api/healthz` ok.
