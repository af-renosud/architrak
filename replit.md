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

### Directory Structure
```
client/src/
  components/layout/    — AppLayout, Sidebar
  components/ui/        — Shadcn + custom (luxury-card, status-badge, section-header, technical-label)
  components/devis/     — DevisTab component
  pages/                — Dashboard, Projects, Contractors, Financial Tracking, Certificats, Fees,
                          Email Documents, Communications, Project Detail, Contractor Detail
  hooks/                — use-toast, use-mobile
  lib/                  — queryClient, utils
server/
  index.ts              — Express server entry point
  routes.ts             — All API routes
  storage.ts            — DatabaseStorage implementation (IStorage interface)
  db.ts                 — Drizzle ORM database connection
  archidoc/             — ArchiDoc sync: sync-client, sync-service, import-service
  gmail/                — Gmail monitoring: client, monitor, document-parser
  communications/       — certificat-generator, email-sender, payment-scheduler
  storage/              — object-storage.ts (Object Storage wrapper)
  replit_integrations/  — Auto-generated integration code (OpenAI, Gmail, Object Storage)
shared/
  schema.ts             — Drizzle table definitions + Zod insert schemas + types
```

### API Endpoints
**Projects & Financial:**
- `/api/projects` — CRUD for projects
- `/api/contractors` — CRUD for contractors
- `/api/projects/:id/marches` — Marché management
- `/api/projects/:id/lots` — Lot management
- `/api/projects/:id/devis` — Devis management
- `/api/devis/:id/line-items` — Devis line items (Mode B)
- `/api/devis/:id/avenants` — PV/MV variations
- `/api/devis/:id/invoices` — Invoice tracking
- `/api/devis/:id/situations` — Situation de Travaux
- `/api/projects/:id/certificats` — Payment certificates
- `/api/projects/:id/fees` — Fee tracking
- `/api/projects/:id/financial-summary` — Three buckets calculation
- `/api/dashboard/summary` — Global dashboard data

**ArchiDoc Sync:**
- `/api/archidoc/status` — Connection status
- `/api/archidoc/projects` — List ArchiDoc projects (with isTracked flag)
- `/api/archidoc/sync` — Trigger full sync
- `/api/archidoc/track/:id` — Import/track an ArchiDoc project
- `/api/projects/:id/refresh` — Refresh project from ArchiDoc

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
