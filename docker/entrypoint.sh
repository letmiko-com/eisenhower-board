#!/bin/sh
set -e

# Fix ownership of the data directory (volume may be owned by root)
chown -R node:node "${DATA_DIR:-/app/data}"

# When a Litestream replica is configured, restore the database if the volume
# is empty (fresh volume or disaster recovery), then run the server under
# continuous replication. Litestream exits when the child process exits, so
# signals and restart policies behave as without it. See docs/backup.md.
if [ -n "${LITESTREAM_BUCKET:-}" ]; then
  DB_PATH="${DATA_DIR:-/app/data}/tasks.db"
  su-exec node litestream restore -if-db-not-exists -if-replica-exists -config /etc/litestream.yml "$DB_PATH"
  exec su-exec node litestream replicate -config /etc/litestream.yml -exec "$*"
fi

# Drop privileges and exec the main process as 'node'
exec su-exec node "$@"
