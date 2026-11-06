#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
image_name=optivolt-highs-native-builder
container_id=
cleanup() {
  if [ -n "$container_id" ]; then
    docker rm "$container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

docker buildx build --platform linux/amd64 --load \
  -t "$image_name" -f "$repo_root/native/highs/Dockerfile" "$repo_root/native/highs"
container_id=$(docker create --platform linux/amd64 "$image_name")
mkdir -p "$repo_root/native/highs/bin"
docker cp "$container_id:/out/highs-native-bridge" "$repo_root/native/highs/bin/highs-native-bridge"
chmod 755 "$repo_root/native/highs/bin/highs-native-bridge"
docker run --rm --platform linux/amd64 --entrypoint /out/highs-native-bridge "$image_name" --version
