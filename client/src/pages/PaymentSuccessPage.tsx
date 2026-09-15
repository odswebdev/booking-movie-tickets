import { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Check, Download, Home } from "lucide-react";
import { bookingsApi } from "@/api/endpoints";
import { queryKeys } from "@/api/queryKeys";
import { useBookingFlow } from "@/context/BookingFlowContext";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { formatShowDateTime, localizeHall, movieText } from "@/lib/localize";
import { track } from "@/lib/analytics";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { ButtonLink } from "@/components/ui/Button";
import { ErrorState, Skeleton } from "@/components/ui/Feedback";

export default function PaymentSuccessPage() {
  const { t } = useTranslation();
  const { locale, money } = useAppConfig();
  const { bookingId = "" } = useParams<{ bookingId: string }>();
  const { reset } = useBookingFlow();

  useDocumentTitle(t("success.title"));

  // The flow is finished: drop the draft so a new booking starts clean.
  useEffect(() => {
    reset();
  }, [reset]);

  const query = useQuery({
    queryKey: queryKeys.booking(bookingId),
    queryFn: () => bookingsApi.get(bookingId),
    enabled: bookingId.length > 0,
    retry: false,
    // Payment status changes server-side, so never serve a cached booking.
    staleTime: 0,
    refetchOnMount: "always",
  });

  const purchaseTracked = useRef(false);
  useEffect(() => {
    const confirmed = query.data?.booking;
    if (!confirmed || confirmed.status !== "confirmed" || purchaseTracked.current) return;
    purchaseTracked.current = true;
    track("purchase", {
      booking_id: confirmed.id,
      value: confirmed.quote.totalCents / 100,
      currency: confirmed.quote.currency,
      items: confirmed.seats.length,
    });
  }, [query.data]);

  if (query.isPending) {
    return (
      <div className="mx-auto w-full max-w-md space-y-4 px-4 py-16 sm:px-6">
        <Skeleton className="mx-auto size-28 rounded-full" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 rounded-2xl" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} title={t("success.loadError")} />
      </div>
    );
  }

  const booking = query.data.booking;

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12 sm:px-6">
      <div className="text-center">
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 220, damping: 18 }}
          className="mx-auto flex size-28 items-center justify-center rounded-full bg-brand-500/20"
        >
          <div className="flex size-20 items-center justify-center rounded-full bg-brand-500">
            <Check className="size-10 text-ink-950" strokeWidth={3} aria-hidden />
          </div>
        </motion.div>

        <h1 className="mt-6 text-2xl font-bold text-white">{t("success.title")}</h1>
        <p className="mt-2 text-sm text-white/60">{t("success.subtitle")}</p>
      </div>

      <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-white/50">{t("success.movie")}</dt>
            <dd className="text-right font-medium text-white">{movieText(booking.movie, locale).title}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-white/50">{t("success.showtime")}</dt>
            <dd className="text-right text-white/85">
              {formatShowDateTime(booking.startsAt, locale, booking.timeZone)}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-white/50">{t("success.cinema")}</dt>
            <dd className="text-right text-white/85">
              {booking.theaterName} · {localizeHall(booking.hall, t)}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-white/50">{t("ticket.seats")}</dt>
            <dd className="text-right text-white/85">{booking.seats.map((seat) => seat.label).join(", ")}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-white/50">{t("success.reference")}</dt>
            <dd className="font-mono text-right text-white/85">{booking.code}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-white/10 pt-3">
            <dt className="text-white/50">{t("success.paid")}</dt>
            <dd className="text-right font-semibold text-brand-400">{money(booking.quote.totalCents)}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-6 flex flex-col gap-3">
        <ButtonLink
          to={`/tickets/${booking.id}`}
          size="lg"
          fullWidth
          leftIcon={<Download className="size-4" aria-hidden />}
        >
          {t("success.viewTicket")}
        </ButtonLink>
        <ButtonLink
          to="/"
          variant="secondary"
          size="lg"
          fullWidth
          leftIcon={<Home className="size-4" aria-hidden />}
        >
          {t("success.backHome")}
        </ButtonLink>
        <ButtonLink to="/my-tickets" variant="ghost" size="sm" className="mx-auto mt-1">
          {t("success.allTickets")}
        </ButtonLink>
      </div>
    </div>
  );
}
