#!/usr/bin/env bash
# R15-D7 Deploy D — two-phase rollout verification on a RESTORED production copy.
# Nothing touches production.
#
#   A. baseline: d7a (current prod image) on the restored schema-99 DB -> serves OK
#   B. D1 swap:  d7d1 (fixed lifecycle code, inventory 99, NO Migration 2) on the same DB
#      - /api/ready = current 99/99
#      - D1 operations: create 2nd primary (demotes, disjoint-vs-overlap), promote, PATCH primary,
#        change now / change future (disjoint primary periods both kept)
#      - ROLLBACK D1 -> d7a on schema 99: still OK (constraint not installed)
#   C. D2: fix-double-primary.sql -> `migrate deploy` (Migration 2) while D1 keeps serving
#      - D1 now /api/ready = ahead (ok:true); D1 operations still OK WITH the constraint (no 23P01 leak)
#   D. PROOF the old path is unsafe post-constraint: boot d7a against the schema-100 DB and make it
#      create a 2nd OVERLAPPING primary -> d7a does NOT demote -> 23P01 -> HTTP 500
#   E. final swap: d7d3 (inventory 100) -> /api/ready = current 100/100
set -uo pipefail

BACKUP="${1:?usage: $0 <backup-dir>}"
D7A="${D7A:-titanor-time-app:d7a-37dddb1}"
D7D1="${D7D1:-titanor-time-app:d7d1-b9cb5e7}"
D7D3="${D7D3:-titanor-time-app:d7d3-5690632}"
FIXSQL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fix-double-primary.sql"
PROD_ENV="/home/deploy/app-data/titanor-time-prod/app.env"
CONSTRAINT="ex_site_assignment_one_primary_per_period"
SUF="d7ro-$$"; NET="tt-${SUF}-net"; DBC="tt-${SUF}-db"; VOL="tt-${SUF}-vol"
DB=titanor_time; ROLE=d7ro; PW="$(head -c15 /dev/urandom|base64|tr -dc A-Za-z0-9)"
DBPORT=55495; APPPORT=3196
WORK="$(mktemp -d /tmp/${SUF}.XXXXXX)"; cp -a "$BACKUP"/. "$WORK"/
RESTORED_URL="postgresql://${ROLE}:${PW}@${DBC}:5432/${DB}"

cleanup(){ docker ps -aq --filter "name=tt-${SUF}" | xargs -r docker rm -f >/dev/null 2>&1; docker volume ls -q|grep "tt-${SUF}"|xargs -r docker volume rm >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
q(){ docker exec "$DBC" psql -U "$ROLE" -d "$DB" -tAc "$1"; }
ready(){ curl -s --max-time 4 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APPPORT}/api/ready"; }
readybody(){ curl -s --max-time 4 "http://127.0.0.1:${APPPORT}/api/ready"; }

# overlapping-primary-pair count across the WHOLE db — the Migration-2 EXCLUDE predicate.
OVERLAP_SQL="SELECT count(*) FROM \"SiteAssignment\" a JOIN \"SiteAssignment\" b
  ON b.\"employeeId\"=a.\"employeeId\" AND b.id<>a.id
 AND b.\"isPrimary\" AND b.\"clockInDisabledAt\" IS NULL
 AND daterange(b.\"validFrom\", COALESCE(b.\"validTo\"+1,'infinity'::date),'[)')
  && daterange(a.\"validFrom\", COALESCE(a.\"validTo\"+1,'infinity'::date),'[)')
 WHERE a.\"isPrimary\" AND a.\"clockInDisabledAt\" IS NULL"

bootapp(){ # $1 image
  docker rm -f "tt-${SUF}-app" >/dev/null 2>&1
  docker run -d --name "tt-${SUF}-app" --network "$NET" -p 127.0.0.1:${APPPORT}:3000 \
    --env-file "$PROD_ENV" -e DATABASE_URL="$RESTORED_URL" -e NODE_ENV=production -e PORT=3000 -e HOSTNAME=0.0.0.0 -e NEXT_TELEMETRY_DISABLED=1 \
    "$1" >/dev/null
  for _ in $(seq 1 45); do c=$(ready); [ "$c" = 200 ] && return 0; sleep 2; done; return 1
}
mint_session(){
  local aid tok th
  aid=$(q "SELECT u.id FROM \"User\" u JOIN \"UserRole\" ur ON ur.\"userId\"=u.id JOIN \"Role\" r ON r.id=ur.\"roleId\" WHERE u.status='ACTIVE' AND ur.\"validTo\" IS NULL AND r.name IN ('SUPER_ADMIN','ADMIN') ORDER BY r.name LIMIT 1")
  tok=$(head -c32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')
  th=$(printf '%s' "$tok" | sha256sum | awk '{print $1}')
  q "INSERT INTO \"UserSession\" (\"userId\",\"tokenHash\",\"authLevel\",\"expiresAt\") VALUES ('$aid','$th','PASSWORD', now() + interval '1 day')" >/dev/null
  echo "tt_session=$tok"
}
uuid(){ cat /proc/sys/kernel/random/uuid; }
mkprimary(){ # $1 cookie -> "worker site1 site2 a1(primary on site1, open-ended)"
  local C="$1" run=$RANDOM$$ w s1 s2 a1
  w=$(curl -s --max-time 10 -H "Content-Type: application/json" -H "X-Requested-With: titanor-time" -H "Idempotency-Key: $(uuid)" -H "Cookie: $C" -d "{\"firstName\":\"RO\",\"lastName\":\"W$run\"}" "http://127.0.0.1:${APPPORT}/api/admin/workers" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  s1=$(curl -s --max-time 10 -H "Content-Type: application/json" -H "X-Requested-With: titanor-time" -H "Idempotency-Key: $(uuid)" -H "Cookie: $C" -d "{\"name\":\"RO S1 $run\"}" "http://127.0.0.1:${APPPORT}/api/admin/sites" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  s2=$(curl -s --max-time 10 -H "Content-Type: application/json" -H "X-Requested-With: titanor-time" -H "Idempotency-Key: $(uuid)" -H "Cookie: $C" -d "{\"name\":\"RO S2 $run\"}" "http://127.0.0.1:${APPPORT}/api/admin/sites" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  a1=$(curl -s --max-time 10 -H "Content-Type: application/json" -H "X-Requested-With: titanor-time" -H "Idempotency-Key: $(uuid)" -H "Cookie: $C" -d "{\"employeeId\":\"$w\",\"siteId\":\"$s1\",\"validFrom\":\"2020-01-01\",\"isPrimary\":true}" "http://127.0.0.1:${APPPORT}/api/admin/assignments" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "$w $s1 $s2 $a1"
}
POST(){ curl -s --max-time 12 -o /dev/null -w '%{http_code}' -H "Content-Type: application/json" -H "X-Requested-With: titanor-time" -H "Idempotency-Key: $(uuid)" -H "Cookie: $1" -d "$3" "http://127.0.0.1:${APPPORT}$2"; }
PATCH(){ curl -s --max-time 12 -o /dev/null -w '%{http_code}' -X PATCH -H "Content-Type: application/json" -H "X-Requested-With: titanor-time" -H "Cookie: $1" -d "$3" "http://127.0.0.1:${APPPORT}$2"; }
POSTC(){ curl -s --max-time 12 -H "Content-Type: application/json" -H "X-Requested-With: titanor-time" -H "Idempotency-Key: $(uuid)" -H "Cookie: $1" -d "$3" "http://127.0.0.1:${APPPORT}$2"; }

echo "== D7D two-phase rollout verification =="
docker network create "$NET" >/dev/null
docker run -d --name "$DBC" --network "$NET" -p 127.0.0.1:${DBPORT}:5432 -e POSTGRES_DB="$DB" -e POSTGRES_USER="$ROLE" -e POSTGRES_PASSWORD="$PW" -v "$VOL:/var/lib/postgresql/data" postgres:16 >/dev/null
for _ in $(seq 1 60); do docker exec "$DBC" pg_isready -U "$ROLE" -d "$DB" -q 2>/dev/null && break; sleep 1; done
docker run --rm --network "$NET" -v "$WORK:/b:ro" -e PGPASSWORD="$PW" postgres:16 pg_restore --no-owner --no-acl --exit-on-error -h "$DBC" -U "$ROLE" -d "$DB" /b/db.dump >/dev/null 2>&1 || { echo restore-failed; exit 1; }
echo "restored: $(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL") migrations ; overlapping-primary pairs = $(q "$OVERLAP_SQL")"

echo
echo "-- A. baseline: d7a on schema 99 --"
bootapp "$D7A" && echo "   d7a /api/ready = $(ready)  $(readybody)" || echo "   d7a FAILED to become ready"

echo
echo "-- B. D1 swap: d7d1 on the same schema-99 DB --"
bootapp "$D7D1" && echo "   d7d1 /api/ready = $(ready)  $(readybody)  (expect current 99/99)" || echo "   d7d1 FAILED"
C=$(mint_session)
# (1) create / demote / promote / PATCH on one worker
read -r W S1 S2 A1 <<< "$(mkprimary "$C")"
echo "   fresh worker $W  a1(primary on S1, open-ended)=$A1"
A2=$(POSTC "$C" "/api/admin/assignments" "{\"employeeId\":\"$W\",\"siteId\":\"$S2\",\"validFrom\":\"2020-01-01\",\"isPrimary\":true}" | grep -o '"id":"[^"]*"'|head -1|cut -d'"' -f4)
echo "   create 2nd OVERLAPPING primary on S2 -> a2=$A2 ; live primaries now = $(q "SELECT count(*) FROM \"SiteAssignment\" WHERE \"employeeId\"='$W' AND \"isPrimary\" AND \"clockInDisabledAt\" IS NULL")  (expect 1 — a1 auto-demoted)"
A1V=$(q "SELECT version FROM \"SiteAssignment\" WHERE id='$A1'")
echo "   PATCH a1 isPrimary:true (v=$A1V) -> $(PATCH "$C" "/api/admin/assignments/$A1" "{\"version\":$A1V,\"isPrimary\":true}")  (expect 200) ; live primaries = $(q "SELECT count(*) FROM \"SiteAssignment\" WHERE \"employeeId\"='$W' AND \"isPrimary\" AND \"clockInDisabledAt\" IS NULL")"
echo "   promote a2 -> $(POST "$C" "/api/admin/assignments/$A2/promote" "")  (expect 200)"
# immediate /change onto a FRESH site (S1/S2 are still occupied by a1/a2)
S3=$(POSTC "$C" "/api/admin/sites" "{\"name\":\"RO S3 $RANDOM$$\"}" | grep -o '"id":"[^"]*"'|head -1|cut -d'"' -f4)
CHG=$(POSTC "$C" "/api/admin/assignments/$A2/change" "{\"effectiveFrom\":\"$(TZ=Europe/Helsinki date +%F)\",\"siteId\":\"$S3\",\"isPrimary\":true,\"reason\":\"rollout now\"}")
echo "   immediate /change a2 -> S3 (fresh): $(echo "$CHG" | head -c 240)"
# (2) FUTURE transfer on a SEPARATE worker: current + scheduled primary must BOTH stay primary
read -r WF SF1 SF2 AF1 <<< "$(mkprimary "$C")"
echo "   [future] fresh worker $WF  af1(primary on SF1)=$AF1"
echo "   /change af1 -> SF2 FUTURE (+7d), primary -> $(POST "$C" "/api/admin/assignments/$AF1/change" "{\"effectiveFrom\":\"$(TZ=Europe/Helsinki date -d '+7 days' +%F)\",\"siteId\":\"$SF2\",\"isPrimary\":true,\"reason\":\"future transfer\"}")  (expect 200)"
echo "   live primaries for $WF = $(q "SELECT count(*) FROM \"SiteAssignment\" WHERE \"employeeId\"='$WF' AND \"isPrimary\" AND \"clockInDisabledAt\" IS NULL")  (expect 2 — current [.. +6d] + scheduled [+7d ..], disjoint)"
echo "   whole-DB overlapping-primary pairs: $(q "$OVERLAP_SQL")  (expect 4 — pre-existing Nazar+Mykhailo; D1 does NOT touch them, that is D2's fix-double-primary.sql. D1 only guarantees new/edited workers stay ≤1)"

echo
echo "-- B-rollback: d7d1 -> d7a on schema 99 (constraint NOT installed) --"
bootapp "$D7A" && echo "   d7a /api/ready = $(ready)  $(readybody)  (rollback D1->A is safe here)" || echo "   d7a FAILED"

echo
echo "-- C. D2: fix-double-primary.sql + migrate deploy (Migration 2) --"
bootapp "$D7D1" >/dev/null && echo "   d7d1 serving again"
ACTOR=$(q "SELECT u.id FROM \"User\" u JOIN \"UserRole\" ur ON ur.\"userId\"=u.id JOIN \"Role\" r ON r.id=ur.\"roleId\" WHERE r.name='SUPER_ADMIN' AND u.status='ACTIVE' AND ur.\"validTo\" IS NULL LIMIT 1")
docker cp "$FIXSQL" "$DBC:/tmp/fix.sql" >/dev/null
docker exec -e PGPASSWORD="$PW" "$DBC" psql -U "$ROLE" -d "$DB" -v ON_ERROR_STOP=1 -v actor="$ACTOR" -f /tmp/fix.sql 2>&1 | grep -E "COMMIT|ERROR" | head -1 | sed 's/^/   fix: /'
docker run --rm --network "$NET" -e DATABASE_URL="$RESTORED_URL" -w /app --entrypoint node "$D7D3" .prisma-tools/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma 2>&1 | grep -E "applied|No pending|Error" | sed 's/^/   migrate: /'
echo "   ${CONSTRAINT} installed: $(q "SELECT count(*) FROM pg_constraint WHERE conname='${CONSTRAINT}'")   migrations: $(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL") bad=$(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")"
echo "   d7d1 (still running) /api/ready = $(ready)  $(readybody)   (expect 200, schema ahead)"
# D1 operations WITH the constraint now
C=$(mint_session)
read -r W S1 S2 A1 <<< "$(mkprimary "$C")"
A2=$(POSTC "$C" "/api/admin/assignments" "{\"employeeId\":\"$W\",\"siteId\":\"$S2\",\"validFrom\":\"2020-01-01\",\"isPrimary\":true}" | grep -o '"id":"[^"]*"'|head -1|cut -d'"' -f4)
A1V=$(q "SELECT version FROM \"SiteAssignment\" WHERE id='$A1'")
echo "   [d7d1 + constraint] create 2nd primary=$([ -n "$A2" ] && echo 201 || echo FAIL) ; PATCH a1 isPrimary:true -> $(PATCH "$C" "/api/admin/assignments/$A1" "{\"version\":$A1V,\"isPrimary\":true}")  (expect 200, NO 500) ; promote a2 -> $(POST "$C" "/api/admin/assignments/$A2/promote" "")  (expect 200)"
echo "   overlapping-primary pairs: $(q "$OVERLAP_SQL")  (expect 0)"

echo
echo "-- D. PROOF: d7a (OLD code) against schema 100 -> unsafe --"
bootapp "$D7A" && echo "   d7a /api/ready = $(ready)  $(readybody)  (schema ahead — STARTS, but...)" || echo "   d7a FAILED"
C=$(mint_session)
read -r W S1 S2 A1 <<< "$(mkprimary "$C")"
A2CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Content-Type: application/json" -H "X-Requested-With: titanor-time" -H "Idempotency-Key: $(uuid)" -H "Cookie: $C" -d "{\"employeeId\":\"$W\",\"siteId\":\"$S2\",\"validFrom\":\"2020-01-01\",\"isPrimary\":true}" "http://127.0.0.1:${APPPORT}/api/admin/assignments")
echo "   [d7a] create a 2nd OVERLAPPING primary via POST /api/admin/assignments -> HTTP $A2CODE  (d7a does NOT demote -> 23P01 -> 500 expected)"
echo "   d7a recent log (constraint error lines):"; docker logs "tt-${SUF}-app" 2>&1 | grep -iE "error|23P01|exclu|Invalid" | tail -4 | sed 's/^/     /'

echo
echo "-- E. final swap: d7d3 (inventory 100) --"
bootapp "$D7D3" && echo "   d7d3 /api/ready = $(ready)  $(readybody)  (expect current 100/100)" || echo "   d7d3 FAILED"

echo
echo "== DONE =="
