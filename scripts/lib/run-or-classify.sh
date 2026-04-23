#!/bin/bash
# Helper for scripts/post-merge.sh (Task #126).
#
# Runs a maintenance script and on non-zero exit classifies the
# failure as either:
#   - schemaError: stdout/stderr contains `column "..." does not exist`
#                  (the 2026-04-23 incident shape) → re-exit 2 so the
#                  whole post-merge run aborts and the deploy UI
#                  surfaces a hard failure.
#   - transientFailure: anything else (AI quota, ArchiDoc 5xx, network
#                       hiccup, ...) → fire-and-forget operator alert
#                       with a `[transient]` subject prefix and exit 0
#                       so a flaky external dependency doesn't block
#                       every merge.
#
# The plain `... || echo` pattern this replaces converted EVERY
# non-zero exit into a benign log line — including the schema errors
# we now want to fail loudly. Callers should source this file and
# invoke `run_or_classify <source-tag> <command...>`.

run_or_classify() {
  local source_tag="$1"
  shift

  local tmp_log
  tmp_log="$(mktemp -t "post-merge-${source_tag}.XXXXXX.log")"
  local exit_code=0

  # tee so the operator still sees the script's full output live in
  # the deploy log. We rely on PIPESTATUS[0] to recover the producer's
  # exit code (tee always returns 0 on a successful write). The
  # pipeline must NOT be wrapped in a subshell — that would collapse
  # the pipeline into a single exit status and PIPESTATUS would only
  # see the subshell's success.
  set +e
  "$@" 2>&1 | tee "$tmp_log"
  exit_code="${PIPESTATUS[0]}"
  set -e

  if [ "$exit_code" -eq 0 ]; then
    rm -f "$tmp_log"
    return 0
  fi

  # Look at the last 50 lines (per task plan) for a column-doesn't-
  # exist signal. Grep -E for the pattern; -q for boolean answer.
  if tail -n 50 "$tmp_log" | grep -Eq 'column "[^"]+" does not exist'; then
    local offending_col
    offending_col="$(tail -n 50 "$tmp_log" | grep -Eo 'column "[^"]+" does not exist' | head -n1)"
    echo "[post-merge] FATAL schemaError in ${source_tag}: ${offending_col}" 1>&2
    echo "[post-merge] aborting deploy with exit 2 — re-run the migration-replay gate and #123 boot assertion to root-cause" 1>&2
    rm -f "$tmp_log"
    exit 2
  fi

  # Transient failure: tag and report via the operator-alert channel
  # without aborting. Tail of the log goes into the alert body so the
  # on-call has something actionable without re-tailing the deploy.
  echo "[post-merge] ${source_tag} exited ${exit_code} — classified transient (no schema-error pattern). Continuing." 1>&2
  local alert_body
  alert_body="Maintenance script ${source_tag} exited ${exit_code} during post-merge.\n\nLast 50 log lines:\n$(tail -n 50 "$tmp_log")"
  # Best-effort dispatch; ignore failure (the alert helper itself logs).
  npx tsx scripts/post-merge-transient-alert.ts "${source_tag}" "${alert_body}" || true
  rm -f "$tmp_log"
  return 0
}
