import { useCallback, useEffect, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { Sidebar } from "./Sidebar";

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileMode, setMobileMode] = useState(
    () => typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(max-width: 1023px)").matches,
  );
  const mobileNavTriggerRef = useRef<HTMLButtonElement>(null);

  const closeMobileNav = useCallback(() => {
    setMobileNavOpen(false);
    window.requestAnimationFrame(() => mobileNavTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 1023px)");
    const syncMode = (matches: boolean) => {
      setMobileMode(matches);
      if (!matches) setMobileNavOpen(false);
    };
    syncMode(media.matches);
    const listener = (event: MediaQueryListEvent) => syncMode(event.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  return (
    <div className="flex min-h-screen min-w-0 bg-background">
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-40 bg-black/30 lg:hidden"
          onClick={closeMobileNav}
          data-testid="mobile-nav-backdrop"
        />
      )}
      <Sidebar
        mobileMode={mobileMode}
        mobileOpen={mobileNavOpen}
        onMobileClose={closeMobileNav}
      />
      <button
        ref={mobileNavTriggerRef}
        type="button"
        aria-label="Open navigation"
        aria-controls="app-sidebar"
        aria-expanded={mobileNavOpen}
        className="fixed left-3 top-3 z-30 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background/95 shadow-sm backdrop-blur lg:hidden"
        onClick={() => setMobileNavOpen(true)}
        data-testid="button-mobile-nav"
      >
        <Menu size={18} />
      </button>
      <main className="ml-0 min-w-0 flex-1 overflow-x-hidden lg:ml-64">
        <div className="mx-auto max-w-[1600px] p-4 pt-16 sm:p-6 sm:pt-16 lg:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
