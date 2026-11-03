import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Project } from "@shared/schema";
import { apiRequest, projectScopedKey, queryClient } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Kept mounted beside project tabs so navigating here never tears down quotation drafts. */
export function ProjectContactEditor({ project, isArchived }: { project: Project; isArchived: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const save = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("PATCH", `/api/projects/${project.id}`, { clientContactName: name.trim(), clientContactEmail: email.trim() });
      return response.json() as Promise<Project>;
    },
    onSuccess: updated => {
      queryClient.setQueryData(projectScopedKey(String(project.id)), updated);
      void queryClient.invalidateQueries({ queryKey: projectScopedKey(String(project.id), "devis-readiness") });
      setOpen(false);
    },
  });
  useEffect(() => {
    const edit = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string | number }>).detail;
      if (String(detail?.projectId) !== String(project.id)) return;
      // Only initialise on an explicit open, never on a background project refetch.
      if (!open) { setName(project.clientContactName ?? ""); setEmail(project.clientContactEmail ?? ""); save.reset(); }
      setOpen(true);
    };
    window.addEventListener("architrak:edit-project-contact", edit);
    return () => window.removeEventListener("architrak:edit-project-contact", edit);
  }, [project.id, project.clientContactName, project.clientContactEmail, open]);
  return <Dialog open={open} onOpenChange={next => { if (!save.isPending) setOpen(next); }}>
    <DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>Client signing contact</DialogTitle><DialogDescription>Used for signing invitations and client correspondence. Changing the email revokes existing client review links.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (!isArchived && !save.isPending && name.trim() && email.trim()) save.mutate(); }}>
        <div className="space-y-1"><label htmlFor="project-signing-contact-name" className="text-xs font-semibold">Contact name</label><Input autoFocus id="project-signing-contact-name" required value={name} onChange={event => setName(event.target.value)} disabled={isArchived || save.isPending} /></div>
        <div className="space-y-1"><label htmlFor="project-signing-contact-email" className="text-xs font-semibold">Contact email</label><Input id="project-signing-contact-email" required type="email" value={email} onChange={event => setEmail(event.target.value)} disabled={isArchived || save.isPending} /></div>
        {isArchived && <p className="text-xs text-muted-foreground">This project is archived. Restore it before editing the contact.</p>}
        {save.isError && <p role="alert" className="text-xs text-destructive">{save.error.message} Your edits are preserved; retry saving.</p>}
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={save.isPending} onClick={() => setOpen(false)} type="button">Cancel</Button><Button type="submit" disabled={save.isPending || isArchived || !name.trim() || !email.trim()}>{save.isPending ? "Saving…" : "Save contact"}</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
