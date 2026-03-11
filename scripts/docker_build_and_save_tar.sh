#!/usr/bin/env bash
set -euo pipefail

# Build a linux/amd64 image and export it as tar.gz for offline transfer.
#
# Example:
#   scripts/docker_build_and_save_tar.sh
#   scripts/docker_build_and_save_tar.sh \
#     --tag my-iopaint:cpu \
#     --dockerfile docker/CPUDockerfile \
#     --version 1.6.0 \
#     --output dist/docker/my-iopaint-cpu-linux-amd64.tar.gz

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM="linux/amd64"
TAG="iopaint:cpu"
DOCKERFILE="docker/CPUDockerfile"
VERSION="1.2.5"
OUTPUT="dist/docker/iopaint-cpu-linux-amd64.tar.gz"
INSTALL_PLUGINS="0"

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --platform <value>    Docker build platform (default: ${PLATFORM})
  --tag <value>         Docker image tag (default: ${TAG})
  --dockerfile <path>   Dockerfile path relative to repo root (default: ${DOCKERFILE})
  --version <value>     Build arg 'version' for Dockerfile (default: ${VERSION})
  --output <path>       Output tar.gz path relative to repo root (default: ${OUTPUT})
  --install-plugins <0|1>
                        Whether to install lama-cleaner plugin packages in image (default: ${INSTALL_PLUGINS})
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      PLATFORM="$2"
      shift 2
      ;;
    --tag)
      TAG="$2"
      shift 2
      ;;
    --dockerfile)
      DOCKERFILE="$2"
      shift 2
      ;;
    --version)
      VERSION="$2"
      shift 2
      ;;
    --output)
      OUTPUT="$2"
      shift 2
      ;;
    --install-plugins)
      INSTALL_PLUGINS="$2"
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

if ! docker buildx version >/dev/null 2>&1; then
  echo "Error: docker buildx is required." >&2
  exit 1
fi

DOCKERFILE_ABS="${ROOT_DIR}/${DOCKERFILE}"
if [[ ! -f "${DOCKERFILE_ABS}" ]]; then
  echo "Error: Dockerfile not found: ${DOCKERFILE_ABS}" >&2
  exit 1
fi

OUTPUT_ABS="${ROOT_DIR}/${OUTPUT}"
mkdir -p "$(dirname "${OUTPUT_ABS}")"

echo "==> Building image"
echo "    tag: ${TAG}"
echo "    platform: ${PLATFORM}"
echo "    dockerfile: ${DOCKERFILE}"
echo "    version: ${VERSION}"
echo "    install_plugins: ${INSTALL_PLUGINS}"

docker buildx build \
  --platform "${PLATFORM}" \
  --file "${DOCKERFILE_ABS}" \
  --build-arg "version=${VERSION}" \
  --build-arg "install_plugins=${INSTALL_PLUGINS}" \
  --tag "${TAG}" \
  --load \
  "${ROOT_DIR}"

echo "==> Exporting image to ${OUTPUT_ABS}"
docker save "${TAG}" | gzip > "${OUTPUT_ABS}"

echo "Done: ${OUTPUT_ABS}"
