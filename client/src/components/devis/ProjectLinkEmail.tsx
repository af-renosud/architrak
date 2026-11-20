import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";

type Delivery = {id:number; status:string; recipient:string; createdAt:string; sentAt:string|null; body:string; tokenId:number};
export function ProjectLinkEmail({projectId, token, enabled}: {
  projectId:string; token:{id:number; clientEmail:string; clientName?:string|null}|null; enabled:boolean;
}) {
  const [open,setOpen] = useState(false);
  const [requestId,setRequestId] = useState("");
  const [message,setMessage] = useState("Please use the link below to view the quotations and latest cost information shared with you for your project.");
  const [feedback,setFeedback] = useState("");
  const history = useQuery<Delivery[]>({
    queryKey:[`/api/projects/${projectId}/client-share/emails`],
    queryFn: async () => (await apiRequest("GET", `/api/projects/${projectId}/client-share/emails`)).json(),
    enabled:open,
    refetchInterval:open ? 10000 : false,
  });
  const pending = history.data?.find(d=>d.tokenId===token?.id && ["failed","queued","sending"].includes(d.status));
  const send = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/projects/${projectId}/client-share/email`, {
      tokenId:token?.id, requestId, message,
    })).json(),
    onSuccess: result => {
      setFeedback(result.status === "sent" ? "Email sent — accepted by the email provider. This does not confirm that the client has read it." : result.message || "Delivery confirmation pending.");
      if(result.status === "sent") setRequestId("");
      void history.refetch();
    },
    onError:(error:Error)=>{setFeedback(error.message);void history.refetch();},
  });
  return <>
    <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1" disabled={!enabled} onClick={()=>{
      setRequestId(crypto.randomUUID());setFeedback("");setOpen(true);
    }} data-testid="button-email-project-link"><Mail size={12}/>Email client</Button>
    <Dialog open={open} onOpenChange={value=>{if(!send.isPending)setOpen(value);}}>
      <DialogContent>
        <DialogHeader><DialogTitle>Email project link</DialogTitle>
          <DialogDescription>Review before sending. This sends the existing link without changing its expiry or the quotations shared.</DialogDescription>
        </DialogHeader>
        <div><strong>To:</strong> {token?.clientName} &lt;{token?.clientEmail}&gt;</div>
        <p className="text-sm text-slate-500">The recipient is the person this link was issued to. To change them, close this window and use Rotate link.</p>
        {pending ? <div className="text-sm space-y-2">
          <p>A saved email is {pending.status}. Retry sends that same message, not a new copy.</p>
          <pre className="whitespace-pre-wrap max-h-48 overflow-auto rounded border p-2">{pending.body}</pre>
        </div> : <label className="text-sm">Message
          <Textarea value={message} onChange={e=>setMessage(e.target.value)} maxLength={5000} rows={5} disabled={send.isPending || !requestId}/>
        </label>}
        <p className="text-xs text-slate-500">A greeting, the secure project link and the Renosud sign-off are added automatically.</p>
        {feedback && <p role="status" className="text-sm">{feedback}</p>}
        {history.isError && <p role="alert">Could not load delivery history. Close and reopen before sending.</p>}
        <Button disabled={!enabled || !requestId || history.isLoading || history.isError || send.isPending || message.trim().length<10}
          onClick={()=>send.mutate()}>
          {send.isPending ? "Sending…" : pending ? (pending.status==="sending" ? "Check delivery status" : "Retry saved email") : "Send email"}
        </Button>
        <details><summary className="cursor-pointer text-sm">Email delivery history</summary>
          <div className="max-h-40 overflow-auto text-xs space-y-2 mt-2">
            {history.data?.length === 0 && <p>No project-link emails recorded.</p>}
            {history.data?.map(d=><div key={d.id}>{d.status} · {d.recipient} · {new Date(d.sentAt || d.createdAt).toLocaleString("en-GB")}</div>)}
          </div>
        </details>
      </DialogContent>
    </Dialog>
  </>;
}
