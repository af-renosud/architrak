import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Send } from "lucide-react";

const CONTEXT_EMAIL_DEDUPE_PREFIX = "devis-signature-context:";

/**
 * A `devis_signature_context` communication row carries no explicit devis
 * foreign key — the devis id is encoded in its dedupe key
 * (`devis-signature-context:{devisId}:{envelopeId}`). Parse it back out so
 * the communications log can offer the Task #258 resend action inline.
 */
export function parseDevisIdFromContextEmailDedupeKey(
  dedupeKey: string | null | undefined,
): number | null {
  if (!dedupeKey || !dedupeKey.startsWith(CONTEXT_EMAIL_DEDUPE_PREFIX)) return null;
  const match = /^devis-signature-context:(\d+):/.exec(dedupeKey);
  if (!match) return null;
  const devisId = Number(match[1]);
  return Number.isInteger(devisId) && devisId > 0 ? devisId : null;
}

interface ContextEmailResendButtonProps {
  devisId: number;
  communicationId: number;
  projectId?: number;
}

/**
 * Inline resend action for a failed/queued devis-signature context email,
 * shown in the communications log (Task #261). Reuses the Task #258
 * endpoints: visibility is gated on GET /api/devis/:id/context-email-status
 * (only offered when the CURRENT envelope's context email was never
 * successfully sent), and the resend itself POSTs
 * /api/devis/:id/resend-context-email — idempotent per (devis, envelope)
 * dedupe key, so it can never double-send.
 */
export function ContextEmailResendButton({
  devisId,
  communicationId,
  projectId,
}: ContextEmailResendButtonProps) {
  const { toast } = useToast();

  const statusQuery = useQuery<{
    canResend: boolean;
    emailStatus: string | null;
    reason: string | null;
  }>({
    queryKey: ["/api/devis", devisId, "context-email-status"],
  });

  const invalidateAfterResend = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "context-email-status"] });
    queryClient.invalidateQueries({ queryKey: ["/api/communications"] });
    if (projectId) {
      // Project-detail keys its communications query on the *string* route
      // param, the communications hub uses numeric ids — invalidate both.
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "communications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId), "communications"] });
    }
  };

  const resendMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/devis/${devisId}/resend-context-email`, {});
      return res.json() as Promise<{
        contextEmail?: { status?: "sent" | "failed" | "already_sent" };
      }>;
    },
    onSuccess: (data) => {
      toast({
        title:
          data?.contextEmail?.status === "already_sent"
            ? "Context email already sent"
            : "Context email sent",
        description:
          data?.contextEmail?.status === "already_sent"
            ? "The client has already received the accompanying email for this envelope."
            : "The accompanying email has been sent to the client.",
      });
      invalidateAfterResend();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to resend the context email",
        description: error.message,
        variant: "destructive",
      });
      invalidateAfterResend();
    },
  });

  if (!statusQuery.data?.canResend) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 text-xs"
      onClick={(e) => {
        e.stopPropagation();
        resendMutation.mutate();
      }}
      disabled={resendMutation.isPending}
      data-testid={`button-resend-context-email-comm-${communicationId}`}
    >
      {resendMutation.isPending ? (
        <>
          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          Sending…
        </>
      ) : (
        <>
          <Send size={12} className="mr-1" />
          Resend context email
        </>
      )}
    </Button>
  );
}
