import { useReducer, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Calculator, Check, Copy, Delete, X } from "lucide-react";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { calculatorActionForKey, calculatorReducer, initialCalculatorState, type CalculatorAction } from "@/lib/calculator";
import "./calculator.css";

const keys: { label: string; accessible?: string; kind?: string; action: CalculatorAction }[] = [
  { label: "C", accessible: "Effacer", kind: "utility", action: { type: "clear" } },
  { label: "±", accessible: "Changer le signe", kind: "utility", action: { type: "sign" } },
  { label: "%", accessible: "Pourcentage", kind: "utility", action: { type: "percent" } },
  { label: "÷", accessible: "Diviser", kind: "operator", action: { type: "operator", operator: "/" } },
  ...["7", "8", "9"].map(digit => ({ label: digit, action: { type: "digit" as const, digit } })),
  { label: "×", accessible: "Multiplier", kind: "operator", action: { type: "operator", operator: "*" } },
  ...["4", "5", "6"].map(digit => ({ label: digit, action: { type: "digit" as const, digit } })),
  { label: "−", accessible: "Soustraire", kind: "operator", action: { type: "operator", operator: "-" } },
  ...["1", "2", "3"].map(digit => ({ label: digit, action: { type: "digit" as const, digit } })),
  { label: "+", accessible: "Additionner", kind: "operator", action: { type: "operator", operator: "+" } },
  { label: "0", action: { type: "digit", digit: "0" } },
  { label: "backspace", accessible: "Effacer le dernier chiffre", kind: "utility", action: { type: "backspace" } },
  { label: ".", accessible: "Séparateur décimal", action: { type: "decimal" } },
  { label: "=", accessible: "Calculer", kind: "operator", action: { type: "equals" } },
];

interface CalculatorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement>;
}

export function CalculatorDialog({ open, onOpenChange, triggerRef }: CalculatorDialogProps) {
  const [state, dispatch] = useReducer(calculatorReducer, initialCalculatorState);
  const [copyStatus, setCopyStatus] = useState("");
  const copyAttempt = useRef(0);
  const act = (action: CalculatorAction) => {
    copyAttempt.current += 1;
    setCopyStatus("");
    dispatch(action);
  };
  const copy = async () => {
    const attempt = ++copyAttempt.current;
    try {
      await navigator.clipboard.writeText(state.display);
      if (copyAttempt.current === attempt) setCopyStatus("Résultat copié");
    } catch {
      if (copyAttempt.current === attempt) setCopyStatus("Copie indisponible. Sélectionnez le résultat pour le copier.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="z-[60] bg-[#0b2545]/20 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className="calculator-panel"
          data-testid="calculator-dialog"
          tabIndex={-1}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document.querySelector<HTMLElement>("[data-testid='calculator-dialog']")?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            // Preserve native Enter activation for close/copy buttons and Escape for Radix.
            if (event.key === "Enter" && (event.target as HTMLElement).closest("[data-calculator-control]")) return;
            const action = calculatorActionForKey(event.key);
            if (!action) return;
            event.preventDefault();
            event.stopPropagation();
            act(action);
          }}
        >
          <div className="calculator-header">
            <Calculator size={23} aria-hidden="true" />
            <DialogTitle className="text-xl font-semibold tracking-normal">Calculatrice</DialogTitle>
            <DialogPrimitive.Close
              data-calculator-control
              aria-label="Fermer la calculatrice"
              className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg hover:bg-white/10"
            >
              <X size={20} />
            </DialogPrimitive.Close>
          </div>
          <DialogDescription className="sr-only">
            Utilisez les touches ou votre clavier. Entrée pour calculer, C pour effacer, F9 pour changer le signe et Échap pour fermer.
          </DialogDescription>
          <div className="calculator-body">
            <div className="calculator-display">
              <button
                type="button"
                data-calculator-control
                aria-label="Copier le résultat"
                disabled={state.error}
                onClick={copy}
                className="absolute left-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-[#83909e] hover:bg-[#e9edf2] disabled:opacity-40"
              >
                {copyStatus === "Résultat copié" ? <Check size={18} /> : <Copy size={18} />}
              </button>
              <output aria-label="Résultat" aria-live="polite" data-testid="calculator-display">{state.display}</output>
            </div>
            <p role="status" className={copyStatus ? "mt-2 text-xs text-[#526273]" : "sr-only"}>{copyStatus}</p>
            <div className="calculator-keys">
              {keys.map(key => (
                <button
                  key={key.label}
                  type="button"
                  className="calculator-key"
                  data-kind={key.kind}
                  aria-label={key.accessible ?? key.label}
                  onClick={() => act(key.action)}
                >
                  {key.label === "backspace" ? <Delete size={26} aria-hidden="true" /> : key.label}
                </button>
              ))}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
