#!/usr/bin/env bash
# Rebuild the bloated agent_messages / requests indexes, one at a time.
#
# Ops runbook, not a migration: self-hosted installs don't need it. Uses
# REINDEX INDEX CONCURRENTLY (SHARE UPDATE EXCLUSIVE), so inserts and updates
# keep flowing; only DDL and VACUUM on the same table wait. Peak extra disk is
# the size of the index being rebuilt.
#
# Not lock-free in practice for latency: each build reads the whole table, and
# on the 8 GB Railway prod instance that I/O alone pushed the proxy's request
# INSERT from ~1 ms to 150-400 ms, even with no parallel workers (2026-10-09).
# The guard below cancels the build when that happens.
#
# Usage:
#   DATABASE_URL=postgresql://...direct, not PgBouncer... scripts/db-reindex-bloated.sh [index ...]
#   PSQL="docker run --rm -i --network host postgres:17 psql" DATABASE_URL=... scripts/db-reindex-bloated.sh
#
# With no arguments it rebuilds the default list below, smallest first. It
# stops at the first failure after dropping the "<name>_ccnew" leftover, and
# refuses to start while a transaction older than MAX_XACT_AGE is open,
# because REINDEX CONCURRENTLY would wait for it.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to a direct (non-PgBouncer) connection}"
PSQL=${PSQL:-psql}
MAX_XACT_AGE=${MAX_XACT_AGE:-5 minutes}
MAINTENANCE_WORK_MEM=${MAINTENANCE_WORK_MEM:-256MB}
# Parallel build workers saturate disk I/O: on prod (2026-10-09) three workers
# pushed the proxy's awaited request INSERT from ~5 ms to 140-420 ms. Build
# with the leader only.
PARALLEL_WORKERS=${PARALLEL_WORKERS:-0}
# Latency guard: cancel the running build when the mean of the request INSERT
# (on the proxy path) over the last GUARD_INTERVAL seconds exceeds this.
MAX_INSERT_MS=${MAX_INSERT_MS:-40}
GUARD_INTERVAL=${GUARD_INTERVAL:-30}

DEFAULT_INDEXES=(
  IDX_requests_pending
  IDX_agent_messages_direct_usage
  IDX_agent_messages_recording
  IDX_agent_messages_unlinked_fallback
  IDX_requests_agent_usage_pending
  IDX_agent_messages_agent_usage_pending
  IDX_agent_messages_errors_timestamp
  IDX_agent_messages_error_origin
  PK_requests
  IDX_agent_messages_fallback_window
  PK_8c7cdeda30e81dba421925df4fe
  UQ_agent_messages_request_attempt_number
  IDX_requests_tenant_status_timestamp
  IDX_agent_messages_tenant_timestamp
  IDX_agent_messages_request_id
  IDX_agent_messages_tenant_provider
  IDX_b920481d4d296ccce0647d6a8a
  IDX_requests_tenant_timestamp
  IDX_requests_tenant_agent_timestamp
  IDX_agent_messages_provider_usage
)
if [ "$#" -gt 0 ]; then INDEXES=("$@"); else INDEXES=("${DEFAULT_INDEXES[@]}"); fi

q() { $PSQL "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c "$1"; }

# Prints "<calls> <total_ms>" for the proxy's request INSERTs.
insert_stats() {
  q "SELECT COALESCE(SUM(calls), 0) || ' ' || COALESCE(SUM(total_exec_time), 0)::bigint
     FROM pg_stat_statements WHERE query LIKE 'INSERT INTO \"requests\"%'"
}

# Runs in the background while an index builds; cancels the build when the
# insert mean over a window goes above MAX_INSERT_MS.
guard() {
  local idx=$1 prev cur
  prev=$(insert_stats)
  while sleep "$GUARD_INTERVAL"; do
    cur=$(insert_stats)
    read -r c0 t0 <<<"$prev"
    read -r c1 t1 <<<"$cur"
    if [ $((c1 - c0)) -ge 20 ] && [ $(((t1 - t0) / (c1 - c0))) -gt "$MAX_INSERT_MS" ]; then
      log "GUARD: request INSERT mean $(((t1 - t0) / (c1 - c0))) ms > $MAX_INSERT_MS ms; cancelling $idx"
      q "SELECT pg_cancel_backend(pid) FROM pg_stat_activity
         WHERE query LIKE 'REINDEX INDEX CONCURRENTLY%' AND pid <> pg_backend_pid()" >/dev/null
      return
    fi
    prev=$cur
  done
}
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

invalid=$(q "SELECT string_agg(indexrelid::regclass::text, ', ') FROM pg_index WHERE NOT indisvalid")
if [ -n "$invalid" ]; then
  log "ABORT: invalid indexes already present: $invalid"
  exit 1
fi

total_before=0
total_after=0
for idx in "${INDEXES[@]}"; do
  old=$(q "SELECT xact_start::text || ' ' || usename FROM pg_stat_activity
           WHERE xact_start < now() - interval '$MAX_XACT_AGE' AND pid <> pg_backend_pid()
           ORDER BY xact_start LIMIT 1")
  if [ -n "$old" ]; then
    log "ABORT before $idx: transaction open since $old (older than $MAX_XACT_AGE)"
    exit 1
  fi
  before=$(q "SELECT pg_relation_size('\"$idx\"'::regclass)")
  start=$(date +%s)
  log "REINDEX $idx ($((before / 1048576)) MB)"
  guard "$idx" &
  guard_pid=$!
  # Separate -c flags: a multi-statement -c string runs as one implicit
  # transaction, which REINDEX CONCURRENTLY refuses.
  if ! $PSQL "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
    -c "SET maintenance_work_mem = '$MAINTENANCE_WORK_MEM'" -c "SET statement_timeout = 0" \
    -c "SET max_parallel_maintenance_workers = $PARALLEL_WORKERS" \
    -c "REINDEX INDEX CONCURRENTLY \"$idx\""; then
    kill "$guard_pid" 2>/dev/null || true
    log "FAILED $idx; dropping leftover ${idx}_ccnew if any"
    q "DROP INDEX CONCURRENTLY IF EXISTS \"${idx}_ccnew\"" || true
    exit 1
  fi
  kill "$guard_pid" 2>/dev/null || true
  after=$(q "SELECT pg_relation_size('\"$idx\"'::regclass)")
  total_before=$((total_before + before))
  total_after=$((total_after + after))
  log "done  $idx: $((before / 1048576)) -> $((after / 1048576)) MB in $(($(date +%s) - start))s"
done

log "TOTAL: $((total_before / 1048576)) -> $((total_after / 1048576)) MB"
invalid=$(q "SELECT string_agg(indexrelid::regclass::text, ', ') FROM pg_index WHERE NOT indisvalid")
[ -z "$invalid" ] || { log "WARNING: invalid indexes remain: $invalid"; exit 1; }
