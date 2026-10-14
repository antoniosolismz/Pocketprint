#!/usr/bin/env bash
# Deploy the web app to a container on a Proxmox host and verify what is actually served.
#
#   ./deploy.sh            push web/ and verify over the LAN origin + the public name
#   ./deploy.sh --dry-run  show what would be pushed, touch nothing
#
# The site is a directory of static files behind nginx. There is no build step and no
# server-side anything, so "deploy" is: copy, then prove the bytes match on both paths.
#
# The target is configuration, not code: export the variables below, or copy
# deploy.local.example.sh to deploy.local.sh (gitignored) and fill it in.
#
#   POCKETPRINT_PROXMOX_HOST  ssh target of the Proxmox host    root@proxmox.example
#   POCKETPRINT_SSH_KEY       ssh private key for that host     ~/.ssh/proxmox_deploy
#   POCKETPRINT_VMID          container id to push into         136
#   POCKETPRINT_ORIGIN_IP     LAN address of that container     192.0.2.20
#   POCKETPRINT_PUBLIC_URL    public HTTPS name                 https://print.example.com
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
[[ -f "$HERE/deploy.local.sh" ]] && . "$HERE/deploy.local.sh"

PROXMOX_HOST="${POCKETPRINT_PROXMOX_HOST:-}"
SSH_KEY="${POCKETPRINT_SSH_KEY:-}"
VMID="${POCKETPRINT_VMID:-}"
ORIGIN_IP="${POCKETPRINT_ORIGIN_IP:-}"
PUBLIC_URL="${POCKETPRINT_PUBLIC_URL:-}"
WEB_DIR="$HERE/web"
REMOTE_TMP="/root/pocketprint-web.tar.gz"

missing=()
for name in PROXMOX_HOST SSH_KEY VMID ORIGIN_IP PUBLIC_URL; do
  [[ -n "${!name:-}" ]] || missing+=("POCKETPRINT_${name}")
done
if (( ${#missing[@]} )); then
  echo "deploy.sh needs a target:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo >&2
  echo "Copy deploy.local.example.sh to deploy.local.sh and fill it in, or export those" >&2
  echo "variables. Nothing was pushed." >&2
  exit 2
fi

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
