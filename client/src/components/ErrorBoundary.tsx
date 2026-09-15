import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ButtonLink } from "@/components/ui/Button";

interface State {
  error: Error | null;
}

/**
 * Last line of defence: a rendering error anywhere below shows a recoverable
 * screen instead of the blank white page the original app produced.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // A real deployment would forward this to Sentry/Datadog.
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return <ErrorScreen error={error} onReset={this.reset} />;
  }
}

/** Split out so the class component can use the i18n hook. */
function ErrorScreen({ error, onReset }: { error: Error; onReset: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-16">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-ink-800 p-8 text-center">
        <h1 className="text-2xl font-semibold text-white">{t("errorBoundary.title")}</h1>
        <p className="mt-2 text-sm text-white/60">{t("errorBoundary.subtitle")}</p>
        <pre className="mt-4 max-h-32 overflow-auto rounded-lg bg-black/40 p-3 text-left text-xs text-white/50">
          {error.message}
        </pre>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={onReset}
            className="inline-flex h-11 items-center rounded-xl bg-brand-500 px-5 font-semibold text-ink-950 transition hover:bg-brand-400"
          >
            {t("errorBoundary.retry")}
          </button>
          <ButtonLink to="/" variant="secondary">
            {t("errorBoundary.home")}
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
