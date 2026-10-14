#!/usr/bin/env bash
# Deploy the web app to LXC 136 (pocketprint) and verify what is actually served.
#
#   ./deploy.sh            push web/ and verify over LAN + public HTTPS
#   ./deploy.sh --dry-run  show what would be pushed, touch nothing
#
# The site is three static files behind nginx. There is no build step and no
# server-side anything, so "deploy" is: copy, then prove the bytes match on both
# paths (LAN origin and the Cloudflare tunnel).
set -euo pipefail

PROXMOX_HOST="root@192.168.0.2"
SSH_KEY="$HOME/.ssh/proxmox_hermes"
VMID=136
ORIGIN_IP="192.168.0.221"
PUBLIC_URL="https://print.otelo2.com"
WEB_DIR="$(cd "$(dirname "$0")" && pwd)/web"
FILES=(index.html funnyprint.js)
REMOTE_TMP="/root/pocketprint-web.tar.gz"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

echo "== packaging ${FILES[*]} =="
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
for f in "${FILES[@]}"; do
  cp "$WEB_DIR/$f" "$staging/$f"
done

# Cloudflare caches .js at its edge on its own TTL and cannot be purged with this token, so
# stamp the script URL with the file's hash. A changed file means a changed URL, which is
# the only cache-busting that also survives the edge.
build="$(sha256sum "$staging/funnyprint.js" | cut -c1-12)"
sed -i "s#funnyprint\.js?v=[^\"']*#funnyprint.js?v=${build}#" "$staging/index.html" 2>/dev/null \
  || sed -i '' "s#funnyprint\.js?v=[^\"']*#funnyprint.js?v=${build}#" "$staging/index.html"
echo "   build stamp: ${build}"
grep -o 'funnyprint\.js?v=[a-f0-9]*' "$staging/index.html" | sed 's/^/   /'

tar czf "$staging/pocketprint-web.tar.gz" -C "$staging" "${FILES[@]}"
echo "   $(du -h "$staging/pocketprint-web.tar.gz" | cut -f1) -> $REMOTE_TMP"

sha_local=$(cd "$staging" && sha256sum "${FILES[@]}")
echo "== local digests =="
echo "$sha_local" | sed 's/^/   /'

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
echo "== verify on the LAN origin =="
for f in "${FILES[@]}"; do
  remote=$(curl -sS --max-time 15 "http://$ORIGIN_IP/$f" | sha256sum | cut -d' ' -f1)
  local_sum=$(cd "$staging" && sha256sum "$f" | cut -d' ' -f1)
  if [[ "$remote" == "$local_sum" ]]; then
    echo "   OK   $f  ${remote:0:16}"
  else
    echo "   FAIL $f  served=${remote:0:16} expected=${local_sum:0:16}"; fail=1
  fi
done

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
