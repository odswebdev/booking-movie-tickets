import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "@/App";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthProvider } from "@/context/AuthContext";
import { BookingFlowProvider } from "@/context/BookingFlowContext";
import { ToastProvider } from "@/context/ToastContext";
import { AppConfigProvider } from "@/i18n/AppConfigProvider";
import i18n from "@/i18n";
import { bootstrapLocale, localeBase } from "@/lib/localeRouting";
import "@/i18n";
import "@/styles/index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Unable to mount: #root element is missing from index.html");
}

// ТЗ §9b: every route lives under a locale prefix (`/en/...`, `/ru/...`).
// Bootstrapping rewrites a bare URL in place, then the router mounts with the
// matching basename so all links keep the prefix automatically.
const activeLocale = bootstrapLocale();
void i18n.changeLanguage(activeLocale);
if (typeof document !== "undefined") document.documentElement.lang = activeLocale;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      // Never auto-retry writes: a double booking is worse than a failed one.
      retry: 0,
    },
  },
});

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={localeBase(activeLocale)}>
          <ToastProvider>
            <AuthProvider>
              <AppConfigProvider>
                <BookingFlowProvider>
                  <App />
                </BookingFlowProvider>
              </AppConfigProvider>
            </AuthProvider>
          </ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
