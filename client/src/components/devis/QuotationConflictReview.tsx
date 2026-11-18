import { Button } from "@/components/ui/button";
import type { DraftConflict, MergeChoices } from "./quotation-three-way";

export function QuotationConflictReview({ conflicts, choices, onChoice, onApply }: {
  conflicts: DraftConflict[]; choices: MergeChoices;
  onChoice: (key: string, choice: "mine" | "latest") => void; onApply: () => void;
}) {
  const show = (value: unknown) => value === undefined ? "Row removed" : typeof value === "string" ? value || "(empty)" : JSON.stringify(value, null, 2);
  return <section aria-label="Compare concurrent changes" className="space-y-3 p-5 border-t">
    <h3 className="font-semibold text-sm">Compare changes before rebasing</h3>
    <p className="text-xs">Non-overlapping changes are combined automatically. Choose each conflicting value explicitly. Nothing is saved by rebasing.</p>
    {conflicts.map(conflict => <fieldset key={conflict.key} className="merge-field text-xs space-y-2">
      <legend className="font-semibold">{conflict.label}</legend>
      <details><summary>Previous snapshot</summary><pre>{show(conflict.base)}</pre></details>
      <div className="grid gap-3 md:grid-cols-2">{(["mine", "latest"] as const).map(choice => <label key={choice} className="block border rounded p-2">
        <input type="radio" name={conflict.key} checked={choices[conflict.key] === choice} onChange={() => onChoice(conflict.key, choice)} />
        <span className="ml-2 font-semibold">{choice === "mine" ? "My draft" : "Latest saved"}</span>
        <pre>{show(conflict[choice])}</pre>
      </label>)}</div>
    </fieldset>)}
    {!conflicts.length && <p className="text-xs">No overlapping edits. Your draft and the latest saved changes can be combined safely.</p>}
    <Button type="button" size="sm" disabled={conflicts.some(conflict => !choices[conflict.key])} onClick={onApply}>Rebase draft onto latest</Button>
  </section>;
}
