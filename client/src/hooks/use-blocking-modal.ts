import { useEffect, useState } from "react";

/** Floating reference viewers yield to modal forms without losing their PDF. */
export function useBlockingModal() {
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const check = () => setBlocked(Array.from(document.querySelectorAll<HTMLElement>(
      '[role="dialog"][data-state="open"]:not([aria-modal="false"]), [role="alertdialog"][data-state="open"]',
    )).some(node => !node.closest('[hidden], [inert], [aria-hidden="true"]')));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ["data-state", "hidden", "aria-hidden", "inert", "role"],
    });
    return () => observer.disconnect();
  }, []);
  return blocked;
}
