import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";
import { AppConfigProvider } from "@/i18n/AppConfigProvider";

/**
 * Renders a component with the providers the app relies on (react-query, i18n
 * and the runtime config that supplies currencies). Queries are disabled by
 * default so tests never hit the network.
 */
export function renderWithProviders(ui: ReactElement, options?: { locale?: "en" | "ru" }) {
  if (options?.locale) void i18n.changeLanguage(options.locale);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <AppConfigProvider>{children}</AppConfigProvider>
        </I18nextProvider>
      </QueryClientProvider>
    );
  }

  return { queryClient, ...render(ui, { wrapper: Wrapper }) };
}
