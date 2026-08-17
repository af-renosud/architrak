#!/usr/bin/env bash
# check-bare-currency.sh — guard against unlabelled euro figures.
#
# Flags any file under client/src that contains a bare `formatCurrency(`
# call and is NOT in the allowlist below.
#
# The allowlist captures the ~19 files that existed before the <Amount>
# component was introduced (Task #577).  New code must use <Amount> (which
# enforces a denomination prop at the call site) instead of calling
# formatCurrency directly in JSX.
#
# To silence a genuinely denomination-free case, add the file path to the
# ALLOWLIST array with a comment explaining why bare usage is acceptable.
#
# Usage (local):   bash scripts/check-bare-currency.sh
# Usage (CI):      added to prepublish-check as gate "Bare currency check"

set -euo pipefail

# ---------------------------------------------------------------------------
# Allowlist — files that pre-date the <Amount> component and are allowed to
# keep their existing local formatCurrency helpers until they are refactored.
# Do NOT add new files here; use <Amount> instead.
# ---------------------------------------------------------------------------
ALLOWLIST=(
  "client/src/components/certificats/CertificatDetailDialog.tsx"
  "client/src/components/devis/DevisTab.tsx"
  "client/src/components/devis/SituationsSection.tsx"
  "client/src/components/factures/FacturesTab.tsx"
  "client/src/components/fees/OutstandingFeesBanner.tsx"
  "client/src/components/fees/OutstandingFeesPanel.tsx"
  "client/src/components/reconciliation/AccountingStatusBadge.tsx"
  "client/src/components/reconciliation/NeedsReviewTab.tsx"
  "client/src/components/ui/tva-derived-hint.tsx"
  "client/src/pages/architect-fee-invoices.tsx"
  "client/src/pages/certificats.tsx"
  "client/src/pages/communications.tsx"
  "client/src/pages/contractor-detail.tsx"
  "client/src/pages/dashboard.tsx"
  "client/src/pages/document-chain.tsx"
  "client/src/pages/fees.tsx"
  "client/src/pages/financial-tracking.tsx"
  "client/src/pages/project-detail.tsx"
  "client/src/pages/projects.tsx"
  # utils.ts is the canonical definition — the export itself is not a bare call.
  "client/src/lib/utils.ts"
  # amount.tsx is the <Amount> component itself — it calls formatCurrency internally.
  "client/src/components/ui/amount.tsx"
)

# ---------------------------------------------------------------------------
# Find all files containing formatCurrency( (definition OR call site)
# ---------------------------------------------------------------------------
mapfile -t FOUND < <(
  grep -rl "formatCurrency(" client/src --include="*.tsx" --include="*.ts" 2>/dev/null | sort
)

FAILED=0
for file in "${FOUND[@]}"; do
  allowed=0
  for entry in "${ALLOWLIST[@]}"; do
    if [[ "$file" == "$entry" ]]; then
      allowed=1
      break
    fi
  done
  if [[ $allowed -eq 0 ]]; then
    echo "ERROR: bare formatCurrency() found in $file"
    echo "       Use <Amount value={...} denomination=\"HT|TTC|...\" /> instead."
    echo "       If this is genuinely denomination-free, add the file to the"
    echo "       ALLOWLIST in scripts/check-bare-currency.sh with a comment."
    FAILED=1
  fi
done

if [[ $FAILED -eq 1 ]]; then
  echo ""
  echo "Bare currency check FAILED — see errors above."
  exit 1
fi

echo "Bare currency check OK — no unlisted formatCurrency() calls found."
exit 0
