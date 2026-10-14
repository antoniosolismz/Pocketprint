#!/usr/bin/env bash
# Deploy the web app to LXC 136 (pocketprint) and verify what is actually served.
#
#   ./deploy.sh            push web/ and verify over LAN + public HTTPS
#   ./deploy.sh --dry-run  show what would be pushed, touch nothing
#
# The site is a directory of static files behind nginx. There is no build step and no
# server-side anything, so "deploy" is: copy, then prove the bytes match on both paths
# (LAN origin and the Cloudflare tunnel).
set -euo pipefail

PROXMOX_HOST="root@192.168.0.2"
SSH_KEY="$HOME/.ssh/proxmox_hermes"
VMID=136
ORIGIN_IP="192.168.0.221"
PUBLIC_URL="https://print.otelo2.com"
WEB_DIR="$(cd "$(dirname "$0")" && pwd)/web"
REMOTE_TMP="/root/pocketprint-web.tar.gz"

FILES=(
  index.html
  funnyprint.js
  codes.js
  label.js
  sw.js
  manifest.webmanifest
  vendor/qrcode.js
  vendor/code128-table.js
  icons/icon-192.png
  icons/icon-512.png
  icons/icon-maskable-512.png
  icons/apple-touch-icon-180.png
)

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

echo "== packaging ${#FILES[@]} files =="
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
for f in "${FILES[@]}"; do
  install -D -m 644 "$WEB_DIR/$f" "$staging/$f"
done

# Cloudflare rewrites responses to max-age=14400 regardless of the origin's no-cache, so a
# script whose URL never changes is cached in the browser for four hours — long enough for a
# new page to run against an old library. That is exactly how the label previews broke: the
# page gained a call to label.js#absoluteLayout and the browser kept serving the previous
# label.js. Stamping every script URL with the build hash makes a mixture impossible: a
# changed build means a changed URL, which no cache has an entry for.
build="$(cat "$staging/funnyprint.js" "$staging/codes.js" "$staging/label.js" \
             "$staging/vendor/qrcode.js" "$staging/vendor/code128-table.js" | sha256sum | cut -c1-12)"
echo "   build stamp: ${build}"

for asset in funnyprint.js codes.js label.js vendor/qrcode.js vendor/code128-table.js; do
  if grep -q "src=\"${asset}?v=" "$staging/index.html"; then
    sed -i "s#src=\"${asset}?v=[^\"]*\"#src=\"${asset}?v=${build}\"#" "$staging/index.html"
  else
    sed -i "s#src=\"${asset}\"#src=\"${asset}?v=${build}\"#" "$staging/index.html"
  fi
done
grep -o 'src="[^"]*?v=[a-f0-9]*"' "$staging/index.html" | sed 's/^/   /'

# and give the service worker a fresh cache bucket per deploy, so old ones get dropped
sed -i "s/pocketprint-__BUILD__/pocketprint-${build}/" "$staging/sw.js"
grep -o "pocketprint-[a-f0-9]*" "$staging/sw.js" | sed 's/^/   sw cache: /'

tar czf "$staging/pocketprint-web.tar.gz" -C "$staging" "${FILES[@]}"
echo "   $(du -h "$staging/pocketprint-web.tar.gz" | cut -f1) -> $REMOTE_TMP"

echo "== local digests =="
(cd "$staging" && sha256sum "${FILES[@]}") | sed 's/^/   /'

if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry run: nothing pushed"
  exit 0
fi

echo "== pushing to LXC $VMID =="
scp -q -i "$SSH_KEY" "$staging/pocketprint-web.tar.gz" "$PROXMOX_HOST:$REMOTE_TMP"
ssh -i "$SSH_KEY" "$PROXMOX_HOST" "set -e
  pct push $VMID $REMOTE_TMP $REMOTE_TMP
  pct exec $VMID -- bash -c 'rm -rf /var/www/pocketprint && mkdir -p /var/www/pocketprint \
    && tar xzf $REMOTE_TMP -C /var/www/pocketprint \
    && chown -R www-data:www-data /var/www/pocketprint \
    && rm -f $REMOTE_TMP'
  rm -f $REMOTE_TMP"

fail=0
verify_against() {
  local base="$1" label="$2"
  echo "== verify on $label =="
  for f in "${FILES[@]}"; do
    remote=$(curl -sS --max-time 25 "$base/$f" | sha256sum | cut -d' ' -f1)
    local_sum=$(cd "$staging" && sha256sum "$f" | cut -d' ' -f1)
    if [[ "$remote" == "$local_sum" ]]; then
      echo "   OK   $f  ${remote:0:16}"
    else
      echo "   FAIL $f  served=${remote:0:16} expected=${local_sum:0:16}"; fail=1
    fi
  done
}

verify_against "http://$ORIGIN_IP" "the LAN origin"

echo "== verify through the Cloudflare tunnel (may take a few seconds to propagate) =="
for attempt in 1 2 3 4 5; do
  ok=1
  for f in "${FILES[@]}"; do
    remote=$(curl -sS --max-time 20 "$PUBLIC_URL/$f" | sha256sum | cut -d' ' -f1)
    local_sum=$(cd "$staging" && sha256sum "$f" | cut -d' ' -f1)
    [[ "$remote" == "$local_sum" ]] || ok=0
  done
  [[ "$ok" == "1" ]] && break
  sleep 4
done
for f in "${FILES[@]}"; do
  remote=$(curl -sS --max-time 20 "$PUBLIC_URL/$f" | sha256sum | cut -d' ' -f1)
  local_sum=$(cd "$staging" && sha256sum "$f" | cut -d' ' -f1)
  if [[ "$remote" == "$local_sum" ]]; then
    echo "   OK   $f  ${remote:0:16}"
  else
    echo "   FAIL $f  served=${remote:0:16} expected=${local_sum:0:16} (edge cache? try again in a minute)"; fail=1
  fi
done

if [[ "$fail" == "0" ]]; then
  echo "== deployed and verified =="
else
  echo "== DEPLOY INCOMPLETE ==" >&2
  exit 1
fi
