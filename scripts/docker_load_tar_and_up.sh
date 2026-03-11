#!/usr/bin/env bash
set -euo pipefail

# Load docker image tar/tar.gz and start service by docker-compose.yml.
#
# Example:
#   scripts/docker_load_tar_and_up.sh --tar /tmp/iopaint-cpu-linux-amd64.tar.gz --model /tmp/big-lama.pt
#   scripts/docker_load_tar_and_up.sh \
#     --tar /tmp/iopaint-cpu-linux-amd64.tar.gz \
#     --model /home/iopaint_data/data/models/big-lama.pt \
#     --mem-limit 1200m \
#     --cpus 1.2 \
#     --compose /opt/iopaint/docker-compose.yml
#   scripts/docker_load_tar_and_up.sh \
#     --skip-load \
#     --image iopaint:cpu \
#     --model /home/iopaint_data/data/models/big-lama.pt

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TAR_PATH=""
SKIP_LOAD="0"
MODEL_PATH=""
COMPOSE_FILE="docker-compose.yml"
IMAGE="iopaint:cpu"
CONTAINER_NAME="iopaint"
PORT="8080"
MODELS_DIR="/opt/iopaint/models"
OUTPUT_DIR="/opt/iopaint/output"
MEM_LIMIT="1200m"
MEMSWAP_LIMIT="2g"
CPUS="1.20"
SHM_SIZE="256m"
PIDS_LIMIT="256"

usage() {
  cat <<EOF
Usage: $0 [options]

Required (choose one):
  --tar <path>          Docker image tar/tar.gz path
  --skip-load           Skip loading tar, use existing local image

Options:
  --model <path>        Optional local big-lama.pt path to copy into models dir
  --compose <path>      Compose file path (default: ${COMPOSE_FILE})
  --image <name>        Docker image tag (default: ${IMAGE})
  --container-name <n>  Container name (default: ${CONTAINER_NAME})
  --port <port>         Host port (default: ${PORT})
  --models-dir <path>   Host models dir (default: ${MODELS_DIR})
  --output-dir <path>   Host output dir (default: ${OUTPUT_DIR})
  --mem-limit <value>   Container memory limit, e.g. 1200m/2g (default: ${MEM_LIMIT})
  --memswap-limit <v>   Container memory+swap limit (default: ${MEMSWAP_LIMIT})
  --cpus <value>        CPU cores limit, e.g. 1.2 (default: ${CPUS})
  --shm-size <value>    /dev/shm size (default: ${SHM_SIZE})
  --pids-limit <value>  PIDs limit (default: ${PIDS_LIMIT})
  -h, --help            Show this help
EOF
}

require_arg() {
  local opt="$1"
  local val="${2:-}"
  if [[ -z "${val}" ]] || [[ "${val}" == --* ]]; then
    echo "Error: ${opt} requires a value." >&2
    usage
    exit 1
  fi
}

resolve_existing_path() {
  local raw="$1"
  local root_fallback="${2:-}"

  if [[ "${raw}" == /* ]]; then
    if [[ -f "${raw}" ]]; then
      echo "${raw}"
      return 0
    fi
    return 1
  fi

  if [[ -f "${raw}" ]]; then
    echo "$(cd "$(dirname "${raw}")" && pwd)/$(basename "${raw}")"
    return 0
  fi

  if [[ -f "${SCRIPT_DIR}/${raw}" ]]; then
    echo "${SCRIPT_DIR}/${raw}"
    return 0
  fi

  if [[ -n "${root_fallback}" ]] && [[ -f "${root_fallback}/${raw}" ]]; then
    echo "${root_fallback}/${raw}"
    return 0
  fi

  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tar)
      require_arg "$1" "${2:-}"
      TAR_PATH="$2"
      shift 2
      ;;
    --skip-load)
      SKIP_LOAD="1"
      shift
      ;;
    --model)
      require_arg "$1" "${2:-}"
      MODEL_PATH="$2"
      shift 2
      ;;
    --compose)
      require_arg "$1" "${2:-}"
      COMPOSE_FILE="$2"
      shift 2
      ;;
    --image)
      require_arg "$1" "${2:-}"
      IMAGE="$2"
      shift 2
      ;;
    --container-name)
      require_arg "$1" "${2:-}"
      CONTAINER_NAME="$2"
      shift 2
      ;;
    --port)
      require_arg "$1" "${2:-}"
      PORT="$2"
      shift 2
      ;;
    --models-dir)
      require_arg "$1" "${2:-}"
      MODELS_DIR="$2"
      shift 2
      ;;
    --output-dir)
      require_arg "$1" "${2:-}"
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --mem-limit)
      require_arg "$1" "${2:-}"
      MEM_LIMIT="$2"
      shift 2
      ;;
    --memswap-limit)
      require_arg "$1" "${2:-}"
      MEMSWAP_LIMIT="$2"
      shift 2
      ;;
    --cpus)
      require_arg "$1" "${2:-}"
      CPUS="$2"
      shift 2
      ;;
    --shm-size)
      require_arg "$1" "${2:-}"
      SHM_SIZE="$2"
      shift 2
      ;;
    --pids-limit)
      require_arg "$1" "${2:-}"
      PIDS_LIMIT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker command not found." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Error: docker compose is required." >&2
  exit 1
fi

COMPOSE_ABS="$(resolve_existing_path "${COMPOSE_FILE}" "${ROOT_DIR}" || true)"
if [[ -z "${COMPOSE_ABS}" ]]; then
  echo "Error: compose file not found: ${COMPOSE_FILE}" >&2
  echo "Hint: use absolute path, or place docker-compose.yml in current directory." >&2
  exit 1
fi

if [[ "${SKIP_LOAD}" == "0" ]] && [[ -z "${TAR_PATH}" ]]; then
  echo "Error: --tar is required unless --skip-load is set." >&2
  usage
  exit 1
fi

if [[ "${SKIP_LOAD}" == "0" ]]; then
  TAR_ABS="$(resolve_existing_path "${TAR_PATH}" "" || true)"
fi
if [[ "${SKIP_LOAD}" == "0" ]] && [[ -z "${TAR_ABS:-}" ]]; then
  echo "Error: tar file not found: ${TAR_PATH}" >&2
  exit 1
fi

if [[ "${SKIP_LOAD}" == "0" ]]; then
  echo "==> Loading image from ${TAR_ABS}"
  if [[ "${TAR_ABS}" == *.tar.gz ]] || [[ "${TAR_ABS}" == *.tgz ]]; then
    gunzip -c "${TAR_ABS}" | docker load
  else
    docker load -i "${TAR_ABS}"
  fi
else
  echo "==> Skip image loading, using existing local image: ${IMAGE}"
fi

if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "Error: docker image not found locally: ${IMAGE}" >&2
  echo "Hint: run with --tar <path> first, or use the correct --image." >&2
  exit 1
fi

echo "==> Preparing model/output directories"
mkdir -p "${MODELS_DIR}/torch/hub/checkpoints" "${OUTPUT_DIR}"

if [[ -n "${MODEL_PATH}" ]]; then
  if [[ ! -f "${MODEL_PATH}" ]]; then
    echo "Error: model file not found: ${MODEL_PATH}" >&2
    exit 1
  fi
  cp "${MODEL_PATH}" "${MODELS_DIR}/torch/hub/checkpoints/big-lama.pt"
  echo "==> big-lama.pt copied"
fi

export IOPAINT_IMAGE="${IMAGE}"
export IOPAINT_CONTAINER_NAME="${CONTAINER_NAME}"
export IOPAINT_PORT="${PORT}"
export IOPAINT_MODELS_DIR="${MODELS_DIR}"
export IOPAINT_OUTPUT_DIR="${OUTPUT_DIR}"
export IOPAINT_MEM_LIMIT="${MEM_LIMIT}"
export IOPAINT_MEMSWAP_LIMIT="${MEMSWAP_LIMIT}"
export IOPAINT_CPUS="${CPUS}"
export IOPAINT_SHM_SIZE="${SHM_SIZE}"
export IOPAINT_PIDS_LIMIT="${PIDS_LIMIT}"

echo "==> Starting service with compose"
docker compose -f "${COMPOSE_ABS}" up -d --no-build --force-recreate
docker compose -f "${COMPOSE_ABS}" ps

echo "==> Service URL: http://<server-ip>:${PORT}"
echo "Done."
