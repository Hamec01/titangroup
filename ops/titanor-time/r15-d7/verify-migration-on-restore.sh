#!/usr/bin/env bash
# R15-D7 Deploy D2 — disposable verification of Migration 2 on a RESTORED production backup.
#   PHASE 1  restore #1: `migrate deploy` WITHOUT the manual fix  -> must FAIL
#            (ex_site_assignment_one_primary_per_period can't validate while Nazar #1002 and
#             Mykhailo #1004 each still have TWO primary assignments whose date ranges OVERLAP)
#   PHASE 2  restore #2: apply fix-double-primary.sql, then `migrate deploy` x2 -> must SUCCEED,
#            2nd run a no-op; inspect the resulting constraint + real-data state
# Nothing touches production.  (The broader two-phase D1/D2 web-rollout proof is verify-rollout-on-restore.sh.)
set -uo pipefail

BACKUP="${1:?usage: $0 <backup-dir>}"
IMAGE="${IMAGE:-titanor-time-app:d7d3-5690632}"
FIXSQL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fix-double-primary.sql"
CONSTRAINT="ex_site_assignment_one_primary_per_period"
SUF="d7dv-$$"
NET="tt-${SUF}-net"
WORK="$(mktemp -d /tmp/${SUF}.XXXXXX)"
cp -a "$BACKUP"/. "$WORK"/

cleanup() {
  docker ps -aq --filter "name=tt-${SUF}" | xargs -r docker rm -f >/dev/null 2>&1
  docker volume ls -q | grep "tt-${SUF}" | xargs -r docker volume rm >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT
docker network create "$NET" >/dev/null

# overlapping-primary-pair count: two NON-removed primary rows of the same employee whose
# [validFrom, validTo+1) day-ranges intersect. This is exactly the Migration-2 EXCLUDE predicate.
OVERLAP_SQL="SELECT count(*) FROM \"SiteAssignment\" a JOIN \"SiteAssignment\" b
  ON b.\"employeeId\"=a.\"employeeId\" AND b.id<>a.id
 AND b.\"isPrimary\" AND b.\"clockInDisabledAt\" IS NULL
 AND daterange(b.\"validFrom\", COALESCE(b.\"validTo\"+1,'infinity'::date),'[)')
  && daterange(a.\"validFrom\", COALESCE(a.\"validTo\"+1,'infinity'::date),'[)')
 WHERE a.\"isPrimary\" AND a.\"clockInDisabledAt\" IS NULL"

restore() {  # $1 = suffix
  local dbc="tt-${SUF}-$1-db" vol="tt-${SUF}-$1-vol" pw
  pw="$(head -c15 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
  docker run -d --name "$dbc" --network "$NET" -e POSTGRES_DB=titanor_time -e POSTGRES_USER=d7d -e POSTGRES_PASSWORD="$pw" -v "$vol:/var/lib/postgresql/data" postgres:16 >/dev/null
  for _ in $(seq 1 60); do docker exec "$dbc" pg_isready -U d7d -d titanor_time -q 2>/dev/null && break; sleep 1; done
  docker run --rm --network "$NET" -v "$WORK:/b:ro" -e PGPASSWORD="$pw" postgres:16 \
    pg_restore --no-owner --no-acl --exit-on-error -h "$dbc" -U d7d -d titanor_time /b/db.dump >/dev/null 2>&1 \
    || { echo "restore failed"; exit 1; }
  echo "postgresql://d7d:${pw}@${dbc}:5432/titanor_time"
}
mdeploy() { docker run --rm --network "$NET" -e DATABASE_URL="$1" -w /app --entrypoint node "$IMAGE" .prisma-tools/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma 2>&1; }

echo "================================================================"
echo "PHASE 1 — migrate deploy WITHOUT the fix (expect FAILURE)"
echo "================================================================"
URL1="$(restore a)"
Q1() { docker exec "tt-${SUF}-a-db" psql -U d7d -d titanor_time -tAc "$1"; }
echo "pre: migrations=$(Q1 "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")  overlapping-primary pairs=$(Q1 "$OVERLAP_SQL")  (expect >0 — the two double-primary workers)"
Q1 "SELECT e.\"employeeNumber\"||'  '||sa.id||'  ['||sa.\"validFrom\"||' .. '||COALESCE(sa.\"validTo\"::text,'open')||']  primary='||sa.\"isPrimary\"
    FROM \"SiteAssignment\" sa JOIN \"Employee\" e ON e.id=sa.\"employeeId\"
    WHERE sa.\"employeeId\" IN (SELECT \"employeeId\" FROM \"SiteAssignment\" WHERE \"isPrimary\" AND \"clockInDisabledAt\" IS NULL GROUP BY \"employeeId\" HAVING count(*)>1)
    ORDER BY e.\"employeeNumber\", sa.\"isPrimary\" DESC" | sed 's/^/   /'
OUT1="$(mdeploy "$URL1")"; RC1=$?
echo "$OUT1" | sed 's/^/   /'
echo "-> exit $RC1 (expect non-zero)"
echo "-> _prisma_migrations state for the new migration:"
Q1 "SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolledback FROM _prisma_migrations WHERE migration_name='20260902180000_add_primary_period_exclusion'" | sed 's/^/   /'
echo "-> constraint exists? $(Q1 "SELECT count(*) FROM pg_constraint WHERE conname='${CONSTRAINT}'")  (expect 0)"

echo
echo "================================================================"
echo "PHASE 2 — fix-double-primary.sql, then migrate deploy x2"
echo "================================================================"
URL2="$(restore b)"
Q2() { docker exec "tt-${SUF}-b-db" psql -U d7d -d titanor_time -tAc "$1"; }
DBC2="tt-${SUF}-b-db"
PW2="$(echo "$URL2" | sed -E 's#.*d7d:([^@]+)@.*#\1#')"

echo "-- state BEFORE fix --"
echo "   overlapping-primary pairs: $(Q2 "$OVERLAP_SQL")"

echo "-- FIX rejects a missing actor (no default) --"
docker cp "$FIXSQL" "$DBC2:/tmp/fix.sql" >/dev/null
docker exec -e PGPASSWORD="$PW2" "$DBC2" psql -U d7d -d titanor_time -v ON_ERROR_STOP=1 -f /tmp/fix.sql >/tmp/na.out 2>&1; RC_NA=$?
grep -E "invalid input syntax for type uuid" /tmp/na.out | head -1 | sed 's/^/   (no actor) /'
echo "   -> exit $RC_NA (expect non-zero — no default actor)"
echo "-- FIX rejects a non-SUPER_ADMIN actor --"
BADACTOR=$(Q2 "SELECT u.id FROM \"User\" u JOIN \"UserRole\" ur ON ur.\"userId\"=u.id JOIN \"Role\" r ON r.id=ur.\"roleId\" WHERE r.name='ADMIN' AND u.status='ACTIVE' AND ur.\"validTo\" IS NULL LIMIT 1")
docker exec -e PGPASSWORD="$PW2" "$DBC2" psql -U d7d -d titanor_time -v ON_ERROR_STOP=1 -v actor="$BADACTOR" -f /tmp/fix.sql 2>&1 | grep -E "not an ACTIVE SUPER_ADMIN" | head -1 | sed 's/^/   (ADMIN actor) /'
echo "   -> ADMIN actor rejected (expect a 'not an ACTIVE SUPER_ADMIN' line above)"

echo "-- apply fix-double-primary.sql with a real ACTIVE SUPER_ADMIN actor --"
ACTOR=$(Q2 "SELECT u.id FROM \"User\" u JOIN \"UserRole\" ur ON ur.\"userId\"=u.id JOIN \"Role\" r ON r.id=ur.\"roleId\" WHERE r.name='SUPER_ADMIN' AND u.status='ACTIVE' AND ur.\"validTo\" IS NULL LIMIT 1")
echo "   actor = $ACTOR"
docker exec -e PGPASSWORD="$PW2" "$DBC2" psql -U d7d -d titanor_time -v ON_ERROR_STOP=1 -v actor="$ACTOR" -f /tmp/fix.sql 2>&1 | sed 's/^/   /'
echo "-> fix exit $?"

echo "-- state AFTER fix --"
Q2 "SELECT e.\"employeeNumber\"||'  '||sa.id||'  isPrimary='||sa.\"isPrimary\"||'  v='||sa.version
    FROM \"SiteAssignment\" sa JOIN \"Employee\" e ON e.id=sa.\"employeeId\"
    WHERE sa.id IN ('c6825d98-f7e2-47ae-bdd3-c721bf3ce242','3d95975f-b4c4-491a-8e10-38f3e88edcd8','bc174aef-2766-4877-ac43-415ef12433d5','cbf688b7-fe67-46b2-aad3-967c37103c07')
    ORDER BY e.\"employeeNumber\", sa.\"isPrimary\" DESC" | sed 's/^/   /'
echo "   AssignmentTransition rows: $(Q2 "SELECT count(*) FROM \"AssignmentTransition\"")  (expect 2)"
echo "   AuditEvent ASSIGNMENT_PROMOTED rows: $(Q2 "SELECT count(*) FROM \"AuditEvent\" WHERE \"eventType\"='ASSIGNMENT_PROMOTED'")  (expect 2)"
echo "   overlapping-primary pairs: $(Q2 "$OVERLAP_SQL")  (expect 0)"
echo "   hours still bound to cbf688b7: WorkSegment=$(Q2 "SELECT count(*) FROM \"WorkSegment\" WHERE \"sourceAssignmentId\"='cbf688b7-fe67-46b2-aad3-967c37103c07'")  ClockShift=$(Q2 "SELECT count(*) FROM \"ClockShift\" WHERE \"sourceAssignmentId\"='cbf688b7-fe67-46b2-aad3-967c37103c07'")  (expect 10 / 5 — unchanged)"
echo "   3d95975f validTo / endedReason unchanged: $(Q2 "SELECT \"validTo\"||' / '||COALESCE(\"endedReason\",'(null)') FROM \"SiteAssignment\" WHERE id='3d95975f-b4c4-491a-8e10-38f3e88edcd8'")"

echo "-- migrate deploy (pass 1) --"
mdeploy "$URL2" | sed 's/^/   /'
echo "-- migrate deploy (pass 2 — expect no-op) --"
P2OUT="$(mdeploy "$URL2")"; echo "$P2OUT" | sed 's/^/   /'
echo
echo "-- RESULT --"
echo "   migrations: $(Q2 "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")  bad=$(Q2 "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")"
echo "   pass 2 no-op: $(echo "$P2OUT" | grep -c 'No pending migrations')"
echo "   ${CONSTRAINT} exists: $(Q2 "SELECT count(*) FROM pg_constraint WHERE conname='${CONSTRAINT}'")  (expect 1)"
echo "   constraint definition: $(Q2 "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='${CONSTRAINT}'")"
echo "   newest migration: $(Q2 "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC NULLS LAST LIMIT 1")"
echo "   final overlapping-primary pairs (must be 0): $(Q2 "$OVERLAP_SQL")"
echo
echo "   (a disjoint current+future primary pair being ACCEPTED by this constraint — and an"
echo "    overlapping pair being rejected with 23P01 — is proven through the real API in the"
echo "    browser lane: _test-t9-assignment-lifecycle.ts P1/P3.)"
echo
echo "== DONE =="
