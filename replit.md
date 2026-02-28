# ArchiTrak — French Architecture Financial Management

## Overview
ArchiTrak is a financial workflow management application for French architectural firms (maîtres d'œuvre). It manages the full financial lifecycle of construction projects: Marché (contract) → Devis (quotation) → Avenant (PV/MV variations) → Situation de Travaux (progress claims) → Certificat de Paiement (architect-verified payment instruction) → Fee tracking.

This is a companion application to **Archidoc** (project/contractor management), **ArchiSign** (document signing), and **Ouvro** (site supervision). It runs as a separate service with its own PostgreSQL database, designed to communicate with Archidoc via API in future phases.

## Architecture

### Tech Stack
- **Frontend**: React 18 + TypeScript, Vite, Tailwind CSS, Shadcn UI, Wouter (routing), TanStack React Query
- **Backend**: Express.js (Node.js), PostgreSQL, Drizzle ORM
- **Design System**: Archidoc "Architectural Luxury" — Navy (#0B2545) primary, Inter font family, luxury cards with extreme rounded corners and subtle shadows

### Database Schema (15 tables)
- `projects` — Client projects with fee configuration
- `contractors` — Contractor companies (name, SIRET, contacts)
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
- `conversations`, `messages` — AI chat integration tables (future use)

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
  pages/                — Dashboard, Projects, Contractors, Financial Tracking, Certificats, Fees
  hooks/                — use-toast, use-mobile
  lib/                  — queryClient, utils
server/
  index.ts              — Express server entry point
  routes.ts             — All API routes (CRUD + financial summary + dashboard)
  storage.ts            — DatabaseStorage implementation (IStorage interface)
  db.ts                 — Drizzle ORM database connection
shared/
  schema.ts             — Drizzle table definitions + Zod insert schemas + types
```

### API Endpoints
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

## Future Phases
- **Phase 2**: Gmail integration (15-min polling), AI PDF extraction, human-in-the-loop verification
- **Phase 3**: Certificate PDF generation, email sending, payment chasing, communication hub
- **Phase 4**: Project-level AI Q&A (Notebook LM-style financial advisor)
- **Phase 5**: Archidoc API integration for project/contractor data sync

## User Preferences
- French UI language throughout (navigation, labels, placeholders)
- Bilingual data fields (description_fr + description_uk) for client communication
- Penny Lane (pennylane.com) is the external accounting system — manual bridge for invoice references
- No dark mode by default (design system is light-focused)
