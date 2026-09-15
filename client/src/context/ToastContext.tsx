import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

export type ToastVariant = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  durationMs: number;
}

export interface ToastContextValue {
  toast: (
    input: Omit<Toast, "id" | "variant" | "durationMs"> & {
      variant?: ToastVariant;
      durationMs?: number;
    },
  ) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_STYLES: Record<ToastVariant, { wrapper: string; icon: ReactNode }> = {
  success: {
    wrapper: "border-brand-500/40 bg-brand-500/10 text-brand-300",
    icon: <CheckCircle2 className="size-5 text-brand-400" aria-hidden />,
  },
  error: {
    wrapper: "border-danger/40 bg-danger/10 text-red-200",
    icon: <XCircle className="size-5 text-danger" aria-hidden />,
  },
  warning: {
    wrapper: "border-warning/40 bg-warning/10 text-amber-200",
    icon: <AlertTriangle className="size-5 text-warning" aria-hidden />,
  },
  info: {
    wrapper: "border-white/20 bg-white/5 text-white/90",
    icon: <Info className="size-5 text-white/70" aria-hidden />,
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback<ToastContextValue["toast"]>(
    ({ title, description, variant = "info", durationMs = 5000 }) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((current) => [...current.slice(-3), { id, title, description, variant, durationMs }]);
      if (durationMs > 0) {
        timers.current.set(
          id,
          window.setTimeout(() => dismiss(id), durationMs),
        );
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) window.clearTimeout(timer);
      map.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
        role="region"
        aria-label="Notifications"
      >
        <AnimatePresence initial={false}>
          {toasts.map((item) => (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ duration: 0.18 }}
              className={cn(
                "pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border p-4 shadow-2xl backdrop-blur",
                VARIANT_STYLES[item.variant].wrapper,
              )}
              role="status"
              aria-live="polite"
            >
              <span className="mt-0.5 shrink-0">{VARIANT_STYLES[item.variant].icon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{item.title}</p>
                {item.description ? <p className="mt-0.5 text-sm text-white/70">{item.description}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="rounded p-1 text-white/50 transition hover:bg-white/10 hover:text-white"
                aria-label="Dismiss notification"
              >
                <X className="size-4" aria-hidden />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside <ToastProvider>");
  return context;
}
