#!/bin/sh
# Install and build the API and portal on the VPS. Run as root from anywhere:
#   sh /var/www/novabridgegrant/deploy/build.sh
set -eu
cd /var/www/novabridgegrant
export PATH=/opt/novabridgegrant-node/bin:$PATH
export NODE_ENV=production PORT=3100 BASE_PATH=/
export VITE_SUPABASE_URL=https://tynjqjukramcmtotgfdw.supabase.co
export VITE_SUPABASE_ANON_KEY=sb_publishable_9TfKJrlrzqYmtZBnwUdibw_g2wPKQS8
KEEP=NODE_ENV,PORT,BASE_PATH,VITE_SUPABASE_URL,VITE_SUPABASE_ANON_KEY
as_app() { sudo --preserve-env=$KEEP -u novabridgegrant env PATH="$PATH" "$@"; }

as_app env CI=true pnpm install --frozen-lockfile
as_app nice -n 10 pnpm -F @workspace/api-server run build
as_app nice -n 10 pnpm -F @workspace/grant-user-portal run build
chmod -R o+rX artifacts/grant-user-portal/dist
ls -l artifacts/api-server/dist/index.mjs artifacts/grant-user-portal/dist/public/index.html
echo "Build OK"
