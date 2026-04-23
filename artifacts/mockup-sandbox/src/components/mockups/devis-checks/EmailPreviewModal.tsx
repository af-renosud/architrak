import { useEffect, useMemo, useState } from "react";
import { Send, X, Mail } from "lucide-react";
import {
  PageShell, CardHeader, INITIAL_LINES, type Line, type LineStatus,
  StatusButtons, rowTint, LineItemsHeader, suggestQuestion, SAMPLE,
} from "./_shared";

export function EmailPreviewModal() {
  const [lines, setLines] = useState<Line[]>(INITIAL_LINES);
  const [lineQuestions, setLineQuestions] = useState<Record<number, string>>(() => {
    const seed: Record<number, string> = {};
    for (const li of INITIAL_LINES) {
      if (li.status === "red") seed[li.n] = suggestQuestion(li);
    }
    return seed;
  });
  const [generalQuery, setGeneralQuery] = useState("Pouvez-vous confirmer le délai global du chantier ?");
  const [previewOpen, setPreviewOpen] = useState(false);

  // Auto-seed/clean question drafts when red status flips
  useEffect(() => {
    setLineQuestions((prev) => {
      const next = { ...prev };
      for (const li of lines) {
        if (li.status === "red" && next[li.n] === undefined) next[li.n] = suggestQuestion(li);
        if (li.status !== "red" && next[li.n] !== undefined) delete next[li.n];
      }
      return next;
    });
  }, [lines]);

  const setStatus = (n: number, s: LineStatus) =>
    setLines((prev) => prev.map((l) => (l.n === n ? { ...l, status: s } : l)));

  const redLines = useMemo(() => lines.filter((l) => l.status === "red"), [lines]);
  const generalCount = generalQuery.trim() ? 1 : 0;
  const totalCount = redLines.length + generalCount;

  return (
    <PageShell>
      <CardHeader />
      <div className="ml-3 mt-2 mb-3 border-l-2 border-black/10 pl-3 space-y-3">
        <LineItemsHeader count={lines.length} />

        <div className="overflow-x-auto rounded-lg border border-black/5 bg-white">
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
              {lines.map((li) => (
                <tr key={li.n} className={`border-b border-black/5 ${rowTint(li.status)}`}>
                  <td className="py-1 px-2 text-neutral-500">{li.n}</td>
                  <td className="py-1 px-2 text-neutral-900">{li.desc}</td>
                  <td className="py-1 px-2 text-right tabular-nums font-semibold">{li.totalHt}</td>
                  <td className="py-1 px-2 text-right">
                    <StatusButtons status={li.status} onChange={(s) => setStatus(li.n, s)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Bottom composer panel */}
        <div className="rounded-2xl border-2 border-amber-200 bg-amber-50/60 p-4 space-y-3 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded-full bg-amber-500 text-white text-[9px] font-bold uppercase tracking-widest">Brouillons</span>
              <h3 className="text-[13px] font-black uppercase tracking-tight text-amber-900">
                Communications avec l'entreprise
              </h3>
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <label className="text-[11px] font-black uppercase tracking-wide text-amber-900">
                Questions sur des lignes ({redLines.length})
              </label>
              <p className="text-[10px] text-neutral-500">Auto-créées en cliquant ✕ — modifiez si besoin.</p>
            </div>
            {redLines.length === 0 ? (
              <p className="text-[11px] text-neutral-500 italic px-2 py-2 rounded-md bg-white border border-amber-200">
                Aucune ligne rejetée pour le moment.
              </p>
            ) : (
              <div className="space-y-1.5">
                {redLines.map((li) => (
                  <div key={li.n} className="rounded-md bg-white border border-amber-200 p-2 flex items-start gap-2">
                    <span className="text-[9px] font-bold uppercase tracking-widest text-rose-600 mt-0.5 shrink-0">L{li.n}</span>
                    <input
                      value={lineQuestions[li.n] ?? ""}
                      onChange={(e) => setLineQuestions((prev) => ({ ...prev, [li.n]: e.target.value }))}
                      className="flex-1 text-[11px] bg-transparent focus:outline-none"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="text-[11px] font-black uppercase tracking-wide text-amber-900">Question générale</label>
            <textarea
              rows={2}
              value={generalQuery}
              onChange={(e) => setGeneralQuery(e.target.value)}
              placeholder="Ex : pouvez-vous confirmer le délai global ?"
              className="mt-1 w-full text-[11px] rounded-md border border-amber-200 p-2 bg-white"
            />
          </div>

          <div className="flex items-center gap-2 pt-1 border-t border-amber-200">
            <span className="text-[10px] text-amber-800">
              {totalCount === 0 ? "Aucune question prête" : `${totalCount} question(s) prête(s)`}
            </span>
            <button
              disabled={totalCount === 0}
              onClick={() => setPreviewOpen(true)}
              className="ml-auto inline-flex items-center gap-1.5 h-8 px-4 rounded-md bg-[#0B2545] text-white text-[10px] font-bold uppercase tracking-widest disabled:opacity-40"
            >
              <Send size={12} /> Préparer l'envoi ({totalCount})
            </button>
          </div>
        </div>
      </div>

      {/* Email preview modal */}
      {previewOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-6" onClick={() => setPreviewOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-[720px] max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-black/5">
              <div className="flex items-center gap-2">
                <Mail size={14} className="text-[#0B2545]" />
                <h3 className="text-[13px] font-black uppercase tracking-tight">Aperçu de l'email — confirmer l'envoi</h3>
              </div>
              <button onClick={() => setPreviewOpen(false)} className="text-neutral-400 hover:text-neutral-700">
                <X size={16} />
              </button>
            </div>
            <div className="px-5 py-3 overflow-y-auto flex-1 space-y-3">
              <div className="grid grid-cols-[80px_1fr] gap-y-1 text-[11px]">
                <span className="text-neutral-500">À :</span>
                <span className="font-semibold">contact@at-piscines.fr</span>
                <span className="text-neutral-500">Objet :</span>
                <span className="font-semibold">Questions sur le devis {SAMPLE.code} — {SAMPLE.description}</span>
              </div>
              <div className="rounded-lg border border-black/10 bg-neutral-50/40 p-4 text-[12px] leading-relaxed text-neutral-800 space-y-3">
                <p>Bonjour,</p>
                <p>Nous avons quelques questions concernant le devis <span className="font-semibold">{SAMPLE.code}</span>.
                Merci de répondre via le portail :</p>
                <p className="text-[11px] text-blue-600 underline">https://renosud.app/p/check/••••••••</p>
                {redLines.length > 0 && (
                  <div>
                    <p className="font-semibold">Concernant des lignes spécifiques :</p>
                    <ul className="mt-1.5 space-y-2">
                      {redLines.map((li) => (
                        <li key={li.n}>
                          <p className="text-neutral-600">— Ligne {li.n} : <span className="italic">« {li.desc} »</span> ({li.totalHt} € HT)</p>
                          <p className="ml-3">{lineQuestions[li.n]}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {generalCount > 0 && (
                  <div>
                    <p className="font-semibold">Question générale :</p>
                    <p className="ml-3">{generalQuery}</p>
                  </div>
                )}
                <p>Bien cordialement,<br />Renosud</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-black/5 bg-neutral-50/40">
              <button onClick={() => setPreviewOpen(false)} className="h-8 px-3 text-[10px] font-bold uppercase tracking-widest text-neutral-600 hover:text-neutral-800">
                Annuler
              </button>
              <button className="inline-flex items-center gap-1.5 h-8 px-4 rounded-md bg-[#0B2545] text-white text-[10px] font-bold uppercase tracking-widest">
                <Send size={12} /> Confirmer l'envoi ({totalCount})
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
