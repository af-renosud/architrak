import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { parseMoneyInput, displayMoneyInput } from "@shared/money-input";

export function ExternalMoneyInput({ id, value, onChange }: {
  id: string; value: string; onChange: (value: string) => void;
}) {
  const parsed = parseMoneyInput(value);
  return <>
    <Input id={id} required inputMode="decimal" type="text" value={value}
      aria-describedby={`${id}-interpretation`}
      onPaste={event => {
        // Inspect the raw clipboard before a single-line input removes tabs/newlines.
        // Multiple spreadsheet cells must never become one concatenated amount.
        event.preventDefault();
        onChange(event.clipboardData.getData("text").trim());
      }}
      onChange={event => onChange(event.target.value)}
      onBlur={() => { if (parsed.kind === "valid" && parsed.value !== value) onChange(parsed.value); }} />
    <div id={`${id}-interpretation`} className="text-xs text-muted-foreground" aria-live="polite">
      {value.trim() && (parsed.kind === "valid"
        ? <>Amount to save: {displayMoneyInput(parsed.value)}</>
        : parsed.kind === "ambiguous"
          ? <><p>{parsed.message}</p><Button type="button" variant="outline" size="sm" className="mt-1"
              onClick={() => onChange(parsed.candidate)}>Use {displayMoneyInput(parsed.candidate)}</Button></>
          : <span className="text-destructive">{parsed.message}</span>)}
    </div>
  </>;
}
