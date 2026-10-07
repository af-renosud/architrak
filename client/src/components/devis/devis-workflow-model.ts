export const workflowGroups = ["review", "prepare", "send", "after"] as const;
export type WorkflowGroup = typeof workflowGroups[number];
export type WorkflowChoices = Partial<Record<WorkflowGroup, boolean>>;

export function initialWorkflowGroup(stage?: string | null, status?: string | null): WorkflowGroup {
  if (status === "signed" || stage === "client_signed_off") return "after";
  if (stage === "sent_to_client") return "send";
  if (stage === "checked_internal" || stage === "approved_for_signing") return "prepare";
  return "review";
}

// Props may refresh while someone edits. Defaults are only a fallback for groups
// they have not chosen themselves, never a reset of explicit manual choices.
export function workflowIsOpen(group: WorkflowGroup, initial: WorkflowGroup, choices: WorkflowChoices): boolean {
  return choices[group] ?? group === initial;
}

export function workflowTarget(search: string): WorkflowGroup | null {
  const params = new URLSearchParams(search);
  if (params.get("check")) return "send";
  const group = params.get("group");
  return workflowGroups.includes(group as WorkflowGroup) ? group as WorkflowGroup : null;
}
