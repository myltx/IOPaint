#!/bin/bash
set -euo pipefail

APP_NAME="${APP_NAME:-IOPaint}"
APP_ID="${APP_ID:-local.iopaint.app}"
APP_VERSION="${APP_VERSION:-1.0.0}"
PRELOAD_LAMA_MODEL_PATH="${PRELOAD_LAMA_MODEL_PATH:-}"
BUNDLE_RUNTIME="${BUNDLE_RUNTIME:-1}"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
BUILD_DIR="${DIST_DIR}/build"
APP_DIR="${DIST_DIR}/${APP_NAME}.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RES_DIR="${CONTENTS_DIR}/Resources"
DMG_STAGING_DIR="${DIST_DIR}/dmg"
DMG_PATH="${DIST_DIR}/${APP_NAME}-arm64.dmg"

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: missing command '$1'" >&2
    exit 1
  fi
}

assert_env() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Error: this script must run on macOS." >&2
    exit 1
  fi
  if [[ "$(uname -m)" != "arm64" ]]; then
    echo "Warning: current arch is $(uname -m), target dmg name is arm64." >&2
  fi

  require_cmd npm
  require_cmd hdiutil
  require_cmd python3
}

build_web() {
  log "Build web_app"
  pushd "${ROOT_DIR}/web_app" >/dev/null
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
  npm run build
  popd >/dev/null
}

prepare_dirs() {
  rm -rf "${BUILD_DIR}" "${APP_DIR}" "${DMG_STAGING_DIR}" "${DMG_PATH}"
  mkdir -p "${BUILD_DIR}" "${MACOS_DIR}" "${RES_DIR}"
}

bundle_source() {
  local bundle_src="${BUILD_DIR}/src"
  mkdir -p "${bundle_src}"

  cp -R "${ROOT_DIR}/iopaint" "${bundle_src}/"
  cp "${ROOT_DIR}/main.py" "${bundle_src}/"
  cp "${ROOT_DIR}/requirements.txt" "${bundle_src}/"

  rm -rf "${bundle_src}/iopaint/web_app"
  cp -R "${ROOT_DIR}/web_app/dist" "${bundle_src}/iopaint/web_app"
}

bundle_runtime() {
  if [[ "${BUNDLE_RUNTIME}" != "1" ]]; then
    log "Skip runtime bundling (BUNDLE_RUNTIME=${BUNDLE_RUNTIME})"
    return
  fi

  local runtime_dir="${BUILD_DIR}/runtime"
  log "Build bundled python runtime (first time may take a while)"
  /usr/bin/python3 -m venv "${runtime_dir}"
  "${runtime_dir}/bin/python3" -m pip install -U pip
  "${runtime_dir}/bin/pip" install -r "${ROOT_DIR}/requirements.txt"
  printf '%s\n' "${APP_VERSION}" > "${runtime_dir}/.bundle_version"
}

bundle_preload_model() {
  local model_path="${PRELOAD_LAMA_MODEL_PATH}"
  if [[ -z "${model_path}" && -f "${ROOT_DIR}/big-lama.pt" ]]; then
    model_path="${ROOT_DIR}/big-lama.pt"
  fi
  if [[ -z "${model_path}" && -f "${HOME}/Desktop/big-lama.pt" ]]; then
    model_path="${HOME}/Desktop/big-lama.pt"
  fi

  if [[ -n "${model_path}" ]]; then
    if [[ ! -f "${model_path}" ]]; then
      echo "Error: PRELOAD_LAMA_MODEL_PATH not found: ${model_path}" >&2
      exit 1
    fi
    mkdir -p "${BUILD_DIR}/preload_models"
    cp "${model_path}" "${BUILD_DIR}/preload_models/big-lama.pt"
    log "Preload model bundled: ${model_path}"
  else
    log "No local big-lama.pt found, app will download model on first launch"
  fi
}

write_plist() {
  cat > "${CONTENTS_DIR}/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${APP_ID}</string>
  <key>CFBundleVersion</key><string>${APP_VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${APP_VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict>
</plist>
EOF
}

write_launcher() {
  cat > "${MACOS_DIR}/launcher" <<'EOF'
#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

APP_NAME="IOPaint"
PORT="${IOPAINT_PORT:-8080}"
HOST="${IOPAINT_HOST:-127.0.0.1}"
MODEL="${IOPAINT_MODEL:-lama}"
DEVICE="${IOPAINT_DEVICE:-mps}"
BOOT_MODE="${1:-}"

RES_DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
BUNDLE_SRC_DIR="${RES_DIR}/src"
BUNDLED_RUNTIME_DIR="${RES_DIR}/runtime"
BASE_DIR="${HOME}/Library/Application Support/${APP_NAME}"
SRC_DIR="${BASE_DIR}/src"
RUNTIME_DIR="${BASE_DIR}/runtime"
MODEL_DIR="${BASE_DIR}/models"
OUTPUT_DIR="${HOME}/Pictures/IOPaint-output"
LOG_DIR="${HOME}/Library/Logs/${APP_NAME}"
LOG_FILE="${LOG_DIR}/app.log"
VERSION_FILE="${BUNDLE_SRC_DIR}/.bundle_version"
BUNDLED_RUNTIME_VERSION_FILE="${BUNDLED_RUNTIME_DIR}/.bundle_version"
BUNDLED_RUNTIME_VERSION="unknown"
BUNDLED_LAMA_PATH="${RES_DIR}/preload_models/big-lama.pt"
BUNDLED_LAMA_TARGET="${MODEL_DIR}/torch/hub/checkpoints/big-lama.pt"
CURRENT_VERSION="unknown"

mkdir -p "${BASE_DIR}" "${MODEL_DIR}" "${OUTPUT_DIR}" "${LOG_DIR}"

if [[ -f "${VERSION_FILE}" ]]; then
  CURRENT_VERSION="$(cat "${VERSION_FILE}")"
fi
if [[ -f "${BUNDLED_RUNTIME_VERSION_FILE}" ]]; then
  BUNDLED_RUNTIME_VERSION="$(cat "${BUNDLED_RUNTIME_VERSION_FILE}")"
fi

sync_source_if_needed() {
  local local_version_file="${SRC_DIR}/.bundle_version"
  local local_version=""
  if [[ -f "${local_version_file}" ]]; then
    local_version="$(cat "${local_version_file}")"
  fi
  if [[ ! -d "${SRC_DIR}" || "${local_version}" != "${CURRENT_VERSION}" ]]; then
    rm -rf "${SRC_DIR}"
    mkdir -p "${SRC_DIR}"
    cp -R "${BUNDLE_SRC_DIR}/." "${SRC_DIR}/"
  fi
}

ensure_runtime() {
  local runtime_python="${RUNTIME_DIR}/bin/python3"
  local runtime_version_file="${RUNTIME_DIR}/.bundle_version"
  local local_runtime_version=""
  local need_rebuild=0

  if [[ ! -x "${runtime_python}" ]]; then
    need_rebuild=1
  fi

  if [[ -f "${runtime_version_file}" ]]; then
    local_runtime_version="$(cat "${runtime_version_file}")"
  fi
  if [[ "${BUNDLED_RUNTIME_VERSION}" != "unknown" && "${local_runtime_version}" != "${BUNDLED_RUNTIME_VERSION}" ]]; then
    need_rebuild=1
  fi

  if [[ "${need_rebuild}" -eq 0 ]]; then
    if ! "${runtime_python}" -c "import torch, fastapi, cv2" >/dev/null 2>&1; then
      need_rebuild=1
    fi
  fi

  if [[ "${need_rebuild}" -eq 1 ]]; then
    if [[ -x "${BUNDLED_RUNTIME_DIR}/bin/python3" ]]; then
      rm -rf "${RUNTIME_DIR}"
      cp -R "${BUNDLED_RUNTIME_DIR}" "${RUNTIME_DIR}"
    else
      rm -rf "${RUNTIME_DIR}"
      /usr/bin/python3 -m venv "${RUNTIME_DIR}"
      "${RUNTIME_DIR}/bin/python3" -m pip install -U pip
      "${RUNTIME_DIR}/bin/pip" install -r "${SRC_DIR}/requirements.txt"
      printf '%s\n' "${CURRENT_VERSION}" > "${runtime_version_file}"
    fi
  fi
}

ensure_bundled_model() {
  if [[ -f "${BUNDLED_LAMA_PATH}" && ! -f "${BUNDLED_LAMA_TARGET}" ]]; then
    mkdir -p "$(dirname "${BUNDLED_LAMA_TARGET}")"
    cp "${BUNDLED_LAMA_PATH}" "${BUNDLED_LAMA_TARGET}"
  fi
}

is_running() {
  lsof -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1
}

open_ui() {
  open "http://${HOST}:${PORT}"
}

start_backend() {
  nohup "${RUNTIME_DIR}/bin/python3" "${SRC_DIR}/main.py" start \
    --host "${HOST}" \
    --port "${PORT}" \
    --model "${MODEL}" \
    --device "${DEVICE}" \
    --model-dir "${MODEL_DIR}" \
    --output-dir "${OUTPUT_DIR}" \
    > "${LOG_FILE}" 2>&1 &
}

wait_for_server() {
  local max_wait=120
  local i=0
  while [[ $i -lt $max_wait ]]; do
    if is_running; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

if [[ "${BOOT_MODE}" == "--boot" ]]; then
  exec >> "${LOG_FILE}" 2>&1
  echo "==== IOPaint boot begin: $(date '+%F %T') ===="
  sync_source_if_needed
  ensure_runtime
  ensure_bundled_model
  if ! is_running; then
    start_backend
  fi
  if wait_for_server; then
    open_ui || true
  else
    echo "Server did not become ready within timeout."
  fi
  echo "==== IOPaint boot end: $(date '+%F %T') ===="
  exit 0
fi

if is_running; then
  open_ui
  exit 0
fi

nohup "$0" --boot >/dev/null 2>&1 &
exit 0
EOF
  chmod +x "${MACOS_DIR}/launcher"
}

stage_resources() {
  cp -R "${BUILD_DIR}/src" "${RES_DIR}/"
  if [[ -d "${BUILD_DIR}/runtime" ]]; then
    cp -R "${BUILD_DIR}/runtime" "${RES_DIR}/"
  fi
  if [[ -d "${BUILD_DIR}/preload_models" ]]; then
    cp -R "${BUILD_DIR}/preload_models" "${RES_DIR}/"
  fi
  printf '%s\n' "${APP_VERSION}" > "${RES_DIR}/src/.bundle_version"
}

create_dmg() {
  mkdir -p "${DMG_STAGING_DIR}"
  cp -R "${APP_DIR}" "${DMG_STAGING_DIR}/"
  ln -s /Applications "${DMG_STAGING_DIR}/Applications"
  hdiutil create \
    -volname "${APP_NAME}" \
    -srcfolder "${DMG_STAGING_DIR}" \
    -ov \
    -format UDZO \
    "${DMG_PATH}" >/dev/null
}

main() {
  assert_env
  prepare_dirs
  build_web
  bundle_source
  bundle_runtime
  bundle_preload_model
  write_plist
  write_launcher
  stage_resources
  create_dmg

  log "Done"
  log "App: ${APP_DIR}"
  log "DMG: ${DMG_PATH}"
}

main "$@"
