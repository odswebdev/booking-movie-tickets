import { useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { LayoutGrid, LogIn, LogOut, MapPin, Ticket, UserPlus } from "lucide-react";
import { logoUrl } from "@/lib/posters";
import { cn } from "@/lib/cn";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Feedback";

const NAV_LINK =
  "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white/70 transition hover:bg-white/10 hover:text-white";
const NAV_LINK_ACTIVE = "bg-white/10 text-white";

export function Header() {
  const { t } = useTranslation();
  const { user, status, logout } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [signingOut, setSigningOut] = useState(false);

  const handleLogout = async () => {
    setSigningOut(true);
    try {
      await logout();
      toast({ title: t("auth.signedOut"), description: t("auth.signedOutDescription"), variant: "success" });
      navigate("/", { replace: true });
    } catch {
      toast({ title: t("auth.signOutFailed"), description: t("common.retry"), variant: "error" });
    } finally {
      setSigningOut(false);
    }
  };

  return (
    // z-50 keeps the language menu above the page content below it.
    <header className="relative z-50 border-b border-white/5 bg-ink-900/60 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link to="/" className="flex items-center gap-2" aria-label="CineTickets home">
          <img src={logoUrl} alt={t("common.appName")} className="h-8 w-auto" width={127} height={49} />
        </Link>

        <nav className="order-3 flex w-full items-center gap-1 sm:order-2 sm:w-auto" aria-label="Main">
          <NavLink to="/" end className={({ isActive }) => cn(NAV_LINK, isActive && NAV_LINK_ACTIVE)}>
            <LayoutGrid className="size-4" aria-hidden />
            {t("nav.home")}
          </NavLink>
          <NavLink to="/cinemas" className={({ isActive }) => cn(NAV_LINK, isActive && NAV_LINK_ACTIVE)}>
            <MapPin className="size-4" aria-hidden />
            {t("nav.cinemas")}
          </NavLink>
          {status === "authenticated" ? (
            <NavLink to="/my-tickets" className={({ isActive }) => cn(NAV_LINK, isActive && NAV_LINK_ACTIVE)}>
              <Ticket className="size-4" aria-hidden />
              {t("nav.myTickets")}
            </NavLink>
          ) : null}
        </nav>

        <div className="order-2 flex items-center gap-2 sm:order-3">
          <LanguageSwitcher />
          {status === "loading" ? (
            <Spinner label={t("auth.sessionChecking")} />
          ) : status === "authenticated" && user ? (
            <>
              <Link
                to="/account"
                className="hidden max-w-[10rem] truncate text-sm text-white/60 underline-offset-4 hover:text-white hover:underline sm:inline"
                title={user.email}
              >
                {user.name}
              </Link>
              <Button
                variant="danger"
                size="sm"
                onClick={() => void handleLogout()}
                loading={signingOut}
                leftIcon={<LogOut className="size-4" aria-hidden />}
              >
                {t("nav.logout")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate("/login", { state: { from: location.pathname } })}
                leftIcon={<LogIn className="size-4" aria-hidden />}
              >
                {t("nav.login")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => navigate("/register", { state: { from: location.pathname } })}
                leftIcon={<UserPlus className="size-4" aria-hidden />}
              >
                {t("nav.register")}
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
