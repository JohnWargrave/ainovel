#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
test_dir="$(mktemp -d /tmp/ainovel-referral-nginx.XXXXXX)"
trap 'rm -rf "${test_dir}"' EXIT

fingerprint='14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5'

REFERRAL_LINK_HOST=link.ainovel.test \
  GOOGLE_PLAY_PACKAGE_NAME=com.ainovel.app \
  ANDROID_SHA256_CERT_FINGERPRINT="${fingerprint}" \
  "${script_dir}/render.sh" "${test_dir}"

jq -e \
  --arg fingerprint "${fingerprint}" \
  '.[0].target.package_name == "com.ainovel.app" and
   .[0].target.sha256_cert_fingerprints == [$fingerprint]' \
  "${test_dir}/www/assetlinks.json" >/dev/null

grep -Fq 'server_name link.ainovel.test;' "${test_dir}/conf.d/referral-links.conf"
grep -Fq 'id=com.ainovel.app&referrer=code%3D$referral_code' \
  "${test_dir}/conf.d/referral-links.conf"

if command -v docker >/dev/null 2>&1; then
  docker run --rm \
    -v "${test_dir}/conf.d/referral-links.conf:/etc/nginx/conf.d/referral-links.conf:ro" \
    -v "${test_dir}/www:${test_dir}/www:ro" \
    nginx:1.27-alpine nginx -t
else
  echo 'Skipping nginx -t: Docker is not installed' >&2
fi

echo 'Referral-link Nginx configuration passed'
