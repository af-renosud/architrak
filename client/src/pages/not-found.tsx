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
            Page Introuvable
          </p>
          <p className="text-[12px] text-muted-foreground mb-6">
            La page que vous recherchez n'existe pas ou a été déplacée.
          </p>
          <Link href="/">
            <Button data-testid="button-back-home">
              <ArrowLeft size={14} />
              <span className="text-[9px] font-bold uppercase tracking-widest">Retour au tableau de bord</span>
            </Button>
          </Link>
        </LuxuryCard>
      </div>
    </AppLayout>
  );
}
