# Database backup and restore (Litestream)

The production SQLite database lives on a single Railway volume. [Litestream](https://litestream.io/) replicates it continuously to an S3-compatible bucket (Cloudflare R2), giving point-in-time recovery without touching the application code.

## How it works

- The Docker image ships the `litestream` binary and `/etc/litestream.yml` (source: `docker/litestream.yml`).
- The entrypoint activates replication **only when `LITESTREAM_BUCKET` is set**. Without it the container behaves exactly as before.
- On boot, `litestream restore -if-db-not-exists -if-replica-exists` rebuilds the database when the volume is empty: a fresh volume self-heals from the replica.
- The server then runs under `litestream replicate -exec`, which tails the WAL and uploads changes within seconds.
- Retention: 10 days of history, one snapshot per day (see `docker/litestream.yml`).

Requirement: SQLite must run in WAL mode (the default here). If the server ever logs the `SQLITE_IOERR_SHM` fallback to DELETE journal mode, replication will not work; fix the volume first.

## Environment variables (Railway service)

| Variable | Value |
|----------|-------|
| `LITESTREAM_BUCKET` | Bucket name, e.g. `focus-db-backup` |
| `LITESTREAM_ENDPOINT` | `https://<CF_ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `LITESTREAM_ACCESS_KEY_ID` | R2 API token key ID |
| `LITESTREAM_SECRET_ACCESS_KEY` | R2 API token secret |

The R2 API token should be scoped **Object Read & Write on this bucket only**.

## Verify replication is healthy

From a shell in the running container:

```sh
litestream snapshots -config /etc/litestream.yml "$DATA_DIR/tasks.db"
litestream wal -config /etc/litestream.yml "$DATA_DIR/tasks.db" | tail
```

Expect at least one snapshot and recent WAL segments. Also check the deploy logs for `litestream` lines at boot.

## Restore

### Scenario 1: volume lost or empty

Nothing to do. Attach a new volume and deploy: the entrypoint restores the latest replica state automatically before starting the server.

### Scenario 2: roll back to a point in time (bad migration, data mistake)

1. Scale the service down (stop writes).
2. From a shell with the same four `LITESTREAM_*` variables and the config:

   ```sh
   # List restorable snapshots and their timestamps
   litestream snapshots -config /etc/litestream.yml /app/data/tasks.db

   # Restore to a timestamp (UTC) into a fresh file
   litestream restore -config /etc/litestream.yml \
     -timestamp 2026-08-10T09:00:00Z \
     -o /app/data/tasks.restored.db /app/data/tasks.db
   ```

3. Swap the files (`mv tasks.restored.db tasks.db`, remove stale `tasks.db-wal` / `tasks.db-shm`), scale back up.

### Scenario 3: local inspection of a production backup

Run the same `litestream restore` on any machine with the four variables set and `-o ./tasks.local.db`, then open it with `sqlite3`. Treat the file as production data: it contains user emails and tasks; delete it after use.

## Test the restore path after setup

After the first deploy with replication enabled, prove the backup is usable:

1. Wait for one snapshot (`litestream snapshots` shows it).
2. Restore to a local file (scenario 3) and run `sqlite3 tasks.local.db 'SELECT COUNT(*) FROM tasks;'`.
3. Delete the local file.

A backup that has never been restored is a hypothesis, not a backup.
