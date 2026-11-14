import { useCallback, useEffect, useRef, useState } from "react";
import { Menu, PanelLeftOpen } from "lucide-react";
import { useLocation } from "wouter";
import { Sidebar } from "./Sidebar";
import { cn } from "@/lib/utils";

const SIDEBAR_PREFERENCE_KEY = "architrak:desktop-sidebar-collapsed";

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const [location] = useLocation();
  const isProjectPage = /^\/projets\/[^/]+(?:\/|$)/.test(location);
  const [desktopCollapsed, setDesktopCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileMode, setMobileMode] = useState(
    () => typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(max-width: 1023px)").matches,
  );
  const mobileNavTriggerRef = useRef<HTMLButtonElement>(null);
  const showMenuRef = useRef<HTMLButtonElement>(null);
  const collapseMenuRef = useRef<HTMLButtonElement>(null);
  const pendingDesktopFocus = useRef(false);

  const toggleDesktopNav = () => {
    pendingDesktopFocus.current = true;
    setDesktopCollapsed((collapsed) => !collapsed);
  };

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_PREFERENCE_KEY, String(desktopCollapsed));
    } catch {
      // Private browsing or blocked storage must not prevent navigation.
    }
  }, [desktopCollapsed]);

  useEffect(() => {
    if (!mobileMode && pendingDesktopFocus.current) {
      (desktopCollapsed ? showMenuRef : collapseMenuRef).current?.focus();
    } else if (document.getElementById("app-sidebar")?.contains(document.activeElement)) {
      if (mobileMode && !mobileNavOpen) mobileNavTriggerRef.current?.focus();
      if (!mobileMode && desktopCollapsed) showMenuRef.current?.focus();
      if (!mobileMode && document.activeElement?.getAttribute("data-testid") === "button-mobile-nav-close") {
        collapseMenuRef.current?.focus();
      }
    } else if (mobileMode && document.activeElement === showMenuRef.current) {
      mobileNavTriggerRef.current?.focus();
    }
    pendingDesktopFocus.current = false;
  }, [desktopCollapsed, mobileMode, mobileNavOpen]);

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
        desktopCollapsed={desktopCollapsed}
        onDesktopCollapse={toggleDesktopNav}
        collapseMenuRef={collapseMenuRef}
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
      <main data-scroll-navigation-scope="" className={cn("ml-0 min-w-0 flex-1 overflow-x-hidden", !desktopCollapsed && "lg:ml-64")}>
        <div hidden={!desktopCollapsed || mobileMode} className={cn("sticky top-0 z-30 border-b border-border bg-background px-8 py-2", desktopCollapsed ? "hidden lg:block" : "hidden")}>
          <button
            ref={showMenuRef}
            type="button"
            aria-label="Show menu"
            title="Show menu"
            aria-controls="app-sidebar"
            aria-expanded={false}
            onClick={toggleDesktopNav}
            className="inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PanelLeftOpen size={16} aria-hidden="true" />
            Show menu
          </button>
        </div>
        <div className={cn("mx-auto p-4 pt-16 sm:p-6 sm:pt-16 lg:p-8", !isProjectPage && "max-w-[1600px]")}>
          {children}
        </div>
      </main>
    </div>
  );
}
