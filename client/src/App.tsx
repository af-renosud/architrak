import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Projects from "@/pages/projects";
import ProjectDetail from "@/pages/project-detail";
import Contractors from "@/pages/contractors";
import ContractorDetail from "@/pages/contractor-detail";
import FinancialTracking from "@/pages/financial-tracking";
import CertificatsPage from "@/pages/certificats";
import Fees from "@/pages/fees";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/projets" component={Projects} />
      <Route path="/projets/:id" component={ProjectDetail} />
      <Route path="/entreprises" component={Contractors} />
      <Route path="/entreprises/:id" component={ContractorDetail} />
      <Route path="/suivi-financier" component={FinancialTracking} />
      <Route path="/certificats" component={CertificatsPage} />
      <Route path="/honoraires" component={Fees} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
