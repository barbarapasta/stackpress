#!/usr/bin/env bash
set -euo pipefail

# Keep dependencies and database data away from the application workspaces.
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]]; then
  printf '%s\n' 'Run this proof with Node.js 22 on PATH.' >&2
  exit 1
fi
proof_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
proof_temp="$(mktemp -d /tmp/stackpress-oauth-store.XXXXXX)"
proof_pg="stackpress-oauth-pg-$$"
proof_mysql="stackpress-oauth-mysql-$$"

# Remove only resources created by this run, including anonymous DB volumes.
cleanup() {
  docker rm -fv "$proof_pg" "$proof_mysql" >/dev/null 2>&1 || true
  rm -rf "$proof_temp"
}
trap cleanup EXIT
cp "$proof_dir/dependencies.json" "$proof_temp/package.json"
cp "$proof_dir/dependencies.lock" "$proof_temp/yarn.lock"
yarn --cwd "$proof_temp" install --frozen-lockfile --non-interactive

docker run -d --rm --name "$proof_pg" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=oauth_proof \
  -p 127.0.0.1::5432 \
  postgres@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995 \
  >/dev/null
docker run -d --rm --name "$proof_mysql" \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=oauth_proof \
  -p 127.0.0.1::3306 \
  mysql@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d \
  >/dev/null

# Wait for the real servers to accept TCP connections inside their containers.
for proof_attempt in $(seq 1 60); do
  if docker exec "$proof_pg" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 \
    && docker exec "$proof_mysql" mysqladmin ping -h 127.0.0.1 --silent \
      >/dev/null 2>&1; then
    break
  fi
  if [[ "$proof_attempt" == 60 ]]; then
    printf '%s\n' 'Disposable databases did not become ready.' >&2
    exit 1
  fi
  sleep 1
done
export OAUTH_PROOF_DEPS="$proof_temp"
OAUTH_PROOF_PG_PORT="$(docker port "$proof_pg" 5432/tcp | cut -d: -f2)"
OAUTH_PROOF_MYSQL_PORT="$(docker port "$proof_mysql" 3306/tcp | cut -d: -f2)"
export OAUTH_PROOF_PG_PORT OAUTH_PROOF_MYSQL_PORT
node "$proof_dir/run.mjs"
