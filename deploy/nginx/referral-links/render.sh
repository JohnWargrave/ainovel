#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
output_dir="${1:-${script_dir}/generated}"

: "${REFERRAL_LINK_HOST:?Set REFERRAL_LINK_HOST, for example link.ainovel.com}"
: "${GOOGLE_PLAY_PACKAGE_NAME:?Set GOOGLE_PLAY_PACKAGE_NAME to the Android applicationId}"
: "${ANDROID_SHA256_CERT_FINGERPRINT:?Set ANDROID_SHA256_CERT_FINGERPRINT from Play App Signing}"

if [[ ! "${REFERRAL_LINK_HOST}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] ||
  [[ "${REFERRAL_LINK_HOST}" != *.* ]]; then
  echo "REFERRAL_LINK_HOST must be a lowercase DNS hostname" >&2
  exit 1
fi

if [[ ! "${GOOGLE_PLAY_PACKAGE_NAME}" =~ ^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$ ]]; then
  echo "GOOGLE_PLAY_PACKAGE_NAME must be a valid Android applicationId" >&2
  exit 1
fi

if [[ ! "${ANDROID_SHA256_CERT_FINGERPRINT}" =~ ^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$ ]]; then
  echo "ANDROID_SHA256_CERT_FINGERPRINT must contain 32 colon-separated hex bytes" >&2
  exit 1
fi

mkdir -p "${output_dir}"
output_dir="$(cd -- "${output_dir}" && pwd)"
REFERRAL_LINK_ASSET_DIR="${output_dir}/www"
export REFERRAL_LINK_HOST GOOGLE_PLAY_PACKAGE_NAME REFERRAL_LINK_ASSET_DIR
ANDROID_SHA256_CERT_FINGERPRINT="${ANDROID_SHA256_CERT_FINGERPRINT^^}"
export ANDROID_SHA256_CERT_FINGERPRINT

mkdir -p "${output_dir}/conf.d" "${REFERRAL_LINK_ASSET_DIR}"

envsubst '${REFERRAL_LINK_HOST} ${GOOGLE_PLAY_PACKAGE_NAME} ${REFERRAL_LINK_ASSET_DIR}' \
  <"${script_dir}/referral-links.conf.template" \
  >"${output_dir}/conf.d/referral-links.conf"

envsubst '${GOOGLE_PLAY_PACKAGE_NAME} ${ANDROID_SHA256_CERT_FINGERPRINT}' \
  <"${script_dir}/assetlinks.json.template" \
  >"${REFERRAL_LINK_ASSET_DIR}/assetlinks.json"

echo "Rendered Nginx config: ${output_dir}/conf.d/referral-links.conf"
echo "Rendered asset links:  ${REFERRAL_LINK_ASSET_DIR}/assetlinks.json"
