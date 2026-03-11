#!/bin/bash
set -euo pipefail

APP_NAME="${APP_NAME:-IOPaint}"
APP_VERSION="${APP_VERSION:-1.0.1}"
PRELOAD_LAMA_MODEL_PATH="${PRELOAD_LAMA_MODEL_PATH:-}"
BUNDLE_RUNTIME="${BUNDLE_RUNTIME:-1}"
RUNTIME_MODE="${RUNTIME_MODE:-copies-v1}"

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="${ROOT_DIR}/web_app"
DESKTOP_DIR="${ROOT_DIR}/desktop_app"
BACKEND_DIR="${DESKTOP_DIR}/backend"
BACKEND_SRC_DIR="${BACKEND_DIR}/src"
BACKEND_RUNTIME_DIR="${BACKEND_DIR}/runtime"
BACKEND_MODELS_DIR="${BACKEND_DIR}/preload_models"
DIST_DIR="${ROOT_DIR}/dist"

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
  require_cmd npm
  require_cmd python3
  require_cmd hdiutil
}

build_web() {
  log "Build web_app"
  pushd "${WEB_DIR}" >/dev/null
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
  npm run build
  popd >/dev/null
}

prepare_backend() {
  log "Prepare backend bundle"
  rm -rf "${BACKEND_SRC_DIR}" "${BACKEND_MODELS_DIR}"
  mkdir -p "${BACKEND_SRC_DIR}" "${BACKEND_MODELS_DIR}"

  cp -R "${ROOT_DIR}/iopaint" "${BACKEND_SRC_DIR}/"
  cp "${ROOT_DIR}/main.py" "${BACKEND_SRC_DIR}/"
  cp "${ROOT_DIR}/requirements.txt" "${BACKEND_SRC_DIR}/"

  rm -rf "${BACKEND_SRC_DIR}/iopaint/web_app"
  cp -R "${WEB_DIR}/dist" "${BACKEND_SRC_DIR}/iopaint/web_app"
}

bundle_runtime() {
  if [[ "${BUNDLE_RUNTIME}" != "1" ]]; then
    log "Skip runtime bundling (BUNDLE_RUNTIME=${BUNDLE_RUNTIME})"
    return
  fi

  if [[ -x "${BACKEND_RUNTIME_DIR}/bin/python3" \
    && -f "${BACKEND_RUNTIME_DIR}/.bundle_version" \
    && -f "${BACKEND_RUNTIME_DIR}/.runtime_mode" ]]; then
    local runtime_version
    local runtime_mode
    runtime_version="$(cat "${BACKEND_RUNTIME_DIR}/.bundle_version")"
    runtime_mode="$(cat "${BACKEND_RUNTIME_DIR}/.runtime_mode")"
    if [[ "${runtime_version}" == "${APP_VERSION}" && "${runtime_mode}" == "${RUNTIME_MODE}" ]]; then
      if "${BACKEND_RUNTIME_DIR}/bin/python3" -c "import sys" >/dev/null 2>&1; then
        log "Reuse bundled python runtime (${runtime_version}, ${runtime_mode})"
        return
      fi
    fi
  fi

  log "Build bundled python runtime (${RUNTIME_MODE})"
  rm -rf "${BACKEND_RUNTIME_DIR}"
  /usr/bin/python3 -m venv --copies "${BACKEND_RUNTIME_DIR}"
  "${BACKEND_RUNTIME_DIR}/bin/python3" -m pip install -U pip
  "${BACKEND_RUNTIME_DIR}/bin/pip" install -r "${BACKEND_SRC_DIR}/requirements.txt"
  printf '%s\n' "${APP_VERSION}" > "${BACKEND_RUNTIME_DIR}/.bundle_version"
  printf '%s\n' "${RUNTIME_MODE}" > "${BACKEND_RUNTIME_DIR}/.runtime_mode"
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
    cp "${model_path}" "${BACKEND_MODELS_DIR}/big-lama.pt"
    log "Preload model bundled: ${model_path}"
  else
    log "No local big-lama.pt found, app will download model on first launch"
  fi
}

build_electron() {
  log "Build Electron app"
  pushd "${DESKTOP_DIR}" >/dev/null
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
  npm run dist
  popd >/dev/null
}

main() {
  assert_env
  mkdir -p "${DIST_DIR}"
  build_web
  prepare_backend
  bundle_runtime
  bundle_preload_model
  build_electron

  log "Done"
  ls -lh "${DESKTOP_DIR}/dist_electron" | sed -n '1,6p'
}

main "$@"
