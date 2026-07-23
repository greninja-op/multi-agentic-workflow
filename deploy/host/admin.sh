#!/bin/sh
# Run an administrative CFLS command inside the durable host container. This
# keeps the authorized host-admin identity on the server instead of copying its
# private key to an operator laptop.
set -eu

cd "$(dirname "$0")/../.."
exec docker compose \
  --env-file deploy/host/.env \
  -f deploy/host/docker-compose.yml \
  exec -T cfls-host node /app/apps/cli/dist/index.js "$@"
