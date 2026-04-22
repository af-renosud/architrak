# ArchiTrak — French Architecture Financial Management

## Overview
ArchiTrak is a financial workflow management application designed for French architectural firms (maîtres d'œuvre). Its primary purpose is to manage the complete financial lifecycle of construction projects, from initial contracts (Marché) and quotations (Devis) through variations (Avenant), progress claims (Situation de Travaux), and architect-verified payment instructions (Certificat de Paiement), up to fee tracking. The application integrates with ArchiDoc for project and contractor management and features AI-powered extraction of financial data from PDF attachments in Gmail. The business vision is to streamline financial operations for architectural firms, improving accuracy and efficiency in project billing and financial oversight.

## User Preferences
- French domain terms kept (Devis, Avenant, Marché, Certificat, Honoraires, Lot, Situation, Retenue de Garantie, PV/MV, TVA, SIRET). All other UI in English.
- Bilingual data fields (description_fr + description_uk) for client communication.
- Projects ONLY created via ArchiDoc API — no manual project creation.

## System Architecture

### Tech Stack
- **Frontend**: React 18 + TypeScript, Vite, Tailwind CSS, Shadcn UI, Wouter, TanStack React Query
- **Backend**: Express 5 (Node.js), PostgreSQL, Drizzle ORM
- **Integrations**: ArchiDoc API, Gmail API, OpenAI, Object Storage
- **Design System**: Archidoc "Architectural Luxury" (Navy primary, Inter font, luxury cards with rounded corners and subtle shadows)

### Core Financial Concepts
- **Three Buckets**: Contracted, Certified, Reste à Réaliser
- **Two Invoicing Modes**: Mode A (simple tick-off) and Mode B (percentage completion per line item)
- **Retenue de Garantie**: 5% holdback
- **PV/MV**: Variation orders adjusting contract value
- **Fee Types**: Works percentage, Conception, Planning
- **Commission Workflow**: Invoice upload → approval → auto-calculation of commission → fee entry
- **Commission Rate**: Project-specific `feePercentage`
- **Dashboard Layout**: Gmail status bar, per-project rows with four counter boxes (Devis, Signed, Factures, Agent)

### Technical Implementations
- **Database Schema**: 30+ tables covering core financial data (projects, contractors, lots, marches, devis, avenants, invoices, situations, certificats, fees, fee_entries), ArchiDoc mirrors, and document/communication tracking.
- **AI Extraction Layer**: Uses Google Gemini (Expert-Comptable BTP prompt) for structured JSON extraction from PDFs, with `extraction-validator.ts` for financial validation and confidence scoring.
- **Certificat de Paiement Generation**: HTML to PDF conversion via DocRaptor (PrinceXML engine), adhering to ARCHIDOC design system with detailed financial annexes. Auto-sequential numbering per project.
- **ArchiDoc Sync**: Event-driven webhook (HMAC-secured) for project and contractor data synchronization, with polling as a fallback.
- **Authentication**: Google Workspace OAuth 2.0 with domain restriction (`@renosud.com`), PostgreSQL session store, robust security measures. A dev-only `POST /api/auth/dev-login` endpoint is registered ONLY when `NODE_ENV !== "production"` AND `ENABLE_DEV_LOGIN_FOR_E2E=true`; it is used by Playwright browser tests in `tests/browser/`. Run them with `npx playwright test` (config in `playwright.config.ts`).
- **Error Handling**: Global error handler prevents stack trace leakage; all API routes use Zod for payload validation.
- **Rate Limiting**: Token-bucket algorithm with pluggable store (in-memory or Postgres-backed).
- **Rounding Policy**: Strict 2-decimal rounding (`roundCurrency`) for all financial calculations.
- **Document Storage**: PDFs and other documents are stored in object storage.
- **API Structure**: Domain-driven routing (`/api/projects`, `/api/contractors`, `/api/devis`, etc.) for CRUD operations and specialized financial workflows.
- **Fee Tracking**: Advanced fee tracking with `phase` (conception/chantier/aor) and by-phase summaries.
- **Executive Dashboard**: Burn-up charts showing contract and certified value history over time.
- **Bulk Export**: Generates ZIP archives of project financial documents from object storage.

### Core Development Protocols
- **Zero-Tolerance TypeScript**: No `any`, `@ts-ignore`, `@ts-expect-error`. Unknown types must be Zod-parsed.
- **Environment Variables**: Zod-validated fail-fast exports from `server/env.ts` only.
- **API Perimeter Validation**: Strict Zod schemas via `validateRequest` middleware for all HTTP inputs.
- **Database Mutations**: Drizzle versioned migrations (`db:generate`, `db:migrate`).
- **Error Handling**: No stack traces or raw database errors to clients; all exceptions handled by `server/middleware/error-handler.ts`.

## External Dependencies
- **ArchiDoc API**: For project and contractor data synchronization.
- **Google Gemini API**: For AI-powered document parsing and financial data extraction from PDFs.
- **DocRaptor API**: For high-fidelity HTML to PDF conversion (PrinceXML engine) of Certificats de Paiement.
- **Google OAuth 2.0**: For user authentication and authorization.
- **Gmail API**: For monitoring incoming emails and extracting PDF attachments.
- **PostgreSQL**: Primary database for all application data and session storage.
- **Object Storage**: For storing uploaded and generated PDF documents and other files.