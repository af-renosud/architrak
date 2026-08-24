# Supplier Direct-Payment Certificate Contract v1.0

**Status:** ArchiTrak-frozen proposal, awaiting ArchiDoc countersignature  
**Frozen by ArchiTrak:** 2026-08-24  
**Wire contract literal:** `supplier-payment-readiness.v1`  
**Fixture:** `docs/wire-fixtures/supplier-payment-readiness-v1.json`

This contract adds supplier direct-payment certificates without creating a
second supplier master and without changing the existing contractor works
certificate rules. ArchiDoc owns supplier master data. ArchiTrak owns imported
financial evidence, certificate calculations, issuance, and payment records.

No production implementation may silently weaken this contract. A field rename,
required-field change, enum change, or semantic change requires a new contract
version and a new fixture; the v1 fixture is never edited in place after both
applications countersign it.

## 1. Canonical partner model

- A supplier remains a canonical ArchiTrak `contractors` record whose
  ArchiDoc-mastered partner type is `supplier`.
- The existing `contractorId` financial foreign keys remain the partner key for
  devis, invoices, certificates, and payment records.
- ArchiTrak must not create a supplier master table or allow local edits to
  ArchiDoc-mastered identity, contact, activity, banking, verification, or RIB
  data.
- An ArchiDoc supplier ID is immutable. A merge or replacement is represented
  as an explicit deletion plus a new supplier ID, never by reusing an ID.

## 2. Certificate-track discriminant

Every certificate must have one server-authoritative track:

| Stored value | French product term | Partner requirement |
|---|---|---|
| `contractor_works` | Certificat de paiement travaux | Partner is a contractor, or a legacy pre-discriminant partner |
| `supplier_direct_payment` | Certificat de paiement fournisseur — paiement direct client | Partner is explicitly `supplier` in a current ArchiDoc mirror |

Migration rules:

1. Every certificate that predates the discriminant is backfilled as
   `contractor_works`.
2. Existing null/unknown partner types never make a row a supplier certificate.
3. The client may express an intended workflow, but the server derives and
   validates the stored track from the creation service, partner type, sources,
   and project assignment.
4. The track is immutable after sealing and cannot change during reissue.

## 3. Track boundaries

### 3.1 Contractor works certificate (`contractor_works`)

The existing behavior is preserved:

- cumulative works and previous-payment waterfall;
- Retenue de Garantie, including the existing default and marché override;
- Compte Prorata;
- contractor acompte recoupment;
- solde and PV de réception rules;
- contractor insurance StopGo at the existing devis-signing boundary;
- the current documentary TVA precedence;
- situations, invoice-backed progress claims, acompte certificates, and legacy
  whole-contractor documents where already supported.

Supplier work must not turn these rules into optional generic flags. They remain
the contractor track.

### 3.2 Supplier direct-payment certificate (`supplier_direct_payment`)

The v1 supplier track is invoice-only:

- Every source is an explicit ArchiTrak invoice row.
- Every selected invoice belongs to one project and one supplier.
- Every invoice has completed the existing authenticated approval transition
  and is in status `approved`, is non-void and unpaid,
  has a non-void parent devis, and carries a positive HT and TTC amount.
- No selected invoice is linked to another non-superseded certificate.
- A draft AI extraction is not payment evidence.
- A situation, acompte request, manual whole-supplier amount, or unscoped
  supplier balance cannot create this track.
- Grouped invoices must have compatible TVA/autoliquidation treatment in v1.
  Incompatible invoices require separate certificates.

For selected invoices `I`:

```text
grossHt      = roundCurrency(sum(I.amountHt))
grossTva     = roundCurrency(sum(I.tvaAmount))
grossTtc     = roundCurrency(sum(I.amountTtc))
grossTtc     must equal roundCurrency(grossHt + grossTva)
netToPayHt   = grossHt
tvaAmount    = grossTva
netToPayTtc  = grossTtc
```

The following values are always zero/false and cannot be overridden on this
track:

- Retenue de Garantie and retenue release;
- cumulative and period Compte Prorata;
- cumulative and period contractor acompte recoupment;
- previous contractor works payments;
- solde designation and PV de réception override.

The supplier track never calls or records a contractor insurance verdict.
This is a typed bypass for an explicit supplier, not an “insurance valid”
result and not an architect override.

## 4. Supplier certificate readiness

Creation, preview, sealing, and sending each re-check readiness server-side.
Readiness requires all of the following:

1. The canonical partner is explicitly `supplier`, has the same immutable
   ArchiDoc ID as the mirror row, is active, and is not deleted.
2. The supplier has a non-empty legal name, valid 14-digit SIRET, legal address,
   and a structured primary contact with a non-empty person name and valid
   email.
3. The project has a current ArchiDoc project ID and an active supplier
   assignment whose `directPaymentStatus` is `eligible` on the issue date.
4. ArchiDoc banking status is `verified`, the account holder is present, the
   IBAN checksum is valid, and the verification provenance is complete.
5. BIC is optional for SEPA v1. If present it must be valid; a malformed BIC
   blocks readiness, while an absent BIC is disclosed on the PDF and does not
   invent a value.
6. Every source invoice satisfies §3.2.
7. Any validated IBAN extracted from an in-scope invoice or parent devis matches
   the ArchiDoc-mastered IBAN after canonical normalization, unless an
   authenticated architect has recorded the existing tuple-specific audited
   override.

An override is scoped to `(document kind, document id, document IBAN,
ArchiDoc IBAN)`. A change to either IBAN invalidates the override. Missing bank
data, unverified banking, inactive/deleted suppliers, and missing/ineligible
project assignments are not overridable in v1.

## 5. Issuance, reissue, and payment invariants

Supplier certificates reuse the existing certificate safety envelope:

- creation and source claims occur in one transaction under the project/partner
  chain lock;
- issuance is idempotent and version-guarded;
- source invoices are claimed exactly once by a live certificate;
- the exact PDF bytes are stored immutably;
- repeated or concurrent sends collapse onto one communication per issuance;
- a failed supplier notice does not duplicate or roll back the client
  certificate communication;
- payment facts use the existing transaction-safe certificate ledger and audit
  log.

The issuance snapshot must freeze at least:

- certificate track and certificate reference;
- project and supplier internal IDs plus ArchiDoc IDs;
- supplier legal name, SIRET, legal address, and primary contact;
- account holder, canonical IBAN, optional BIC, bank name, verification status,
  verifier, verification time, verification method, RIB document ID, and RIB
  SHA-256;
- project-payment assignment ID, status, validity interval, and `updatedAt`;
- exact invoice source IDs, invoice numbers, dates, HT, TVA, and TTC;
- all certificate totals and transfer reference;
- PDF storage key, issue timestamp, and normal issuance audit identity.

A sealed row and its snapshot never change when ArchiDoc data changes later.
Reissue atomically supersedes the old certificate and creates one new draft with
the same track and source set. Reissue does not convert between tracks. Existing
payments and audit entries remain attached to the historical certificate; they
are never moved or deleted by reissue.

## 6. ArchiDoc → ArchiTrak wire contract

### 6.1 Endpoint and authentication

```http
GET /api/integrations/architrak/v1/supplier-payment-readiness
    ?mode=<bootstrap|incremental>
    &afterSequence=<base-10-integer>
    &pageToken=<opaque>
    &limit=<1..500>
Authorization: Bearer <ARCHIDOC_SYNC_API_KEY>
Accept: application/json
```

- `mode=bootstrap` returns one current upsert per supplier as of the frozen
  window. It is used for first sync and recovery; `afterSequence` is forbidden.
- `mode=incremental` returns immutable change-log events whose numeric sequence
  is greater than `afterSequence`. `afterSequence` is required.
- `pageToken` is omitted on the first page. On subsequent pages it is the only
  paging input; it binds mode, bounds, limit, and position to the first page.
- `limit` defaults to 200 and is capped at 500.
- TLS and bearer authentication are mandatory. Credentials never appear in a
  query string, response, fixture, or log.
- `401` means missing/invalid credentials, `403` means valid credentials
  without this integration permission, and `429`/`503` are retryable.

### 6.2 Response

The response key order and field names are pinned by the v1 fixture:

```ts
type Response = {
  contractVersion: "supplier-payment-readiness.v1";
  syncWindow: {
    mode: "bootstrap" | "incremental";
    afterSequenceExclusive: string | null;
    throughSequenceInclusive: string;
    minimumAvailableSequence: string;
  };
  nextPageToken: string | null;
  changes: Array<UpsertChange | DeleteChange>;
};

type UpsertChange = {
  sequence: string;
  operation: "upsert";
  changedAt: string;
  supplier: SupplierPaymentReadiness;
};

type DeleteChange = {
  sequence: string;
  operation: "delete";
  changedAt: string;
  supplierId: string;
};
```

Sequence values are unsigned base-10 integer strings. ArchiDoc allocates them
from one durable, strictly increasing, globally unique sequence whenever any
supplier, nested contact, banking/RIB value, activity flag, project assignment,
or deletion changes. Sequence values are never reused. `changedAt` is audit
display data and never a cursor or ordering key.

For incremental mode, `throughSequenceInclusive` is the greatest committed
sequence captured before the first page is read. Every page covers the same
`(afterSequenceExclusive, throughSequenceInclusive]` window and events are
ordered by numeric `sequence`. One supplier may appear more than once; ArchiTrak
applies every event in order and the later sequence wins. A delete followed by
a later upsert restores the supplier; an upsert followed by a later delete
soft-deletes it.

For bootstrap mode, ArchiDoc materializes or reads a transactionally consistent
snapshot as of `throughSequenceInclusive`, emits exactly one current upsert per
non-deleted supplier, and pages it in stable supplier-ID order. A completed
bootstrap is a guarded full reconciliation: suppliers absent from the complete
snapshot are soft-deleted locally only after all pages validate.

ArchiTrak commits `throughSequenceInclusive` as its next incremental cursor only
after every page has validated and persisted successfully. Replaying any page
is idempotent. Events committed after the frozen upper bound are returned by
the next incremental request even when they share the same `changedAt`.

ArchiDoc may compact old change events only after advancing
`minimumAvailableSequence`. If an incremental request supplies an older cursor,
it returns HTTP `410` with the exact
`docs/wire-fixtures/supplier-payment-readiness-v1-cursor-expired.json` body:

```json
{
  "code": "SYNC_CURSOR_EXPIRED",
  "minimumAvailableSequence": "8000",
  "message": "Run a bootstrap sync before resuming incrementally."
}
```

ArchiTrak then performs a bootstrap and resumes from that
bootstrap's `throughSequenceInclusive`. This is the required recovery path for
an offline consumer; “missing from an incremental page” is never used as a
deletion signal.

### 6.3 Supplier upsert shape

```ts
type SupplierPaymentReadiness = {
  id: string;
  partnerType: "supplier";
  name: string;
  siret: string | null;
  address1: string | null;
  address2: string | null;
  town: string | null;
  postcode: string | null;
  countryCode: string | null;
  isActive: boolean;
  primaryContact: {
    id: string;
    name: string;
    jobTitle: string | null;
    email: string | null;
    mobile: string | null;
  } | null;
  banking: {
    accountHolderName: string | null;
    iban: string | null;
    bic: string | null;
    bankName: string | null;
    bankingVerificationStatus: "unverified" | "verified" | "rejected";
    bankingVerifiedAt: string | null;
    bankingVerifiedBy: {
      id: string;
      displayName: string;
    } | null;
    bankingVerificationMethod:
      | "manual_rib_review"
      | "bank_account_check"
      | "imported_verified"
      | null;
    ribDocument: {
      id: string;
      fileName: string;
      mimeType: "application/pdf";
      sha256: string;
      downloadPath: string;
      updatedAt: string;
    } | null;
  } | null;
  projectPaymentAssignments: Array<{
    id: string;
    projectId: string;
    directPaymentStatus: "eligible" | "not_eligible" | "suspended";
    validFrom: string | null;
    validUntil: string | null;
    reason: string | null;
    updatedAt: string;
  }>;
  updatedAt: string;
};
```

### 6.4 Field rules

- Every v1 upsert contains every documented key. Unknown keys and omitted keys
  fail strict validation.
- Nullable values are JSON `null`; empty strings and whitespace-only strings
  are invalid substitutes for null.
- Sequence strings contain only digits and are compared numerically, never
  lexicographically. Timestamps are ISO 8601 UTC with a `Z` suffix. Assignment
  validity values are ISO `YYYY-MM-DD` calendar dates.
- `name`, IDs, and `updatedAt` are always non-null.
- SIRET may be null while ArchiDoc data is incomplete, but it then blocks
  readiness. Non-null SIRET is 14 digits.
- `primaryContact` is the ArchiDoc-selected primary human contact. Company name
  must never be substituted for the person name.
- `banking: null` means no current banking record. A `verified` record requires
  non-null account holder, IBAN, `bankingVerifiedAt`, `bankingVerifiedBy`,
  method, and RIB document.
- ArchiDoc sends canonical uppercase, no-space IBAN/BIC values. ArchiTrak still
  validates checksum/shape before promotion.
- Raw RIB bytes, AI extraction payloads, credentials, public object URLs, and
  expiring signed URLs never appear in this feed.
- `projectPaymentAssignments` is the complete current assignment set for this
  supplier on every upsert. ArchiTrak replaces its mirrored set atomically.
  Missing project assignment means direct supplier payment is not allowed.
- `validFrom: null` means no lower date bound; `validUntil: null` means no upper
  date bound. Bounds are inclusive.
- `isActive: false` keeps the supplier for history but blocks new certificates.
- A delete change soft-deletes the mirror and blocks new work. Historical
  certificates and snapshots remain readable.
- Absence from an incremental page is never a deletion signal. Absence from a
  completed bootstrap may be reconciled only through the existing guarded
  full-sync policy.

## 7. Protected RIB retrieval

For a non-null `ribDocument`, `downloadPath` must bind both supplier and
document identity:

```text
/api/integrations/architrak/v1/suppliers/{supplierId}/rib/{ribDocumentId}
```

ArchiTrak performs an authenticated `GET` against the configured ArchiDoc
origin using the same bearer credential and this mandatory header:

```http
X-ArchiDoc-RIB-SHA256: <the 64-character sha256 from the feed>
```

ArchiDoc must:

- re-check supplier and integration authorization on every request;
- require the path document ID and request hash to match the supplier's current
  declared RIB version;
- return the current PDF with `Content-Type: application/pdf`,
  `Content-Disposition: attachment`, `Cache-Control: private, no-store`, and an
  `ETag` containing the declared SHA-256;
- return `404` when the declared document never existed for that supplier;
- return HTTP `409` with the pinned
  `docs/wire-fixtures/supplier-rib-version-mismatch-v1.json` body when either
  the document ID or hash no longer matches the current feed version;
- audit successful and refused access without logging the bearer credential or
  document contents.

ArchiTrak mirrors metadata and verification provenance, not a public URL. It may
fetch the RIB just in time for an allowed private attachment. Before any use it
computes SHA-256 over the response bytes and requires an exact match with the
feed value; mismatched bytes are discarded and treated as a security failure.
A RIB attachment fetch failure is recorded and retryable but does not invalidate
an already sealed certificate whose banking snapshot was valid at issuance.

## 8. Ownership split

| Concern | ArchiDoc | ArchiTrak |
|---|---|---|
| Supplier identity, legal address, SIRET | Master | Read-only mirror |
| Primary contact and activity/deletion | Master | Read-only mirror/readiness |
| Banking, verification, RIB bytes | Master | Validated mirror metadata and protected fetch |
| Project direct-payment assignment | Master | Read-only eligibility check |
| Supplier devis and invoice evidence | Reference only | Master |
| Human invoice confirmation | — | Master |
| Certificate track and calculations | — | Master |
| IBAN mismatch override | — | Master, audited |
| PDF seal, reissue lineage, communications | — | Master |
| Payment ledger and audit | — | Master |

## 9. Compatibility and change control

- The current `/api/suppliers` endpoint is not this contract and cannot be used
  for supplier certificate readiness.
- ArchiTrak may keep consuming the current endpoint for non-payment planning
  features until the versioned endpoint is accepted and implemented.
- ArchiDoc must not repurpose contractor insurance fields for suppliers.
- ArchiTrak must not infer supplier readiness from the presence of an IBAN alone.
- After countersignature, either application may reject a payload whose
  `contractVersion` is not exactly `supplier-payment-readiness.v1`.
- Additive fields, enum additions, semantics changes, and endpoint-path changes
  require a v2 proposal, fixture, dual acceptance, and an explicit cutover plan.

## 10. Acceptance record

ArchiDoc acceptance must confirm:

1. endpoint path, auth, pagination, monotonic sequence, bootstrap, and expired-cursor semantics;
2. every field name, type, null rule, and enum;
3. complete-replacement assignment semantics;
4. protected RIB retrieval and SHA-256 behavior;
5. upsert, inactivity, and deletion behavior;
6. byte-for-byte acceptance of the checked-in fixture;
7. its earliest implementation and staging availability date.

Until that confirmation is recorded, this document is the ArchiTrak proposal,
not evidence that the ArchiDoc endpoint exists.

## 11. Existing contractor characterization coverage

The supplier implementation must keep this focused contractor regression map
green rather than duplicating it in downstream tasks:

| Boundary | Characterization |
|---|---|
| Retenue, Prorata, acompte recoupment, TVA waterfall | `server/services/__tests__/contractor-certificate-track.characterization.test.ts` |
| Solde and PV de réception | `server/services/__tests__/certificat-deductions.solde.test.ts`, `server/services/__tests__/certificat-deductions.pv-gate.test.ts` |
| Contractor insurance readiness | `server/services/__tests__/contractor-certificate-track.characterization.test.ts` |
| Missing/mismatched banking | `server/services/__tests__/contractor-certificate-track.characterization.test.ts`, `shared/__tests__/iban.test.ts` |
| Version-guarded immutable seal and issuance snapshot | `server/services/__tests__/certificat-seal.service.test.ts`, `server/routes/__tests__/certificat-seal.test.ts` |
| Contractor PDF Retenue/acompte wording | `server/communications/__tests__/certificat-retenue-explain.test.ts`, `server/communications/__tests__/certificat-acompte-preview.test.ts` |
| Sealed-row email, deduplicated send, contractor notice | `server/communications/__tests__/certificat-send-dedupe.test.ts` |
| Atomic reissue/supersede behavior | `server/__tests__/certificat-reissue.integration.test.ts` |