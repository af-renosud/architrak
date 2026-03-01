import logoPath from "@assets/Generated_Image_February_28__2026_-_3_59PM.jpg-removebg-previe_1772291017667.png";
import { Building2, Shield } from "lucide-react";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen" data-testid="page-login">
      <div
        className="hidden lg:flex lg:w-1/2 flex-col justify-between p-12"
        style={{ backgroundColor: "#0B2545" }}
      >
        <div>
          <img
            src={logoPath}
            alt="ArchiTrak"
            className="h-24 w-auto object-contain brightness-0 invert"
            data-testid="img-login-logo"
          />
          <p
            className="text-[10px] font-black uppercase tracking-[0.3em] mt-2"
            style={{ color: "#c1a27b" }}
          >
            Financial Management
          </p>
        </div>

        <div>
          <h1
            className="text-4xl font-light leading-tight mb-6"
            style={{ fontFamily: "Inter, sans-serif", color: "#FFFFFF" }}
          >
            Architecture
            <br />
            <span style={{ color: "#c1a27b" }}>Financial</span>
            <br />
            Management
          </h1>
          <p className="text-sm leading-relaxed max-w-md" style={{ color: "#8B9DC3" }}>
            Full lifecycle financial tracking for French architectural practices.
            From Devis to Certificat de Paiement, with complete Honoraires management.
          </p>
        </div>

        <div className="flex items-center gap-3" style={{ color: "#5A6F8E" }}>
          <Building2 size={14} />
          <span className="text-xs uppercase tracking-wider">
            SAS Architects-France
          </span>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-8 bg-[#F8F9FA]">
        <div className="w-full max-w-sm text-center">
          <div className="lg:hidden mb-10">
            <img
              src={logoPath}
              alt="ArchiTrak"
              className="h-20 w-auto object-contain mx-auto"
            />
            <p
              className="text-[9px] font-black uppercase tracking-[0.3em] mt-1"
              style={{ color: "#c1a27b" }}
            >
              Financial Management
            </p>
          </div>

          <h2
            className="text-2xl font-light mb-2"
            style={{ color: "#0B2545", fontFamily: "Inter, sans-serif" }}
          >
            Welcome
          </h2>
          <p className="text-sm mb-8" style={{ color: "#7E7F83" }}>
            Sign in to access ArchiTrak
          </p>

          <a
            href="/api/auth/login"
            className="inline-flex items-center justify-center gap-3 w-full px-6 py-3 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90"
            style={{ backgroundColor: "#0B2545" }}
            data-testid="button-google-login"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Sign in with Google
          </a>

          <div className="mt-6 flex items-center justify-center gap-2" style={{ color: "#7E7F83" }}>
            <Shield size={12} />
            <span className="text-xs">
              Restricted to @renosud.com accounts
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
