import { useEffect, useRef } from "react";
import { Landmark, FileText } from "lucide-react";
import type { Contractor } from "@shared/schema";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";

type BankingRecord = Pick<Contractor,
  | "archidocId"
  | "accountHolderName"
  | "iban"
  | "bic"
  | "bankName"
  | "ribDocumentName"
  | "ribDocumentUrl"
  | "bankingVerifiedAt"
  | "bankingVerifiedBy"
>;

function text(value: string | null | undefined) {
  return value?.trim() || null;
}

export function ContractorBankingDetails({ contractor }: { contractor: BankingRecord }) {
  const sectionRef = useRef<HTMLElement>(null);
  const linked = Boolean(text(contractor.archidocId));
  const unavailable = linked
    ? "Indisponible dans la fiche locale synchronisée"
    : "Indisponible dans la fiche locale";
  const verifiedAt = contractor.bankingVerifiedAt;
  const verificationDate = verifiedAt ? new Date(String(verifiedAt)) : null;
  const validDate = verificationDate && !Number.isNaN(verificationDate.getTime());
  const fields = [
    ["Titulaire du compte", text(contractor.accountHolderName)],
    ["Banque", text(contractor.bankName)],
    ["IBAN", text(contractor.iban)],
    ["BIC", text(contractor.bic)],
  ];
  const ribName = text(contractor.ribDocumentName);
  const ribReference = Boolean(text(contractor.ribDocumentUrl));

  useEffect(() => {
    // This section mounts only once the asynchronous contractor query resolves.
    const reachBanking = () => {
      if (window.location.hash === "#banking") {
        sectionRef.current?.scrollIntoView({ block: "start" });
      }
    };
    reachBanking();
    window.addEventListener("hashchange", reachBanking);
    return () => window.removeEventListener("hashchange", reachBanking);
  }, []);

  return (
    <section id="banking" ref={sectionRef} aria-labelledby="banking-heading" className="scroll-mt-24">
      <LuxuryCard data-testid="card-contractor-banking">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Landmark size={14} className="text-muted-foreground" aria-hidden="true" />
            <h2 id="banking-heading" className="text-[14px] font-black uppercase tracking-tight text-foreground">
              Coordonnées bancaires
            </h2>
          </div>
          <TechnicalLabel>Lecture seule</TechnicalLabel>
        </div>

        <p className="mt-2 text-[12px] text-muted-foreground">
          {linked
            ? "Source : ArchiDoc — copie locale des données synchronisées. Leur actualité n’est pas garantie."
            : "Fiche non liée à ArchiDoc — la provenance et la synchronisation de ces données ne sont pas établies."}
        </p>

        <dl className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          {fields.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt><TechnicalLabel>{label}</TechnicalLabel></dt>
              <dd className={`mt-1 text-[12px] break-words ${value ? "text-foreground" : "text-muted-foreground"} ${label === "IBAN" || label === "BIC" ? "font-mono" : ""}`}>
                {value || unavailable}
              </dd>
            </div>
          ))}
          <div className="min-w-0">
            <dt className="flex items-center gap-2">
              <FileText size={12} className="text-muted-foreground" aria-hidden="true" />
              <TechnicalLabel>RIB — document référencé</TechnicalLabel>
            </dt>
            <dd className="mt-1 text-[12px] text-foreground break-words">
              {ribName || (ribReference ? "Référence de document disponible (nom indisponible)" : unavailable)}
            </dd>
            {(ribName || ribReference) && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                {ribReference ? "Référence disponible dans la fiche locale. " : "Nom seul enregistré ; référence indisponible. "}
                Consulter le document original dans ArchiDoc ; aucun téléchargement proposé ici.
              </p>
            )}
          </div>
          <div className="min-w-0">
            <dt><TechnicalLabel>Vérification enregistrée</TechnicalLabel></dt>
            <dd className="mt-1 text-[12px] text-foreground">
              {verifiedAt
                ? validDate
                  ? <>Date enregistrée : <time dateTime={verificationDate.toISOString()}>{verificationDate.toLocaleDateString("fr-FR")}</time></>
                  : "Une date est enregistrée, mais elle est illisible."
                : "Aucune date de vérification disponible dans la fiche locale"}
            </dd>
            <dd className="mt-1 text-[12px] text-muted-foreground break-words">
              {text(contractor.bankingVerifiedBy)
                ? `Auteur enregistré : ${text(contractor.bankingVerifiedBy)}`
                : "Auteur de la vérification indisponible dans la fiche locale"}
            </dd>
          </div>
        </dl>

        <div className="mt-5 border-t border-border pt-4 space-y-2 text-[12px] text-muted-foreground">
          <p>
            Une donnée indisponible ici ne prouve pas son absence dans ArchiDoc.
            La présence de coordonnées et la trace d’une vérification sont distinctes :
            ni l’une ni l’autre ne constitue une autorisation de paiement.
          </p>
          <p>
            {linked
              ? "Pour compléter ou corriger ces informations, enregistrer et vérifier les véritables coordonnées bancaires dans ArchiDoc, laisser la synchronisation habituelle s’effectuer, puis recharger cette fiche."
              : "Vérifier d’abord le rattachement de cette entreprise à ArchiDoc. Enregistrer et vérifier les véritables coordonnées bancaires dans ArchiDoc, puis, une fois le rattachement établi, laisser la synchronisation habituelle s’effectuer et recharger cette fiche."}
          </p>
        </div>
      </LuxuryCard>
    </section>
  );
}
