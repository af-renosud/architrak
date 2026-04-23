import { useEffect, useMemo, useState } from "react";
import { Send, MessageSquare, X, Check } from "lucide-react";
import {
  PageShell, CardHeader, INITIAL_LINES, type Line, type LineStatus,
  StatusButtons, rowTint, LineItemsHeader, suggestQuestion,
} from "./_shared";

export function InlinePopover() {
  const [lines, setLines] = useState<Line[]>(INITIAL_LINES);
  const [lineQuestions, setLineQuestions] = useState<Record<number, string>>(() => {
    const seed: Record<number, string> = {};
    for (const li of INITIAL_LINES) {
      if (li.status === "red") seed[li.n] = suggestQuestion(li);
    }
    return seed;
  });
  const [openPopoverFor, setOpenPopoverFor] = useState<number | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [generalQuery, setGeneralQuery] = useState("Pouvez-vous confirmer le délai global du chantier ?");

  const setStatus = (n: number, s: LineStatus) => {
    setLines((prev) => prev.map((l) => (l.n === n ? { ...l, status: s } : l)));
    if (s === "red") {
      // Auto-create: seed (and persist) the question immediately so the bottom
      // mirror reflects this check even if the architect closes the popover
      // without explicitly saving. The popover is an editor, not a creator.
      const li = lines.find((l) => l.n === n);
      const text = lineQuestions[n] ?? (li ? suggestQuestion(li) : "");
      setLineQuestions((prev) => (prev[n] !== undefined ? prev : { ...prev, [n]: text }));
      setDraft(text);
      setOpenPopoverFor(n);
    } else {
      // toggling red off removes the question (line is no longer flagged)
      setLineQuestions((prev) => {
        const next = { ...prev };
        delete next[n];
        return next;
      });
      if (openPopoverFor === n) setOpenPopoverFor(null);
    }
  };

  const openExisting = (n: number) => {
    setDraft(lineQuestions[n] ?? "");
    setOpenPopoverFor(n);
  };

  // Save = persist whatever is in the draft buffer, then close.
  const saveDraft = () => {
    if (openPopoverFor == null) return;
    setLineQuestions((prev) => ({ ...prev, [openPopoverFor]: draft.trim() || prev[openPopoverFor] || "" }));
    setOpenPopoverFor(null);
  };

  // Cancel = discard the in-flight edits in `draft`, but the check itself is
  // already created (seeded on red click), so the previously-saved text stays.
  const cancelDraft = () => setOpenPopoverFor(null);

  // Esc closes popover
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenPopoverFor(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const linesWithQuestion = useMemo(
    () => lines.filter((l) => l.status === "red" && (lineQuestions[l.n] ?? "").trim().length > 0),
    [lines, lineQuestions],
  );
  const generalCount = generalQuery.trim() ? 1 : 0;
  const totalCount = linesWithQuestion.length + generalCount;

  return (
    <PageShell>
      <CardHeader />
      <div className="ml-3 mt-2 mb-3 border-l-2 border-black/10 pl-3 space-y-3">
        <LineItemsHeader count={lines.length} />

        <div className="overflow-x-auto rounded-lg border border-black/5 bg-white relative">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-black/10 bg-neutral-50/60">
                <th className="py-1 px-2 text-left text-[8px] font-black uppercase tracking-widest">#</th>
                <th className="py-1 px-2 text-left text-[8px] font-black uppercase tracking-widest">Description</th>
                <th className="py-1 px-2 text-right text-[8px] font-black uppercase tracking-widest">Total HT</th>
                <th className="py-1 px-2 text-right text-[8px] font-black uppercase tracking-widest">État</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((li) => {
                const hasSavedQ = li.status === "red" && (lineQuestions[li.n] ?? "").trim().length > 0;
                return (
                  <tr key={li.n} className={`border-b border-black/5 ${rowTint(li.status)} relative`}>
                    <td className="py-1 px-2 text-neutral-500">{li.n}</td>
                    <td className="py-1 px-2 text-neutral-900">
                      <div className="flex items-center gap-2">
                        <span>{li.desc}</span>
                        {hasSavedQ && (
                          <button
                            onClick={() => openExisting(li.n)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 text-[9px] font-bold uppercase tracking-widest hover:bg-rose-200"
                            title={lineQuestions[li.n]}
                          >
                            <MessageSquare size={9} /> question rédigée
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="py-1 px-2 text-right tabular-nums font-semibold">{li.totalHt}</td>
                    <td className="py-1 px-2 text-right relative">
                      <StatusButtons
                        status={li.status}
                        onChange={(s) => setStatus(li.n, s)}
                      />
                      {openPopoverFor === li.n && (
                        <div className="absolute right-2 top-7 z-20 w-[380px] rounded-xl border-2 border-rose-300 bg-white shadow-xl p-3 text-left">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] font-bold uppercase tracking-widest text-rose-700">
                              Question pour l'entreprise · ligne {li.n}
                            </span>
                            <button onClick={cancelDraft} className="text-neutral-400 hover:text-neutral-700">
                              <X size={12} />
                            </button>
                          </div>
                          <p className="text-[10px] text-neutral-500 mb-2 italic">« {li.desc} » — {li.totalHt} € HT</p>
                          <textarea
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            rows={3}
                            className="w-full text-[11px] rounded-md border border-rose-200 p-2 focus:outline-none focus:border-rose-400"
                            autoFocus
                          />
                          <div className="flex items-center justify-end gap-2 mt-2">
                            <button onClick={cancelDraft} className="h-7 px-2.5 text-[10px] font-bold uppercase tracking-widest text-neutral-500 hover:text-neutral-700">
                              Annuler
                            </button>
                            <button
                              onClick={saveDraft}
                              className="inline-flex items-center gap-1 h-7 px-3 rounded-md bg-rose-600 text-white text-[10px] font-bold uppercase tracking-widest hover:bg-rose-700"
                            >
                              <Check size={10} /> Enregistrer
                            </button>
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Bottom mirror — read-only digest of what will go out */}
        <div className="rounded-2xl border-2 border-[#0B2545]/20 bg-white p-4 space-y-3 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded-full bg-[#0B2545] text-white text-[9px] font-bold uppercase tracking-widest">Prêt à envoyer</span>
              <h3 className="text-[13px] font-black uppercase tracking-tight text-[#0B2545]">
                Communications avec l'entreprise
              </h3>
            </div>
            <span className="text-[10px] text-neutral-500">
              Les questions sur lignes se rédigent en cliquant ✕ dans le tableau ci-dessus
            </span>
          </div>

          <div className="rounded-lg border border-[#0B2545]/10 bg-[#0B2545]/[.03] p-3">
            <p className="text-[11px] text-neutral-700">
              Voici ce qui partira à <span className="font-semibold">contact@at-piscines.fr</span> :
            </p>
            <ul className="mt-2 space-y-1.5 text-[11px]">
              {linesWithQuestion.length === 0 ? (
                <li className="text-neutral-500 italic">Aucune question sur des lignes pour le moment.</li>
              ) : (
                linesWithQuestion.map((li) => (
                  <li key={li.n} className="flex items-start gap-2">
                    <span className="mt-1 w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />
                    <span className="flex-1">
                      <span className="text-rose-700 font-semibold">Ligne {li.n} · {li.desc.slice(0, 40)}{li.desc.length > 40 ? "…" : ""}</span>
                      <span className="block text-neutral-600 italic">« {(lineQuestions[li.n] ?? "").slice(0, 110)}{(lineQuestions[li.n] ?? "").length > 110 ? "…" : ""} »</span>
                    </span>
                  </li>
                ))
              )}
              {generalCount > 0 && (
                <li className="flex items-start gap-2 pt-1 border-t border-black/5">
                  <span className="mt-1 w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" />
                  <span className="flex-1">
                    <span className="text-slate-700 font-semibold">Question générale</span>
                    <span className="block text-neutral-600 italic">« {generalQuery.slice(0, 110)}{generalQuery.length > 110 ? "…" : ""} »</span>
                  </span>
                </li>
              )}
            </ul>
          </div>

          <div>
            <label className="text-[11px] font-black uppercase tracking-wide text-[#0B2545]">Question générale (non liée à une ligne)</label>
            <textarea
              rows={2}
              value={generalQuery}
              onChange={(e) => setGeneralQuery(e.target.value)}
              placeholder="Ex : pouvez-vous confirmer le délai global ?"
              className="mt-1 w-full text-[11px] rounded-md border border-[#0B2545]/20 p-2 bg-white"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] text-neutral-500">
              {totalCount === 0 ? "Aucune question prête" : `${totalCount} question(s) — un seul email avec lien portail`}
            </span>
            <button
              disabled={totalCount === 0}
              className="ml-auto inline-flex items-center gap-1.5 h-8 px-4 rounded-md bg-[#0B2545] text-white text-[10px] font-bold uppercase tracking-widest disabled:opacity-40"
            >
              <Send size={12} /> Envoyer à l'entreprise ({totalCount})
            </button>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
