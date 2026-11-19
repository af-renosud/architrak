import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";

export type ExternalDelivery = {
  id: number;
  sentOn: string;
  method: string;
  recipient: string;
  note: string;
  recordedAt: string;
  currentDocument: boolean;
};

const methods: Record<string, string> = {
  email: "Email", whatsapp: "WhatsApp", post: "Post", hand: "By hand", other: "Other",
};

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

export function ContractorCopyExternalRecord({ devisId, contractorName, canRecord, version, deliveries, onSaved, onFailed }: {
  devisId: number;
  contractorName: string | null;
  canRecord: boolean;
  version: string | null;
  deliveries: ExternalDelivery[];
  onSaved: (data: unknown) => void;
  onFailed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ sentOn: "", method: "email", recipient: "", note: "", confirmed: false });
  const [identity, setIdentity] = useState("");
  const [expectedVersion, setExpectedVersion] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!canRecord || !expectedVersion || !draft.confirmed) throw new Error("This delivery cannot currently be recorded.");
      const response = await apiRequest("POST", `/api/devis/${devisId}/contractor-copy/external`, {
        requestId: identity, expectedVersion, sentOn: draft.sentOn, method: draft.method,
        recipient: draft.recipient.trim(), note: draft.note.trim(), confirmed: true,
      });
      return response.json();
    },
    onSuccess: data => {
      onSaved(data);
      setOpen(false);
      setIdentity("");
      setSaved(true);
    },
    onError: () => onFailed(),
  });
  function updateDraft(update: Partial<typeof draft>) {
    // Retry an unchanged uncertain request with its original identity. A deliberate
    // edit is a new intent and must not reuse an idempotency key with a new body.
    if (mutation.isError) {
      setIdentity(requestId());
      mutation.reset();
    }
    setDraft(previous => ({ ...previous, ...update }));
  }
  const fieldClass = "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  return <div className="mt-3 space-y-3">
    {!open && <Button type="button" size="sm" variant="outline" disabled={!canRecord || !version}
      onClick={() => {
        if (!identity) {
          setIdentity(requestId());
          setExpectedVersion(version);
          setDraft({ sentOn: today(), method: "email", recipient: contractorName ?? "", note: "", confirmed: false });
          mutation.reset();
        } else if (version !== expectedVersion) {
          setExpectedVersion(version);
          setIdentity(requestId());
          setDraft(previous => ({ ...previous, confirmed: false }));
          mutation.reset();
        }
        setSaved(false);
        setOpen(true);
      }}>Sent by other means</Button>}
    {saved && <p role="status" className="text-xs text-muted-foreground">Delivery recorded manually. No email was sent by Architrak.</p>}
    {open && <form className="space-y-3 rounded border border-border bg-muted/20 p-3"
      aria-label="Record external contractor delivery"
      onSubmit={event => { event.preventDefault(); if (!mutation.isPending && canRecord && version === expectedVersion) mutation.mutate(); }}>
      <div>
        <p className="text-sm font-semibold">Sent by other means</p>
        <p className="mt-1 text-xs text-muted-foreground">Record a delivery you already made outside Architrak. This is an operator-recorded statement, not proof of receipt. Architrak will not send an email.</p>
      </div>
      <fieldset disabled={mutation.isPending} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium">Date sent
            <input className={fieldClass} type="date" required max={today()} value={draft.sentOn}
              onChange={e => updateDraft({ sentOn: e.target.value })} />
          </label>
          <label className="text-xs font-medium">Delivery method
            <select className={fieldClass} value={draft.method} onChange={e => updateDraft({ method: e.target.value })}>
              {Object.entries(methods).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>
        <label className="block text-xs font-medium">Recipient
          <input className={fieldClass} required maxLength={300} value={draft.recipient}
            onChange={e => updateDraft({ recipient: e.target.value })} />
        </label>
        <label className="block text-xs font-medium">Note (optional)
          <textarea className={fieldClass} maxLength={2000} rows={3} value={draft.note}
            onChange={e => updateDraft({ note: e.target.value })} />
        </label>
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" required checked={draft.confirmed} className="mt-0.5"
            onChange={e => updateDraft({ confirmed: e.target.checked })} />
          <span>I confirm that I sent this signed quotation to the recipient on the date and by the method recorded above. I understand Architrak will not send an email.</span>
        </label>
      </fieldset>
      {mutation.isError && <p role="alert" className="text-xs text-destructive">{mutation.error instanceof Error ? mutation.error.message : "Could not record delivery. Please try again."}</p>}
      {version !== expectedVersion && <p role="alert" className="text-xs text-destructive">The quotation details changed. Cancel and reopen a new record after reviewing the current quotation.</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" variant="outline" disabled={mutation.isPending} onClick={() => {
          setOpen(false);
          // Preserve a failed or uncertain request and its draft for safe retry.
          if (!mutation.isError) setIdentity("");
        }}>Cancel</Button>
        <Button type="submit" size="sm" disabled={mutation.isPending || !canRecord || !expectedVersion || version !== expectedVersion || !draft.confirmed || !draft.recipient.trim() || !draft.sentOn || draft.sentOn > today()}>
          {mutation.isPending ? "Recording…" : "Record delivery — no email"}
        </Button>
      </div>
    </form>}
    {deliveries.length > 0 && <div className="space-y-2" data-testid={`contractor-copy-external-history-${devisId}`}>
      <p className="text-xs font-semibold text-muted-foreground">Manually recorded deliveries</p>
      {deliveries.map(delivery => <div key={delivery.id} className="rounded border border-border bg-muted/20 px-2.5 py-2 text-xs">
        <div className="flex flex-wrap gap-x-2">
          <span className="font-medium">Recorded manually · {methods[delivery.method] ?? delivery.method}</span>
          <span>{delivery.sentOn}</span>
          <span className="text-muted-foreground">{delivery.currentDocument ? "Current signed document" : "Previous document / signature record"}</span>
        </div>
        <p className="break-words">{delivery.recipient}</p>
        {delivery.note && <p className="whitespace-pre-wrap break-words text-muted-foreground">{delivery.note}</p>}
        <p className="mt-0.5 text-muted-foreground">Operator recorded; does not confirm receipt.</p>
      </div>)}
    </div>}
  </div>;
}
