# ArchiTrak — French Architecture Financial Management

## Overview
ArchiTrak is a financial workflow management application for French architectural firms (maîtres d'œuvre). It manages the full financial lifecycle of construction projects: Marché (contract) → Devis (quotation) → Avenant (PV/MV variations) → Situation de Travaux (progress claims) → Certificat de Paiement (architect-verified payment instruction) → Fee tracking.

Integrates with **ArchiDoc** (project/contractor management) via API sync — projects can ONLY be created by importing from ArchiDoc. Also monitors Gmail for PDF attachments (invoices, quotations) and auto-extracts financial data using AI.

## Architecture

### Tech Stack
- **Frontend**: React 18 + TypeScript, Vite, Tailwind CSS, Shadcn UI, Wouter (routing), TanStack React Query
- **Backend**: Express 5 (Node.js), PostgreSQL, Drizzle ORM
- **Integrations**: ArchiDoc API sync, Gmail monitoring (15-min poll), OpenAI document parsing, Object Storage for PDFs
- **Design System**: Archidoc "Architectural Luxury" — Navy (#0B2545) primary, Inter font family, luxury cards with extreme rounded corners and subtle shadows

### Database Schema (30+ tables)
**Core Financial:**
- `projects` — Client projects with fee configuration + ArchiDoc linkage
- `contractors` — Contractor companies (name, SIRET, contacts, insurance) + ArchiDoc linkage
- `lots` — Construction lot divisions per project
- `marches` — Marché de Travaux Privé contracts (optional per project)
- `devis` — Quotations with Mode A (simple) and Mode B (progress billing) support
- `devis_line_items` — Line items for Mode B progress tracking
- `avenants` — Plus-value (PV) and Moins-value (MV) variation orders
- `invoices` — Contractor invoices linked to devis
- `situations` — Situation de Travaux (cumulative progress claims)
- `situation_lines` — Per-line-item progress in situations
- `certificats` — Certificat de Paiement (architect-verified payment instructions)
- `fees` — Fee tracking (works %, conception, planning)
- `fee_entries` — Individual fee entries linked to invoices

**ArchiDoc Mirror:**
- `archidoc_projects` — Mirrored project data from ArchiDoc
- `archidoc_contractors` — Mirrored contractor data
- `archidoc_contractor_contacts` — Contacts per contractor
- `archidoc_trades` — Trade definitions
- `archidoc_proposal_fees` — Fee proposals from ArchiDoc
- `archidoc_sync_log` — Sync history

**Documents & Communications:**
- `email_documents` — Auto-extracted documents from Gmail with AI parsing
- `project_documents` — Documents attached to projects (manual + auto)
- `project_communications` — Communication log (certificats sent, payment chases, etc.)
- `payment_reminders` — Scheduled payment reminders (7/14/21/30 days)
- `client_payment_evidence` — Client-uploaded payment evidence

### Key Financial Concepts
- **Three Buckets**: Contracted (Devis + Avenants) / Certified (cumulative invoiced) / Reste à Réaliser (remaining)
- **Two Invoicing Modes**: Mode A (simple devis/facture tick-off) and Mode B (Situation de Travaux with % completion per line item)
- **Retenue de Garantie**: 5% holdback on each payment, released after 1 year
- **PV/MV (Plus-value/Moins-value)**: Variation orders that adjust the contracted value
- **Fee Types**: Works percentage (% of contractor HT), Conception (fixed), Planning (fixed)
- **Commission Workflow**: Invoice uploaded (pending) → Approve → auto-calculate commission (project feePercentage × invoice HT) → fee entry created in Honoraires
- **Commission Rate**: Set per-project via editable input in project header (Honoraires %), stored as `feePercentage` on project record
- **Dashboard Layout**: Gmail status bar (last check time) + per-project rows with 4 counter boxes: Devis (approved/unapproved), Signed (all signed status), Factures (approved/unapproved), Agent (ok/warning). No global financial overview cards

### Directory Structure
```
client/src/
  components/layout/    — AppLayout, Sidebar
  components/ui/        — Shadcn + custom (luxury-card, status-badge, section-header, technical-label)
  components/devis/     — DevisTab component
  components/factures/  — FacturesTab component (invoice list, PDF viewer, notes)
  pages/                — Dashboard, Projects, Contractors, Financial Tracking, Certificats, Fees,
                          Email Documents, Communications, Project Detail, Contractor Detail, Login
  hooks/                — use-toast, use-mobile, use-auth
  lib/                  — queryClient, utils, auth-utils
server/
  index.ts              — Express server entry point (session, auth, middleware, route mounting)
  storage.ts            — DatabaseStorage implementation (IStorage interface)
  db.ts                 — Drizzle ORM database connection
  auth/                 — Google OAuth: google-oauth.ts, routes.ts, middleware.ts
  middleware/            — upload.ts (multer), webhook-auth.ts (HMAC-SHA256 signature verification)
  routes/               — Domain-driven router modules (Phase 3 refactor)
    index.ts            — Orchestrator: mounts all domain routers
    projects.ts         — /api/projects CRUD (5 routes)
    contractors.ts      — /api/contractors CRUD + related queries (6 routes)
    marches.ts          — /api/marches CRUD (4 routes)
    lots.ts             — /api/lots CRUD (4 routes)
    devis.ts            — /api/devis CRUD + upload + line-items + avenants (13 routes)
    invoices.ts         — /api/invoices CRUD + upload + approval (7 routes)
    situations.ts       — /api/situations + situation lines (6 routes)
    certificats.ts      — /api/certificats CRUD + preview + send (7 routes)
    fees.ts             — /api/fees + fee-entries + mark-invoiced (8 routes)
    financial.ts        — /api/projects/:id/financial-summary (1 route)
    dashboard.ts        — /api/dashboard/summary (1 route)
    archidoc.ts         — /api/archidoc/* sync/track/status (6 routes)
    gmail.ts            — /api/gmail/* + /api/email-documents/* (7 routes)
    documents.ts        — /api/documents + downloads (4 routes)
    communications.ts   — /api/communications + reminders + payment-evidence (9 routes)
    settings.ts         — /api/settings/* AI models + template assets (6 routes)
    webhooks.ts         — POST /api/webhooks/archidoc (HMAC-protected, 1 route)
  services/             — Business logic services (no HTTP concerns)
    docraptor.ts        — DocRaptor PDF generation client
    devis-upload.service.ts      — AI extraction → validation → Devis draft creation
    invoice-upload.service.ts    — AI extraction → validation → Invoice draft creation
    extraction-validator.ts      — Financial validation layer (HT+TVA=TTC cross-check, auto-liquidation, RG, line items)
    invoice-approval.service.ts  — Approve invoice → fee entry + fee recalculation
    fee-calculation.service.ts   — Mark fee-entry invoiced → fee totals recalculation
    financial-summary.service.ts — Three Buckets aggregation per project
    dashboard.service.ts         — Dashboard summary + burn-up chart data aggregation
    bulk-export.service.ts       — ZIP generation for project financial folder
    webhook.service.ts           — ArchiDoc webhook event routing (13 event types → sync-service)
  archidoc/             — ArchiDoc sync: sync-client, sync-service, import-service
  gmail/                — Gmail monitoring: client, monitor, document-parser
  communications/       — certificat-generator, email-sender, payment-scheduler
  storage/              — object-storage.ts (Object Storage wrapper)
  replit_integrations/  — Auto-generated integration code (OpenAI, Gmail, Object Storage)
shared/
  schema.ts             — Drizzle table definitions + Zod insert schemas + types
  financial-utils.ts    — Pure financial calculation functions (95 tests)
```

### API Endpoints
**Projects & Financial:**
- `/api/projects` — CRUD for projects
- `/api/contractors` — CRUD for contractors
- `/api/projects/:id/marches` — Marché management
- `/api/projects/:id/lots` — Lot management
- `/api/projects/:id/devis` — Devis management
- `/api/devis/:id/line-items` — Devis line items (Mode B)
- `/api/devis/:id/confirm` — Confirm draft devis (with optional corrections)
- `/api/devis/:id/avenants` — PV/MV variations
- `/api/devis/:id/invoices` — Invoice tracking
- `/api/invoices/:id/confirm` — Confirm draft invoice (with optional corrections)
- `/api/devis/:id/situations` — Situation de Travaux
- `/api/projects/:id/certificats` — Payment certificates
- `/api/projects/:id/fees` — Fee tracking
- `/api/projects/:id/fees/by-phase` — Fees grouped by phase (conception/chantier/aor)
- `/api/projects/:id/financial-summary` — Three buckets calculation
- `/api/dashboard/summary` — Global dashboard data
- `/api/projects/:id/burn-up` — Burn-up chart time-series data
- `/api/projects/:id/export` — Bulk export ZIP (Project Financial Folder)

**ArchiDoc Sync:**
- `/api/archidoc/status` — Connection status (includes webhookEnabled, pollingEnabled, webhookSecretConfigured)
- `/api/archidoc/projects` — List ArchiDoc projects (with isTracked flag)
- `/api/archidoc/sync` — Trigger full sync
- `/api/archidoc/track/:id` — Import/track an ArchiDoc project
- `/api/projects/:id/refresh` — Refresh project from ArchiDoc

**Webhooks:**
- `POST /api/webhooks/archidoc` — Event-driven webhook endpoint for ArchiDoc push notifications (OAuth-exempt, HMAC-secured)

**Documents:**
- `/api/email-documents` — List/filter email-extracted documents
- `/api/email-documents/:id` — Detail
- `/api/email-documents/:id/download` — Download original PDF
- `/api/email-documents/:id/process` — Re-process with AI
- `/api/projects/:id/documents` — Project documents
- `/api/projects/:id/documents/upload` — Manual file upload
- `/api/documents/:id/download` — Download project document
- `/api/gmail/status` — Gmail monitoring status
- `/api/gmail/poll` — Trigger immediate poll

**Communications:**
- `/api/communications` — Global communication feed
- `/api/projects/:id/communications` — Project communications
- `/api/communications/:id/send` — Send a communication
- `/api/projects/:id/certificats/:certId/send` — Generate + queue certificat
- `/api/projects/:id/reminders` — Payment reminders
- `/api/reminders/:id/cancel` — Cancel reminder

## Environment Secrets
- `ARCHIDOC_BASE_URL` + `ARCHIDOC_SYNC_API_KEY` — ArchiDoc API connection
- `SESSION_SECRET` — Session management
- `DEFAULT_OBJECT_STORAGE_BUCKET_ID` — Object Storage bucket
- `PRIVATE_OBJECT_DIR` / `PUBLIC_OBJECT_SEARCH_PATHS` — Storage paths

## User Preferences
- French domain terms kept (Devis, Avenant, Marché, Certificat, Honoraires, Lot, Situation, Retenue de Garantie, PV/MV, TVA, SIRET). All other UI in English
- Bilingual data fields (description_fr + description_uk) for client communication
- Projects ONLY created via ArchiDoc API — no manual project creation

## Integration Status (tested 2026-02-28)
- **ArchiDoc sync**: Working. 14 projects, 11 contractors, 29 trades synced successfully. Phase 4: Event-driven webhook mode active (polling disabled by default, re-enable via `ARCHIDOC_POLLING_ENABLED=true`). Webhook endpoint: `POST /api/webhooks/archidoc` — HMAC-SHA256 signature verification, 5-minute replay attack prevention, 13 event types (project/contractor/trade/proposal_fee CRUD + sync.full). Auto-refreshes tracked projects/contractors on relevant events
- **Project import**: Working. LIVERMORE/DANCE and BARTHALON tracked with lots, contractors, fees
- **Lot numbers**: Use text/string codes (e.g. "FN", "GO", "VRD", "EL") — not integers
- **Duplicate detection**: trackProject checks by archidocId first, then by name+clientName match to link untracked projects
- **Client address**: Extracted from ArchiDoc `clients[].homeAddress` (not site address). `refreshProject` also uses this logic
- **Gmail monitoring**: Connector provides limited scope (send only, no read). Monitor detects 403 on first poll, pauses with clear message. Label operations conditionally skipped when permissions are insufficient
- **Devis workflow**: PDF upload → AI converts PDF→PNG via `pdftoppm` → Gemini structured JSON extraction (Expert-Comptable BTP prompt) → financial validation via `extraction-validator.ts` (HT+TVA=TTC cross-check, auto-liquidation, retenue de garantie, line items total) → creates devis as "draft" with validation warnings + AI confidence score → architect reviews in DraftReviewPanel (editable fields, validation badges) → confirms to "pending". Route: `POST /api/projects/:id/devis/upload`, confirm: `POST /api/devis/:id/confirm`
- **Invoice workflow**: Architect does NOT create invoices — they receive and process contractor invoices. Invoices enter the system only via (1) AI extraction from Gmail or (2) manual PDF upload. Same Gemini extraction + validation pipeline → creates invoice as "draft" → architect reviews → confirms to "pending" → then existing approval flow (pending→approved with fee calculation). Route: `POST /api/devis/:devisId/invoices/upload`, confirm: `POST /api/invoices/:id/confirm`
- **AI Extraction Layer (Phase 5)**: Gemini structured output with `responseMimeType: "application/json"` and `responseSchema` — guarantees valid JSON. System prompt defines AI as Expert-Comptable specialise BTP with knowledge of Auto-liquidation de TVA (Article 283-2 nonies CGI), Retenue de Garantie (Loi n 71-584), SIRET/RCS extraction, lot references, Acompte vs Situation distinction. Extracts 20+ fields including invoiceNumber, devisNumber, siret, autoLiquidation, retenueDeGarantie, netAPayer, paymentTerms, lotReferences. Financial validation cross-checks all amounts through `shared/financial-utils.ts` functions. Confidence scoring (0-100) based on checks passed. Auto-correction of missing values (e.g., calculate TTC from HT+rate)
- **AI Model Settings**: Configurable per task type. Default: Gemini 2.0 Flash for document_parsing. Table: `ai_model_settings`. Settings page at `/settings`. Available models: Gemini 2.0 Flash/Lite, 2.5 Flash/Pro, GPT-4o
- **Template Assets**: Logo upload system in Settings for certificate templates. `template_assets` table stores company_logo and architects_order_logo. Served via `/api/template-assets/:type/file`
- **Certificate Numbering**: Auto-sequential per project (C1, C2, C3...). Server assigns next ref on creation via `getNextCertificateRef`. Unique constraint on `(projectId, certificateRef)`. No manual entry
- **Devis Sign-off Gates**: Two mandatory fields before sign-off can advance past "received": (1) Lot assignment via dropdown, (2) English works description (`descriptionUk`). Both validated server-side on certificate send
- **Certificat de Paiement Template**: Full HTML→PDF via DocRaptor (PrinceXML engine). ARCHIDOC design system: Navy gradient cover header, gold accent bars, Inter font, KPI cards for financial figures, zebra-striped tables, info boxes with gold left border, running headers/footers with page numbering. 8 sections: cover header with cert ref, parties (3 cards), works table, cert ref callout, financial KPI cards (HT/TVA/TTC), summary by devis code, payment instruction with amount in French words, footer with Order of Architects registration. **Phase 6**: Added Financial Annexe with two tables — Marche Summary (devis + avenant sub-rows with PV/MV breakdown, per-devis subtotals, grand total) and Situation des Travaux (previous certificat payments, current claim, cumulative total, reste a realiser). Annexe uses `page-break-before: always`, named `@page annexe`, and single `<table>` with repeating `<thead>` for PrinceXML pagination. Scales to 50+ avenants
- **DocRaptor PDF Integration**: `server/services/docraptor.ts` — POST HTML to DocRaptor API, returns PDF buffer. Used by `generateCertificatPdf()` in certificat-generator.ts. Logos converted to base64 data URIs for DocRaptor rendering. PDFs stored in object storage as `.pdf` (not `.html`). Preview route returns `application/pdf`. Email attachments auto-detect content type from file extension
- **Executive Dashboard (Phase 6)**: `getProjectBurnUpData(projectId)` in `dashboard.service.ts` computes time-series: contract value history (from devis + approved avenants over time) and certified value history (cumulative netToPayHt from certificats). Frontend uses recharts `AreaChart` with two series (navy contract, gold certified). Project selector on dashboard page
- **Advanced Fee Tracking (Phase 6)**: `phase` column on fees table (conception/chantier/aor). `GET /api/projects/:id/fees/by-phase` returns fees grouped by phase with subtotals (totalHt/totalInvoiced/totalRemaining) and grand totals. All totals use `roundCurrency()`. Frontend: phase filter tabs, summary cards with progress bars, phase dropdown on fee creation
- **Bulk Export (Phase 6)**: `server/services/bulk-export.service.ts` — generates ZIP with `archiver` package. Structure: `ProjectCode_ProjectName/01_Devis/`, `02_Factures/`, `03_Certificats/`. Downloads PDFs from object storage, generates certificat PDFs on-the-fly if needed. Route: `GET /api/projects/:id/export`. Frontend: "Export Project Folder" button with FolderDown icon, blob download

## Testing Infrastructure
- **Framework**: Vitest 4.x (native Vite integration, TypeScript, ESM)
- **Config**: `vitest.config.ts` — path aliases (`@shared/*`, `@/*`), scoped to `shared/__tests__/**/*.test.ts`
- **Run**: `npx vitest run` (all tests) or `npx vitest` (watch mode)
- **Test files**:
  - `shared/__tests__/financial-utils.test.ts` — roundCurrency, TVA/TTC, Three Buckets, fees, currency formatting (46 tests)
  - `shared/__tests__/number-to-french-words.test.ts` — French number-to-words conversion (49 tests)
  - `shared/__tests__/extraction-validator.test.ts` — HT+TVA=TTC cross-check, auto-liquidation, missing value correction, line items total, retenue de garantie, net a payer, confidence scoring (24 tests)
- **Financial utilities module**: `shared/financial-utils.ts` — pure functions with strict 2-decimal rounding (`roundCurrency` using half-up via `Number.EPSILON`). All currency-returning functions apply rounding before returning. This is a NEW additive module; `routes.ts` and `certificat-generator.ts` still use inline logic (Phase 3 refactor will migrate them)
- **Rounding policy**: `roundCurrency(value)` = `Math.round((value + Number.EPSILON) * 100) / 100` — prevents floating-point drift in financial aggregation

## Authentication (Phase 2)
- **Strategy**: Google Workspace OAuth 2.0 via `google-auth-library` (direct, no Passport)
- **Domain restriction**: `@renosud.com` — double-layer enforcement (Google `hd` param + server-side email suffix check + `email_verified` check)
- **Session store**: PostgreSQL via `connect-pg-simple`, 7-day cookie, `createTableIfMissing: false` (table managed by Drizzle)
- **Session security**: Session ID regenerated on login (prevents fixation), httpOnly + sameSite:lax cookies
- **Route protection**: `requireAuth` middleware on all `/api` routes except `/api/auth/*`; frontend auth gate via `useAuth` hook in `App.tsx`
- **Schema**: `users` table (googleId, email, firstName, lastName, profileImageUrl, lastLoginAt) + `session` table (sid, sess, expire)
- **Files**: `server/auth/google-oauth.ts`, `server/auth/routes.ts`, `server/auth/middleware.ts`, `client/src/hooks/use-auth.ts`, `client/src/pages/login.tsx`
- **Login flow**: `/api/auth/login` → Google consent → `/api/auth/callback` → session created → redirect to `/`
- **Logout**: `/api/auth/logout` → session destroyed → redirect to `/`

## Environment Secrets (updated)
- `GEMINI_API_KEY` — Google Gemini API key for document parsing
- `DOCRAPTOR_API_KEY` — DocRaptor API key for HTML→PDF conversion (PrinceXML engine)
- `GOOGLE_CLIENT_ID` — Google OAuth 2.0 client ID (Cloud Console)
- `GOOGLE_CLIENT_SECRET` — Google OAuth 2.0 client secret (Cloud Console)
- `ARCHIDOC_WEBHOOK_SECRET` — HMAC-SHA256 shared secret for webhook signature verification
- `ARCHIDOC_POLLING_ENABLED` — Set to `"true"` to re-enable legacy polling (default: webhook mode)
