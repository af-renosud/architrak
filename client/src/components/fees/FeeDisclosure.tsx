import { useEffect, useRef, type ReactNode } from "react";

export function FeeDisclosure({ collapseVersion, summary, children }: { collapseVersion: number; summary: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [collapseVersion]);
  return <details ref={ref} className="fee-register-disclosure rounded-lg border px-4">
    <summary>{summary}</summary>
    {children}
  </details>;
}
