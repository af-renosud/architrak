import { useEffect, useMemo, useState } from "react";
import { Send, Eye, Trash2 } from "lucide-react";
import {
  PageShell, CardHeader, INITIAL_LINES, type Line, type LineStatus,
  StatusButtons, rowTint, LineItemsHeader, suggestQuestion,
} from "./_shared";

type LineQuestion = { lineN: number; text: string };

export function OutboxFooter() {
  const [lines, setLines] = useState<Line[]>(INITIAL_LINES);
  const [lineQuestions, setLineQuestions] = useState<Record<number, string>>(() => {
    const seed: Record<number, string> = {};
    for (const li of INITIAL_LINES) {
      if (li.status === "red") seed[li.n] = suggestQuestion(li);
    }
    return seed;
  });
  const [generalQuery, setGeneralQuery] = useState("Pouvez-vous confirmer le délai global du chantier ?");

  // Keep questions in sync with red status: clicking red on a fresh line
  // seeds a draft question; toggling red off removes the draft.
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
  const lineQs: LineQuestion[] = redLines.map((l) => ({ lineN: l.n, text: lineQuestions[l.n] ?? "" }));
  const generalCount = generalQuery.trim() ? 1 : 0;
  const totalCount = lineQs.length + generalCount;

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

        {/* Outbox footer card — pinned to bottom of devis */}
        <div className="rounded-2xl border-2 border-amber-200 bg-amber-50/60 p-4 space-y-3 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded-full bg-amber-500 text-white text-[9px] font-bold uppercase tracking-widest">À envoyer</span>
              <h3 className="text-[13px] font-black uppercase tracking-tight text-amber-900">
                Communications avec l'entreprise
              </h3>
            </div>
            <span className="text-[10px] text-amber-700">
              {totalCount === 0 ? "Aucune question prête" : `${totalCount} question(s) prête(s) — voir le récap ci-dessous`}
            </span>
          </div>

          <Section title={`Questions sur des lignes (${lineQs.length})`} subtitle="Auto-créées en cliquant ✕ sur une ligne. Modifiez le texte si besoin.">
            {lineQs.length === 0 ? (
              <p className="text-[11px] text-neutral-500 italic px-2 py-3">
                Aucune ligne rejetée pour le moment. Cliquez sur le ✕ rouge dans le tableau pour ouvrir une question.
              </p>
            ) : (
              <div className="space-y-2">
                {lineQs.map((q) => {
                  const li = lines.find((l) => l.n === q.lineN)!;
                  return (
                    <div key={q.lineN} className="rounded-lg bg-white border border-amber-200 p-2.5 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-[10px] text-neutral-500">
                          <span className="font-bold text-rose-600">Ligne {li.n}</span> · {li.desc} · <span className="tabular-nums">{li.totalHt} € HT</span>
                        </div>
                        <button
                          onClick={() => setStatus(li.n, null)}
                          className="text-[9px] text-neutral-400 hover:text-rose-600 inline-flex items-center gap-1"
                          title="Retirer cette question (annule le rejet)"
                        >
                          <Trash2 size={10} /> retirer
                        </button>
                      </div>
                      <textarea
                        value={q.text}
                        onChange={(e) =>
                          setLineQuestions((prev) => ({ ...prev, [q.lineN]: e.target.value }))
                        }
                        rows={2}
                        className="w-full text-[11px] rounded-md border border-amber-200 p-1.5 bg-amber-50/30 focus:outline-none focus:bg-white focus:border-amber-400"
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          <Section title="Question générale (non liée à une ligne)" subtitle="Question libre sur l'ensemble du devis.">
            <textarea
              rows={2}
              value={generalQuery}
              onChange={(e) => setGeneralQuery(e.target.value)}
              placeholder="Ex : pouvez-vous confirmer le délai global ?"
              className="w-full text-[11px] rounded-md border border-amber-200 p-1.5 bg-white"
            />
          </Section>

          <Section title="Récapitulatif d'envoi" subtitle="Un seul email avec un lien portail vers toutes ces questions.">
            <div className="rounded-lg bg-white border border-amber-200 p-2.5 space-y-2">
              <ul className="text-[11px] text-neutral-700 space-y-1">
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                  {lineQs.length} question(s) sur des lignes
                </li>
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                  {generalCount} question(s) générale(s)
                </li>
                <li className="flex items-center gap-2 pt-0.5 border-t border-black/5">
                  <span className="text-[10px] text-neutral-500">Destinataire :</span>
                  <span className="font-semibold">contact@at-piscines.fr</span>
                </li>
              </ul>
              <div className="flex items-center gap-2 pt-1">
                <button className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-amber-300 bg-white text-[10px] font-bold uppercase tracking-widest text-amber-800 hover:bg-amber-50">
                  <Eye size={12} /> Aperçu côté entreprise
                </button>
                <button
                  disabled={totalCount === 0}
                  className="ml-auto inline-flex items-center gap-1.5 h-8 px-4 rounded-md bg-[#0B2545] text-white text-[10px] font-bold uppercase tracking-widest disabled:opacity-40"
                >
                  <Send size={12} /> Envoyer à l'entreprise ({totalCount})
                </button>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </PageShell>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div>
        <h4 className="text-[11px] font-black uppercase tracking-wide text-amber-900">{title}</h4>
        {subtitle && <p className="text-[10px] text-neutral-500">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}
