import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CalendarRange, History } from "lucide-react";
import type { Booking } from "@shared/types";
import { bookingsApi, type BookingScope } from "@/api/endpoints";
import { queryKeys } from "@/api/queryKeys";
import { useToast } from "@/context/ToastContext";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { cn } from "@/lib/cn";
import { TicketCard } from "@/components/cinema/TicketCard";
import { translateApiError } from "@/lib/errors";
import { track } from "@/lib/analytics";
import { movieText } from "@/lib/localize";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/Feedback";
import { Modal } from "@/components/ui/Modal";

const TABS: Array<{
  id: Exclude<BookingScope, "all">;
  labelKey: string;
  icon: typeof CalendarRange;
}> = [
  { id: "upcoming", labelKey: "myTickets.upcoming", icon: CalendarRange },
  { id: "history", labelKey: "myTickets.history", icon: History },
];

export default function MyTicketsPage() {
  const { t } = useTranslation();
  const { locale } = useAppConfig();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pendingCancel, setPendingCancel] = useState<Booking | null>(null);

  const tabParam = searchParams.get("tab");
  const scope: Exclude<BookingScope, "all"> = tabParam === "history" ? "history" : "upcoming";

  useDocumentTitle(t("myTickets.title"));

  const query = useQuery({
    queryKey: queryKeys.bookings(scope),
    queryFn: () => bookingsApi.list(scope),
  });

  const cancelMutation = useMutation({
    mutationFn: (bookingId: string) => bookingsApi.refund(bookingId),
    onSuccess: (data, refundedBookingId) => {
      setPendingCancel(null);
      track("refund", { booking_id: refundedBookingId, automatic: data.refunded });
      toast({
        title: t("ticket.cancelSuccess"),
        description: data.refunded
          ? t("ticket.cancelSuccessDescription")
          : t("ticket.refundManualDescription"),
        variant: data.refunded ? "success" : "warning",
      });
      void queryClient.invalidateQueries({ queryKey: ["bookings"] });
    },
    onError: (error: unknown) => {
      toast({
        title: t("ticket.cancelFailed"),
        description: translateApiError(error, t),
        variant: "error",
      });
    },
  });

  const items = query.data?.items ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-white sm:text-3xl">{t("myTickets.title")}</h1>
        <p className="mt-1.5 text-sm text-white/60">{t("myTickets.subtitle")}</p>
      </header>

      <div className="mb-6 inline-flex rounded-xl border border-white/10 bg-white/5 p-1" role="tablist">
        {TABS.map((tab) => {
          const isActive = tab.id === scope;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setSearchParams({ tab: tab.id }, { replace: true })}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition",
                isActive ? "bg-brand-500 text-ink-950" : "text-white/70 hover:text-white",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>

      {query.isPending ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-36 rounded-2xl" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          title={t("myTickets.loadError")}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={scope === "upcoming" ? t("myTickets.emptyUpcoming") : t("myTickets.emptyHistory")}
          description={
            scope === "upcoming"
              ? t("myTickets.emptyUpcomingDescription")
              : t("myTickets.emptyHistoryDescription")
          }
          action={<ButtonLink to="/">{t("myTickets.browse")}</ButtonLink>}
        />
      ) : (
        <div className="space-y-4">
          {items.map((booking) => (
            <TicketCard
              key={booking.id}
              booking={booking}
              cancelling={cancelMutation.isPending && pendingCancel?.id === booking.id}
              onCancel={(target) => setPendingCancel(target)}
            />
          ))}
        </div>
      )}

      <Modal
        open={pendingCancel !== null}
        onClose={() => setPendingCancel(null)}
        title={t("myTickets.cancelTitle")}
        description={
          pendingCancel
            ? t("myTickets.cancelDescription", {
                seats: pendingCancel.seats.map((seat) => seat.label).join(", "),
                movie: movieText(pendingCancel.movie, locale).title,
              })
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingCancel(null)}>
              {t("ticket.keepTickets")}
            </Button>
            <Button
              variant="danger"
              loading={cancelMutation.isPending}
              onClick={() => pendingCancel && cancelMutation.mutate(pendingCancel.id)}
            >
              {t("ticket.cancel")}
            </Button>
          </>
        }
      />
    </div>
  );
}
