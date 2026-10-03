import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MessageSquare, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ClientCheck, ClientCheckMessage, DevisLineItem } from "@shared/schema";

// Dates are JSON strings over the wire, rather than the schema's Date objects.
type Serialized<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };
export type ClientConversation = Serialized<ClientCheck> & {
  messages: Serialized<ClientCheckMessage>[];
};

function Timestamp({ value }: { value: string | null }) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return <time dateTime={value} className="text-muted-foreground">{date.toLocaleString()}</time>;
}

function ConversationThread({
  conversation,
  lineItems,
  isArchived,
}: {
  conversation: ClientConversation;
  lineItems: DevisLineItem[];
  isArchived: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [resolutionOpen, setResolutionOpen] = useState(false);
  const [resolutionNote, setResolutionNote] = useState("");
  const [feedback, setFeedback] = useState("");
  // Synchronous guard also protects against two clicks before React rerenders.
  const submitting = useRef(false);
  const readOnly = isArchived || conversation.status !== "open";
  const line = lineItems.find((item) => item.id === conversation.devisLineItemId);
  const mutation = useMutation({
    mutationFn: async (action: { type: "messages" | "resolve"; text: string }) => {
      await apiRequest("POST", `/api/client-checks/${conversation.id}/${action.type}`,
        action.type === "messages" ? { body: action.text } : { resolutionNote: action.text || undefined });
    },
    onSuccess: (_data, action) => {
      if (action.type === "messages") {
        setDraft("");
        setFeedback("Reply posted to the shared client portal.");
      } else {
        setResolutionOpen(false);
        setResolutionNote("");
        setFeedback("Conversation resolved.");
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/devis", conversation.devisId, "client-checks"] });
    },
    onSettled: () => { submitting.current = false; },
  });
  const submit = (type: "messages" | "resolve") => {
    if (readOnly || submitting.current) return;
    const text = (type === "messages" ? draft : resolutionNote).trim();
    if (type === "messages" && !text) return;
    submitting.current = true;
    setFeedback("");
    mutation.mutate({ type, text });
  };
  const statusClass = conversation.status === "open"
    ? "border-amber-200 bg-amber-50 text-amber-800"
    : conversation.status === "resolved"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : "border-slate-200 bg-slate-50 text-slate-600";

  return (
    <article className="rounded-lg border border-border bg-card p-3 space-y-3" aria-label={`Client question ${conversation.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] font-semibold text-muted-foreground">
          {line ? `Line ${line.lineNumber} · ${line.description}` : conversation.devisLineItemId ? "Referenced line no longer available" : "Quotation question"}
        </span>
        <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${statusClass}`}>
          {conversation.status}
        </span>
      </div>
      <div>
        <p className="text-[10px] text-muted-foreground mb-1">Original query · <Timestamp value={conversation.openedAt} /></p>
        <p className="text-[12px] font-medium whitespace-pre-wrap break-words">{conversation.queryText}</p>
      </div>
      {conversation.messages.length > 0 && (
        <ol className="space-y-2 border-l-2 border-[#c1a27b]/30 pl-3" aria-label="Message history">
          {[...conversation.messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).map((message) => (
            <li key={message.id} className={`rounded-md p-2 ${message.authorType === "architect" ? "bg-muted/40" : "bg-muted/15"}`}>
              <div className="flex flex-wrap gap-x-2 gap-y-1 text-[10px] mb-1">
                <span className="font-semibold">
                  {message.authorName || message.authorEmail || (message.authorType === "system" ? "System" : message.authorType === "architect" ? "Architect" : "Client")}
                </span>
                <span className="capitalize text-muted-foreground">{message.authorType}</span>
                <Timestamp value={message.createdAt} />
              </div>
              <p className="text-[11px] whitespace-pre-wrap break-words">{message.body}</p>
            </li>
          ))}
        </ol>
      )}
      {conversation.resolutionNote && (
        <p className="text-[11px] whitespace-pre-wrap break-words"><span className="font-semibold">Resolution: </span>{conversation.resolutionNote}</p>
      )}
      {readOnly ? (
        <p className="text-[10px] text-muted-foreground">
          {isArchived ? "Archived projects are read-only." : `This conversation is ${conversation.status} and read-only.`}
        </p>
      ) : (
        <div className="border-t border-border/60 pt-3 space-y-2">
          <label htmlFor={`client-reply-${conversation.id}`} className="block text-[11px] font-semibold">Reply to client</label>
          <Textarea
            id={`client-reply-${conversation.id}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={mutation.isPending}
            maxLength={5000}
            rows={3}
            className="text-[11px] resize-y"
            placeholder="Write a reply…"
          />
          <p className="text-[10px] text-muted-foreground">Your reply appears in the shared client portal. Sending a reply does not resolve the conversation.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="h-7 text-[10px] gap-1.5" disabled={!draft.trim() || mutation.isPending} onClick={() => submit("messages")}>
              <Send size={12} />{mutation.isPending && mutation.variables?.type === "messages" ? "Sending…" : "Send reply"}
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-[10px]" disabled={mutation.isPending} onClick={() => setResolutionOpen(!resolutionOpen)}>
              {resolutionOpen ? "Keep open" : "Resolve conversation"}
            </Button>
          </div>
          {resolutionOpen && (
            <div className="rounded-md bg-muted/30 p-2 space-y-2">
              <p className="text-[10px] text-muted-foreground">Resolving closes this conversation to further replies. Any unsent reply will not be posted.</p>
              <label htmlFor={`client-resolution-${conversation.id}`} className="block text-[11px] font-semibold">Resolution note (optional)</label>
              <Textarea id={`client-resolution-${conversation.id}`} value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} maxLength={2000} disabled={mutation.isPending} rows={2} className="text-[11px]" />
              <Button size="sm" className="h-7 text-[10px]" disabled={mutation.isPending} onClick={() => submit("resolve")}>
                {mutation.isPending && mutation.variables?.type === "resolve" ? "Resolving…" : "Confirm resolution"}
              </Button>
            </div>
          )}
        </div>
      )}
      {mutation.isError && <p role="alert" className="text-[11px] text-destructive">Could not {mutation.variables?.type === "messages" ? "send reply" : "resolve conversation"}: {mutation.error.message}. Your draft has been kept; try again.</p>}
      {feedback && <p role="status" className="text-[11px] text-muted-foreground">{feedback}</p>}
    </article>
  );
}

export function ClientConversationPanel({ devisId, lineItems, isArchived }: {
  devisId: number;
  lineItems: DevisLineItem[];
  isArchived: boolean;
}) {
  const { data: conversations = [], isLoading, isError, refetch, isFetching } = useQuery<ClientConversation[]>({
    queryKey: ["/api/devis", devisId, "client-checks"],
    refetchInterval: 15_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const openCount = conversations.filter((conversation) => conversation.status === "open").length;
  return (
    <section className="rounded-lg border border-slate-200 bg-card p-2.5 space-y-3" aria-labelledby={`client-conversations-${devisId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <MessageSquare size={14} className="text-[#0B2545]" />
        <h3 id={`client-conversations-${devisId}`} className="text-[12px] font-semibold text-slate-700">Client conversations</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]" aria-label={`${conversations.length} conversations, ${openCount} open`}>
          {isLoading ? "Loading…" : `${conversations.length} · ${openCount} open`}
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground">Questions and replies from the shared client portal. Automatically checks for new messages every 15 seconds.</p>
      {isLoading && <div aria-label="Loading client conversations" className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-24 w-full" /></div>}
      {isError && <div role="alert" className="rounded-md border border-destructive/20 p-3 text-[11px] space-y-2">
        <p>Could not refresh client conversations. {conversations.length > 0 ? "Showing previously loaded messages." : "Please try again."}</p>
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>Retry</Button>
      </div>}
      {!isLoading && !isError && conversations.length === 0 && (
        <div className="rounded-md border border-dashed border-border bg-muted/20 p-4">
          <p className="text-[11px] font-semibold">No client questions yet</p>
          <p className="text-[10px] text-muted-foreground mt-1">Questions posted through the client share link will appear here.</p>
        </div>
      )}
      {[...conversations].sort((a, b) => Number(b.status === "open") - Number(a.status === "open") || new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime()).map((conversation) => (
        <ConversationThread key={`${devisId}-${conversation.id}`} conversation={conversation} lineItems={lineItems} isArchived={isArchived} />
      ))}
    </section>
  );
}