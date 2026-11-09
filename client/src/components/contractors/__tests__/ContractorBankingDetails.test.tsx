// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { ContractorBankingDetails } from "../ContractorBankingDetails";

type BankingRecord = ComponentProps<typeof ContractorBankingDetails>["contractor"];
const missing: BankingRecord = {
  archidocId: "entreprise-atelier-17",
  accountHolderName: null,
  iban: null,
  bic: null,
  bankName: null,
  ribDocumentName: null,
  ribDocumentUrl: null,
  bankingVerifiedAt: null,
  bankingVerifiedBy: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("ContractorBankingDetails", () => {
  it("explains missing local data without asserting absence upstream", () => {
    render(<ContractorBankingDetails contractor={missing} />);
    expect(screen.getAllByText("Indisponible dans la fiche locale synchronisée")).toHaveLength(5);
    expect(screen.getByText(/ne prouve pas son absence dans ArchiDoc/)).toBeTruthy();
    expect(screen.getByText(/enregistrer et vérifier les véritables coordonnées/)).toBeTruthy();
    expect(screen.getByText(/synchronisation habituelle.*recharger/)).toBeTruthy();
    expect(screen.getByText(/Aucune date de vérification disponible/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renders populated bank data and recorded verification, not payment eligibility", () => {
    render(<ContractorBankingDetails contractor={{
      ...missing,
      accountHolderName: "Atelier des Rives",
      iban: "FR7630006000011234567890189",
      bic: "AGRIFRPP",
      bankName: "Crédit Agricole",
      ribDocumentName: "RIB Atelier des Rives.pdf",
      ribDocumentUrl: "https://bank.example.test/private/rib",
      bankingVerifiedAt: new Date("2026-05-14T12:00:00Z"),
      bankingVerifiedBy: "Camille Bernard",
    }} />);
    for (const value of ["Atelier des Rives", "FR7630006000011234567890189", "AGRIFRPP", "Crédit Agricole", "RIB Atelier des Rives.pdf"]) {
      expect(screen.getByText(value)).toBeTruthy();
    }
    expect(screen.getByText("14/05/2026")).toBeTruthy();
    expect(screen.getByText("Auteur enregistré : Camille Bernard")).toBeTruthy();
    expect(screen.getByText(/ne constitue une autorisation de paiement/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/dernière synchronisation/i)).toBeNull();
  });

  it("keeps partial banking presence separate from missing verification", () => {
    render(<ContractorBankingDetails contractor={{ ...missing, iban: "FR7630006000011234567890189", ribDocumentName: "rib.pdf" }} />);
    expect(screen.getByText("FR7630006000011234567890189")).toBeTruthy();
    expect(screen.getAllByText("Indisponible dans la fiche locale synchronisée")).toHaveLength(3);
    expect(screen.getByText(/Aucune date de vérification disponible/)).toBeTruthy();
    expect(screen.getByText(/Nom seul enregistré/)).toBeTruthy();
  });

  it("does not infer banking presence from recorded verification alone", () => {
    render(<ContractorBankingDetails contractor={{ ...missing, bankingVerifiedAt: new Date("2026-05-14T12:00:00Z"), bankingVerifiedBy: "Camille Bernard" }} />);
    expect(screen.getAllByText("Indisponible dans la fiche locale synchronisée")).toHaveLength(5);
    expect(screen.getByText("14/05/2026")).toBeTruthy();
  });

  it("describes an unlinked contractor honestly even when some data is present", () => {
    render(<ContractorBankingDetails contractor={{ ...missing, archidocId: null, bankName: "Banque des Rives" }} />);
    expect(screen.getByText(/Fiche non liée à ArchiDoc/)).toBeTruthy();
    expect(screen.getByText(/provenance et la synchronisation.*ne sont pas établies/)).toBeTruthy();
    expect(screen.getByText(/Vérifier d’abord le rattachement/)).toBeTruthy();
    expect(screen.getByText("Banque des Rives")).toBeTruthy();
    expect(screen.getAllByText("Indisponible dans la fiche locale")).toHaveLength(4);
    expect(screen.queryByText(/copie locale des données synchronisées/)).toBeNull();
  });

  it("never renders an arbitrary RIB URL as a link or embedded document", () => {
    const { container } = render(<ContractorBankingDetails contractor={{ ...missing, ribDocumentUrl: "javascript:alert('unsafe')" }} />);
    expect(screen.getByText("Référence de document disponible (nom indisponible)")).toBeTruthy();
    expect(container.querySelector("a, iframe, object, embed")).toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
  });

  it("handles whitespace and incomplete verification metadata without inventing a date", () => {
    render(<ContractorBankingDetails contractor={{ ...missing, iban: "  ", bankingVerifiedBy: "Camille Bernard" }} />);
    expect(screen.getAllByText("Indisponible dans la fiche locale synchronisée")).toHaveLength(5);
    expect(screen.getByText(/Aucune date de vérification disponible/)).toBeTruthy();
    expect(screen.getByText("Auteur enregistré : Camille Bernard")).toBeTruthy();
  });

  it("reaches the banking anchor when it mounts after asynchronous loading", () => {
    window.history.replaceState(null, "", "/entreprises/17#banking");
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const { rerender } = render(<div>Chargement</div>);
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(<ContractorBankingDetails contractor={missing} />);
    const region = screen.getByRole("region", { name: "Coordonnées bancaires" });
    expect(region.id).toBe("banking");
    expect(within(region).getByText("Lecture seule")).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });
});
