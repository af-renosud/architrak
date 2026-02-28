import { AppLayout } from "@/components/layout/AppLayout";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <AppLayout>
      <div className="flex items-center justify-center py-20">
        <LuxuryCard className="max-w-md w-full text-center" data-testid="card-not-found">
          <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground mb-2" data-testid="text-404-title">
            404
          </h1>
          <p className="text-[14px] font-black uppercase tracking-tight text-foreground mb-2">
            Page Not Found
          </p>
          <p className="text-[12px] text-muted-foreground mb-6">
            The page you are looking for does not exist or has been moved.
          </p>
          <Link href="/">
            <Button data-testid="button-back-home">
              <ArrowLeft size={14} />
              <span className="text-[9px] font-bold uppercase tracking-widest">Back to Dashboard</span>
            </Button>
          </Link>
        </LuxuryCard>
      </div>
    </AppLayout>
  );
}
