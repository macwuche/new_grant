# Server & deployment runbook

How the grant portal (applicant portal + admin + API) is deployed to our VPS, step by step.
The owner runs every command on the server; paste the output of the **check** steps back so the "Server inventory" and "Decisions" sections can be filled in.

> **Server change (27 Sep 2026):** we started on a shared VPS (`195.20.255.153`), then moved to a **new VPS** before finishing.
> Everything we put on the old server is being removed — see "Old server — retired" at the end. The steps below now target the new VPS.

> **Rule if the server runs other apps:** (it did on the old server; check the new one in step 1) Nothing below edits, restarts, or replaces anything that belongs to it.
> We only *add* things: our own folder, our own Node.js, our own systemd service, our own nginx site file.
> nginx is only ever **reloaded** (never restarted) and only after `nginx -t` passes.

## Target

| Item | Value |
|---|---|
| Public address | https://access.novabridgegrant.org/ |
| VPS | `77.68.98.14` (IONOS, UK) — `ssh root@77.68.98.14`; old server `195.20.255.153` retired |
| App folder | `/var/www/novabridgegrant` |
| Private Node.js 24 | `/opt/novabridgegrant-node` (does not touch the system `node` the other app may use) |
| Secrets file | `/etc/novabridgegrant/api.env` (mode `600`, never in git or in this file) |
| Uploaded documents | `/var/lib/novabridgegrant/documents` |
| API service | systemd unit `novabridgegrant-api`, listening on `127.0.0.1:<API_PORT>` (a free port found in step 2) |
| nginx site | `/etc/nginx/sites-available/novabridgegrant` → symlinked into `sites-enabled` |
| DNS / proxy | Cloudflare in front of the VPS |
| Database | Supabase Postgres (hosted, not on the VPS); project `tynjqjukramcmtotgfdw`, session pooler `aws-1-eu-west-1.pooler.supabase.com:5432`, user `postgres.tynjqjukramcmtotgfdw` |
| Email | Resend (API key is saved in the admin settings, not in the env file) |
| Code | `https://github.com/macwuche/new_grant`, branch `main` |

### How it fits together

```
Browser ─▶ Cloudflare ─▶ nginx :80/:443 (server_name access.novabridgegrant.org)
                           ├─ /api/*  ─▶ 127.0.0.1:<API_PORT>  (node, systemd: novabridgegrant-api)
                           └─ /*      ─▶ /var/www/novabridgegrant/artifacts/grant-user-portal/dist/public (static, SPA fallback)
```

nginx shares ports 80/443 with the existing app — it picks the site by `server_name`, so nginx itself doesn't need a new port.
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

Write the port down — it's used as `<API_PORT>` in steps 6, 8 and 9. Record it in "Decisions" below.
To make the rest copy-pasteable, set it in your shell (redo this if you log in again):

```bash
export API_PORT=3100   # ← replace with the free port printed above
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

# Settings encryption key (32 random bytes). BACK THIS UP somewhere safe (password manager):
# losing it means every secret saved in the admin settings (e.g. the Resend key) must be entered again.
openssl rand -base64 32
```

Create the env file (`nano /etc/novabridgegrant/api.env`) — replace each `<…>`:

```ini
NODE_ENV=production
PORT=<API_PORT>
APP_URL=https://access.novabridgegrant.org
CORS_ORIGINS=https://access.novabridgegrant.org
# Cloudflare → nginx → API
TRUST_PROXY_HOPS=2

SUPABASE_URL=https://tynjqjukramcmtotgfdw.supabase.co
SUPABASE_ANON_KEY=sb_publishable_9TfKJrlrzqYmtZBnwUdibw_g2wPKQS8
# Use the SESSION POOLER string (…pooler.supabase.com:5432): the direct db.<ref>.supabase.co address is IPv6-only and the new VPS has no IPv6
SUPABASE_DATABASE_URL=<Supabase → Connect → Session pooler connection string, with the real password>

INITIAL_SUPER_ADMIN_EMAIL=info@novabridgegrant.org
INITIAL_SUPER_ADMIN_NAME=Super admin
STAFF_MFA_REQUIRED=false

DOCUMENTS_DIR=/var/lib/novabridgegrant/documents
SETTINGS_ENCRYPTION_KEY=<output of openssl rand -base64 32>
# Optional
# INBOX_ADDRESS=
# LOG_LEVEL=info
```

```bash
chown root:novabridgegrant /etc/novabridgegrant/api.env
chmod 640 /etc/novabridgegrant/api.env
```

## Step 6 — Install and build

```bash
cd /var/www/novabridgegrant
export PATH=/opt/novabridgegrant-node/bin:$PATH

sudo -u novabridgegrant env PATH=$PATH CI=true pnpm install --frozen-lockfile

# Low-memory build (server has 1.8 GB RAM shared with ~20 other apps):
# - builds only the two apps we deploy (skips mockup-sandbox)
# - skips the root `pnpm run build`, which type-checks everything first (tsc is the memory hog;
#   the type check already runs in Replit before pushing)
# - one package at a time, at low CPU priority so the other apps stay responsive
# The libs under lib/ export their TypeScript source, so no lib build step is needed.
# The portal's build needs these (PORT only has to be a number at build time)
sudo -u novabridgegrant env PATH=$PATH NODE_ENV=production PORT=$API_PORT BASE_PATH=/ \
  VITE_SUPABASE_URL=https://tynjqjukramcmtotgfdw.supabase.co \
  VITE_SUPABASE_ANON_KEY=sb_publishable_9TfKJrlrzqYmtZBnwUdibw_g2wPKQS8 \
  nice -n 10 pnpm --workspace-concurrency=1 \
    --filter @workspace/api-server --filter @workspace/grant-user-portal run build

ls artifacts/api-server/dist/index.mjs artifacts/grant-user-portal/dist/public/index.html   # both must exist
```

## Step 7 — Push the database schema to Supabase (first deploy, and after schema changes)

Adds the tables/columns that so far exist only in Replit's database (`replit.md` → Gotchas).

```bash
cd /var/www/novabridgegrant
set -a; . /etc/novabridgegrant/api.env; set +a
pnpm --filter @workspace/db run push     # should print "using the supabase database"; answer its prompts
```

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

1. **Cloudflare DNS:** `access` → `A` record → `77.68.98.14` (the name already resolves somewhere today — replace that record), proxied (orange cloud).
2. **Certificate** — use whatever the other site already uses (from step 1):
   - **certbot present:**
     ```bash
     certbot --nginx -d access.novabridgegrant.org
     nginx -t && systemctl reload nginx
     ```
     If validation fails behind Cloudflare, switch the `access` record to *DNS only* (grey cloud), run certbot again, then switch it back.
   - **Cloudflare origin certificate:** Cloudflare → SSL/TLS → Origin Server → Create certificate for `access.novabridgegrant.org`; save as `/etc/ssl/novabridgegrant/origin.pem` and `origin.key` (`chmod 600` the key), then add a `listen 443 ssl;` server block with the same content as step 9 plus `ssl_certificate`/`ssl_certificate_key`, `nginx -t`, reload.
3. **Cloudflare → SSL/TLS mode:** Full (strict).
4. Check: `curl -sI https://access.novabridgegrant.org/ | head -5` and `curl -s https://access.novabridgegrant.org/api/healthz`.

## Step 11 — Outside services

- **Supabase** → Authentication → URL configuration: Site URL `https://access.novabridgegrant.org`; add `https://access.novabridgegrant.org/**` to Redirect URLs.
- **Resend:** sending domain verified; webhook URL `https://access.novabridgegrant.org/api/email/webhook`. Enter the Resend API key and webhook secret in the admin settings (they're stored encrypted with `SETTINGS_ENCRYPTION_KEY`).

## Step 12 — Smoke test

- [ ] Home page loads over HTTPS, refreshing a deep link (e.g. `/login`) doesn't 404
- [ ] Sign up → confirmation email arrives → sign in
- [ ] Upload a document → file appears in `/var/lib/novabridgegrant/documents`
- [ ] Super admin (`info@novabridgegrant.org`) signs in to the admin area
- [ ] The other app on this server still works

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
sh deploy/build.sh                      # install + build both apps; ends with "Build OK"
# Only if the schema changed:
#   (set -a; . /etc/novabridgegrant/api.env; set +a; PATH=/opt/novabridgegrant-node/bin:$PATH pnpm -F @workspace/db run push)
systemctl restart novabridgegrant-api
curl -s http://127.0.0.1:3100/api/healthz; echo
```

`deploy/build.sh` holds the build settings (port 3100, the public Supabase URL and anon key) and runs the build as the `novabridgegrant` user.

(nginx doesn't need a reload for code updates.)

## Server inventory (new VPS)

_Fill in from step 1's output on the new server._

| Question | Finding |
|---|---|
| Provider | IONOS VPS 1-2-60, UK data centre, created 27 Sep 2026; host name `1z0jt3t.cserverhost.cloud` |
| IP / SSH | `77.68.98.14` (IPv4 only, no IPv6); `ssh root@77.68.98.14`. The initial root password from IONOS must be changed on first login and is never written here |
| OS / resources (CPU, RAM, swap, disk) | Ubuntu 26.04; 1 vCore, 2 GB RAM, 60 GB NVMe (from IONOS — confirm swap in step 1) |
| Firewall | IONOS panel firewall ("My firewall policy") in front of the server — must allow 22, 80, 443; plus ufw on the server if enabled |
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
| TLS method | certbot (`certbot --nginx`, apt package) behind Cloudflare |
| Swap | 2 GB swap file `/swapfile` (the server had none; needed for the build on 1.8 GiB RAM) |
| GitHub access | read-only deploy key "novabridgegrant new VPS" (`SHA256:W1va3z6nBq9aB/iHAAJjtY6jQY3GRsBTCZunkRHyroU`) owned by `novabridgegrant` (`/home/novabridgegrant/.ssh/id_ed25519`); no access token needed for pulls. It grants nothing on the server itself. Revoke at GitHub → repo → Settings → Deploy keys |
| Build on the server | lean build: only `api-server` + `grant-user-portal`, no type check (it runs in Replit), one package at a time under `nice`. Safe on small servers; if it still runs out of memory, build in GitHub Actions and copy `dist/` over instead |

## Status

Preparation (27 Sep 2026):
- [x] Reviewed the app's structure and runtime needs; wrote this runbook.
- [x] Access decision: the owner runs the commands; Claude has no key on any server.
- [x] Step 0: `money-flows` merged into `main` and pushed; GitHub `main` is at `b930d1c`.

Old server `195.20.255.153` (abandoned 27 Sep 2026 — see "Old server — retired"):
- [x] Steps 1–4 reached (port 3100, private Node, user, deploy key, clone). Nothing was built, no service or nginx site was created.
- [x] 2026-09-27 — Cleanup: our folders, private Node, and the `novabridgegrant` user + home (deploy key) deleted; confirmed no service or nginx site of ours existed; final check shows every path and the user gone. Other apps untouched
- [x] 2026-09-27 — Old deploy key "novabridgegrant server" deleted on GitHub (owner confirmed)

New VPS — **plan for today (27 Sep 2026)**:
- [x] 2026-09-27 — Owner sent the new server's details: `77.68.98.14`, IONOS, Ubuntu 26.04, 1 vCore / 2 GB RAM / 60 GB
- [ ] Change the initial root password (`passwd`) — IONOS didn't force it on first login. **Deferred by the owner (27 Sep 2026) until after deployment — do it before calling the server done**
- [x] 2026-09-27 — Step 1: logged in and looked around; "Server inventory (new VPS)" filled in. Fresh server: no other apps, no nginx/certbot/Node/Docker, no swap, ufw off
- [ ] Check the IONOS panel firewall allows TCP 22, 80, 443
- [x] 2026-09-27 — Step 1b: 2 GB swap file `/swapfile` active and in `/etc/fstab`
- [x] 2026-09-27 — Step 1b: `apt upgrade` done (7 packages, no reboot or service restarts needed)
- [x] 2026-09-27 — Step 1b: nginx 1.28.3 and certbot 4.0.0 installed (apt; certbot renewal timer enabled)
- [x] 2026-09-27 — Step 2: API port `3100` (only 22 and 53 are in use)
- [x] 2026-09-27 — Step 3: private Node v24.21.0 + pnpm 10.34.5 in `/opt/novabridgegrant-node`
- [x] 2026-09-27 — Step 4: system user `novabridgegrant` and `/var/www/novabridgegrant` created
- [x] 2026-09-27 — Step 4: deploy key generated on the server (`SHA256:W1va3z6nBq9aB/iHAAJjtY6jQY3GRsBTCZunkRHyroU`)
- [x] 2026-09-27 — Step 4: key added on GitHub as "novabridgegrant new VPS", read-only (fingerprint matches)
- [x] 2026-09-27 — Step 4: cloned into `/var/www/novabridgegrant` at `b930d1c` (matches GitHub `main`)
- [x] 2026-09-27 — Step 5: data folders created; `api.env` has its 12 non-database lines (checked)
- [x] 2026-09-27 — Step 5: `SUPABASE_DATABASE_URL` (session pooler) added; file locked (`640`, `root:novabridgegrant`); 13 lines
- [x] 2026-09-27 — Step 6: `pnpm install` (503 packages) and API build done
- [x] 2026-09-27 — Step 6: portal built (vite, 16 s) after passing its settings with `sudo --preserve-env=…` (`sudo -E` is refused here); both `dist` files exist
- [x] 2026-09-27 — Step 7: schema pushed to Supabase through the pooler ("Changes applied", no drop/rename prompts). `INITIAL_SUPER_ADMIN_NAME` value quoted so the env file can be sourced by a shell
- [ ] Step 8 — API as a systemd service; `/api/healthz` answers
- [ ] Step 9 — nginx site (HTTP)
- [ ] Step 10 — Cloudflare `access` record → new IP; HTTPS with certbot; SSL mode Full (strict)
- [ ] Steps 11–13 — Supabase URLs, Resend webhook, smoke test, backups
- [ ] After go-live: reset the Supabase database password (it was typed into the chat on 27 Sep 2026), then update `SUPABASE_DATABASE_URL` in `api.env` and `systemctl restart novabridgegrant-api`
- [ ] After go-live: change the VPS root password (`passwd`)

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
