# Titanor Time — Database Infrastructure (PostgreSQL 16)

```text
Status: prepared, NOT started
Scope: isolated PostgreSQL 16 for Titanor Time only
Compose project: titanor-time (compose.titanor-time.yaml)
```

This document describes the isolated PostgreSQL 16 configuration for Titanor Time
(`compose.titanor-time.yaml`) and how to operate it once the owner decides to actually start it. As of
this writing the service has **not** been started, no volume or network has been created, and the
existing initial migration has **not** been applied to it. See `IMPLEMENTATION_STATUS.md` for the
proven implementation state.

## 1. Isolation summary

- Separate Compose project (`name: titanor-time`) — distinct from `titanorgroup` (public site,
  `compose.yaml`) and from CollabStudio (its own, unrelated Compose project).
- Separate network (`titanor-time_internal`, `internal: true` — no outbound routing, container-to-
  container only).
- Separate named volume (`titanor-time_db_data`).
- Separate image pull (`postgres:16`, official image) — not the CollabStudio Postgres container.
- No published port — the database is reachable only from other containers attached to the
  `titanor-time_internal` network, under the internal DNS name `db`.
- Secrets (`POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`) come only from a local, gitignored
  `.env.titanor-time` file — never from compose.yaml, never committed.

## 2. Create the local, non-public env file

```bash
cp .env.titanor-time.example .env.titanor-time
```

Edit `.env.titanor-time` and set real values for `POSTGRES_DB`, `POSTGRES_USER`,
`POSTGRES_PASSWORD` (a long random password — e.g. `openssl rand -hex 32`). This file is already
covered by the `.env.*` rule in `.gitignore` (with an explicit exception only for the two `.example`
files) — verify with `git check-ignore -v .env.titanor-time` before ever running `git add`.

Never put real values in `.env.titanor-time.example`.

## 3. Start only the Titanor Time database

The public site (`compose.yaml`) and CollabStudio are unaffected — this is a separate Compose project
and a separate command:

```bash
docker compose -f compose.titanor-time.yaml up -d db
```

This creates exactly one container, one network, one volume, all scoped to project `titanor-time`.

## 4. Check health

```bash
docker compose -f compose.titanor-time.yaml ps
docker inspect --format '{{.State.Health.Status}}' titanor-time-db-1
```

Or directly:

```bash
docker compose -f compose.titanor-time.yaml exec db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

## 5. Apply the existing migration

There is exactly one migration:
`prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql`. Do not create a second
one; do not use `prisma migrate dev`.

The database has no published port, so `prisma migrate deploy` must run from a container attached to
the same internal network — either the future Titanor Time app service (once it exists, simply
`docker compose -f compose.titanor-time.yaml exec app npx prisma migrate deploy`), or, until that
service exists, a throwaway container attached to the same network:

```bash
docker run --rm \
  --network titanor-time_internal \
  -v "$(pwd)":/app -w /app \
  -e DATABASE_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/$POSTGRES_DB?schema=public" \
  node:20 \
  sh -c "npm ci && npx prisma migrate deploy --schema prisma/schema.prisma"
```

`db` above is the internal Compose DNS name (service key), resolvable only on the
`titanor-time_internal` network — not a public host. Never construct this `DATABASE_URL` outside a
container on that network, and never commit it.

## 6. Backup

```bash
mkdir -p backups
docker compose -f compose.titanor-time.yaml exec -T db \
  pg_dump -U "$POSTGRES_USER" -F c -d "$POSTGRES_DB" \
  > "backups/titanor-time-$(date +%Y%m%d-%H%M%S).dump"
```

`-F c` (custom format) is required by `pg_restore` in step 7. Keep backups outside the git repository
(the `backups/` directory should not be committed — add a project-specific ignore rule separately if
this path is adopted).

## 7. Verify restore into a separate test database

Never restore on top of the real `db` service to "test" a backup. Verify against a disposable,
throwaway PostgreSQL 16 container first — the same pattern used for the runtime migration
verification: `--rm`, tmpfs data, random credentials, `127.0.0.1`-only dynamic port, removed
immediately after.

```bash
docker run --detach --rm \
  --name titanor-time-restore-check \
  --restart=no \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=512m \
  -e POSTGRES_USER=restorecheck \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" \
  -e POSTGRES_DB=restorecheck \
  -p 127.0.0.1::5432 \
  postgres:16

# wait for pg_isready, then:
docker exec -i titanor-time-restore-check \
  pg_restore -U restorecheck -d restorecheck --clean --if-exists < backups/<file>.dump

# inspect row counts / schema as needed, then:
docker rm -f titanor-time-restore-check
```

Only after a successful restore-check against a throwaway database should a backup be trusted for a
real recovery.

## 8. Stop the service without deleting data

```bash
docker compose -f compose.titanor-time.yaml stop db
```

This stops the container; the `titanor-time_db_data` volume and `titanor-time_internal` network are
untouched. To also remove the (stopped) container and network while **keeping the volume**:

```bash
docker compose -f compose.titanor-time.yaml down
```

**Never** run `docker compose -f compose.titanor-time.yaml down -v` or `docker volume rm
titanor-time_db_data` unless the owner has explicitly approved permanent data deletion — `-v` destroys
the named volume.

## 9. Rollback a deployment without losing data

Prisma migrations in this project are forward-only (no generated "down" SQL). "Rollback" here means
restoring service state without destroying the persistent volume:

1. Take a fresh backup first (step 6), even if things look broken.
2. `docker compose -f compose.titanor-time.yaml down` (no `-v`) to stop and remove the container/
   network — the volume survives.
3. `docker compose -f compose.titanor-time.yaml up -d db` to recreate the container attached to the
   same existing volume — data from before the incident is intact, since the volume was never removed.
4. Only if the volume's data itself is confirmed corrupted (not just the container), restore from the
   most recent verified backup (steps 6-7) into a **new** volume, verify, then switch over — never
   overwrite the only copy of the volume in place without a verified backup first.

## 10. Explicitly out of scope here

- Starting the service (`docker compose -f compose.titanor-time.yaml up`) — not run in this task.
- Applying the migration — not run in this task.
- The future Titanor Time application service (Next.js scaffold) — separate task.
- Seed data, first `SUPER_ADMIN`, auth, API, UI — see `IMPLEMENTATION_STATUS.md` §9 ("Не начато").
- Any change to `compose.yaml` (public site), CollabStudio, Caddy, DNS, or Zoho.
