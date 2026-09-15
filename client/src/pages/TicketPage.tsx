import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useTranslation } from "react-i18next";
import { CalendarClock, Download, Mail, MapPin, Printer, Ticket as TicketIcon, Users } from "lucide-react";
import type { Booking } from "@shared/types";
import { CANCELLATION_CUTOFF_MINUTES } from "@shared/pricing";
import { bookingsApi } from "@/api/endpoints";
import { queryKeys } from "@/api/queryKeys";
import { useToast } from "@/context/ToastContext";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { formatDuration, formatShowDateTime, localizeHall, movieText } from "@/lib/localize";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { translateApiError } from "@/lib/errors";
import { track } from "@/lib/analytics";
import { downloadTicketPng } from "@/lib/downloadTicket";
import { posterFor } from "@/lib/posters";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Alert, ErrorState, Skeleton } from "@/components/ui/Feedback";
import { Modal } from "@/components/ui/Modal";
import { TicketQr } from "@/components/cinema/TicketQr";

export default function TicketPage() {
  const { t } = useTranslation();
  const { locale, money } = useAppConfig();
  const { bookingId = "" } = useParams<{ bookingId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const query = useQuery({
    queryKey: queryKeys.booking(bookingId),
    queryFn: () => bookingsApi.get(bookingId),
    enabled: bookingId.length > 0,
    retry: false,
    // Payment status changes server-side, so never serve a cached booking.
    staleTime: 0,
    refetchOnMount: "always",
  });

  useDocumentTitle(
    query.data?.booking ? `${t("ticket.title")} ${query.data.booking.code}` : t("ticket.title"),
  );

  const cancelMutation = useMutation({
    mutationFn: () => bookingsApi.refund(bookingId),
    onSuccess: (data) => {
      setConfirmCancel(false);
      track("refund", { booking_id: bookingId, automatic: data.refunded });
      toast({
        title: t("ticket.cancelSuccess"),
        description: data.refunded
          ? t("ticket.cancelSuccessDescription")
          : t("ticket.refundManualDescription"),
        variant: data.refunded ? "success" : "warning",
      });
      void queryClient.invalidateQueries({ queryKey: ["bookings"] });
      void query.refetch();
    },
    onError: (error: unknown) => {
      toast({
        title: t("ticket.cancelFailed"),
        description: translateApiError(error, t),
        variant: "error",
      });
    },
  });

  const receiptMutation = useMutation({
    mutationFn: () => bookingsApi.receipt(bookingId),
    onSuccess: () => {
      toast({
        title: t("ticket.receiptSent"),
        description: t("ticket.receiptSentDescription"),
        variant: "success",
      });
    },
    onError: (error: unknown) => {
      toast({
        title: t("ticket.receiptFailed"),
        description: translateApiError(error, t),
        variant: "error",
      });
    },
  });

  const handleDownload = async (booking: Booking) => {
    setDownloading(true);
    try {
      const qrDataUrl = await QRCode.toDataURL(booking.code, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 300,
        color: { dark: "#07090B", light: "#FFFFFF" },
      });
      await downloadTicketPng({
        code: booking.code,
        movieTitle: movieText(booking.movie, locale).title,
        theaterName: booking.theaterName,
        theaterAddress: booking.theaterAddress,
        hall: localizeHall(booking.hall, t),
        startsAt: booking.startsAt,
        seats: booking.seats.map((seat) => seat.label),
        totalLabel: money(booking.quote.totalCents),
        locale,
        timeZone: booking.timeZone,
        labels: {
          admit: `${t("ticket.admit", { count: booking.seats.length })} · e-ticket`,
          seats: t("ticket.seats"),
          reference: t("ticket.reference"),
          total: t("success.paid"),
        },
        qrDataUrl,
      });
    } catch {
      toast({
        title: t("ticket.downloadFailed"),
        description: t("common.tryAgainLater"),
        variant: "error",
      });
    } finally {
      setDownloading(false);
    }
  };

  if (query.isPending) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-12 sm:px-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6">
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          title={t("ticket.notAvailable")}
        />
      </div>
    );
  }

  const booking = query.data.booking;
  const poster = posterFor(booking.movie.slug, booking.movie.posterUrl);
  const minutesToShow = (new Date(booking.startsAt).getTime() - Date.now()) / 60_000;
  const canCancel = booking.status === "confirmed" && minutesToShow > CANCELLATION_CUTOFF_MINUTES;
  const isPast = new Date(booking.startsAt).getTime() < Date.now();
  const title = movieText(booking.movie, locale).title;
  const hall = localizeHall(booking.hall, t);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">{t("ticket.title")}</h1>
          <p className="mt-1 text-sm text-white/55">
            {t("ticket.reference")} <span className="font-mono text-white/80">{booking.code}</span>
          </p>
        </div>
        <Badge
          tone={
            booking.status === "confirmed" ? "success" : booking.status === "pending" ? "warning" : "neutral"
          }
        >
          {t(`ticket.status.${booking.status}`)}
        </Badge>
      </header>

      {booking.status === "pending" ? (
        <Alert tone="warning" className="mb-6">
          {t("ticket.notPaid")}{" "}
          <button
            type="button"
            className="font-semibold underline underline-offset-4"
            onClick={() => navigate(`/checkout/${booking.id}`)}
          >
            {t("ticket.completePayment")}
          </button>
          .
        </Alert>
      ) : null}

      {booking.status === "cancelled" ? (
        <Alert tone="danger" className="mb-6">
          {t("ticket.cancelledNote")}
        </Alert>
      ) : null}

      {/* The ticket itself: also what gets printed. */}
      <section className="print-area overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-ink-800 to-ink-900">
        <div className="flex flex-col gap-6 p-6 sm:flex-row sm:p-7">
          {poster ? (
            <img
              src={poster}
              alt={t("movie.posterAlt", { title })}
              className="mx-auto w-28 rounded-xl sm:mx-0"
            />
          ) : null}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-white/55">
              <span className="uppercase tracking-[0.25em] text-brand-400">
                {t("ticket.admit", { count: booking.seats.length })}
              </span>
              {isPast ? <span>· {t("ticket.showEnded")}</span> : null}
            </div>
            <h2 className="mt-1 text-xl font-bold text-white sm:text-2xl">{title}</h2>
            <p className="mt-0.5 text-sm text-white/50">
              {formatDuration(booking.movie.durationMinutes, locale)} · {hall}
            </p>

            <dl className="mt-5 space-y-2 text-sm">
              <div className="flex items-start gap-2">
                <CalendarClock className="mt-0.5 size-4 shrink-0 text-white/40" aria-hidden />
                <dd className="text-white/85">
                  {formatShowDateTime(booking.startsAt, locale, booking.timeZone)}
                </dd>
              </div>
              <div className="flex items-start gap-2">
                <MapPin className="mt-0.5 size-4 shrink-0 text-white/40" aria-hidden />
                <dd className="text-white/85">
                  {booking.theaterName}
                  <span className="block text-xs text-white/55">{booking.theaterAddress}</span>
                </dd>
              </div>
              <div className="flex items-start gap-2">
                <Users className="mt-0.5 size-4 shrink-0 text-white/40" aria-hidden />
                <dd className="text-white/85">
                  {t("ticket.seats")} {booking.seats.map((seat) => seat.label).join(", ")}
                </dd>
              </div>
              <div className="flex items-start gap-2">
                <TicketIcon className="mt-0.5 size-4 shrink-0 text-white/40" aria-hidden />
                <dd className="text-white/85">
                  {t("ticket.paid")} {money(booking.quote.totalCents)}
                  {booking.payment ? (
                    <span className="block text-xs text-white/55">
                      {t("ticket.paidWith", {
                        method:
                          booking.payment.method === "paypal"
                            ? "PayPal"
                            : `${t(`payment.brands.${booking.payment.brand ?? "unknown"}`)}${
                                booking.payment.last4 ? ` •••• ${booking.payment.last4}` : ""
                              }`,
                      })}
                      {booking.payment.phoneMasked
                        ? ` · ${t("ticket.codeSentTo", { phone: booking.payment.phoneMasked })}`
                        : ""}
                    </span>
                  ) : null}
                </dd>
              </div>
            </dl>
          </div>

          {booking.status === "confirmed" ? (
            <div className="flex flex-col items-center justify-center gap-2">
              <TicketQr value={booking.code} size={148} />
              <p className="text-center text-[11px] text-white/55">{t("ticket.scanNote")}</p>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-dashed border-white/15 bg-black/20 px-6 py-4">
          <p className="text-xs text-white/55">{t("ticket.arriveNote")}</p>
          <p className="font-mono text-sm tracking-widest text-white/70">{booking.code}</p>
        </div>
      </section>

      <div className="no-print mt-6 flex flex-wrap gap-3">
        {booking.status === "confirmed" ? (
          <>
            <Button
              onClick={() => void handleDownload(booking)}
              loading={downloading}
              leftIcon={<Download className="size-4" aria-hidden />}
            >
              {t("ticket.download")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => window.print()}
              leftIcon={<Printer className="size-4" aria-hidden />}
            >
              {t("ticket.print")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => receiptMutation.mutate()}
              loading={receiptMutation.isPending}
              leftIcon={<Mail className="size-4" aria-hidden />}
            >
              {t("ticket.receipt")}
            </Button>
          </>
        ) : null}

        {canCancel ? (
          <Button
            variant="danger"
            onClick={() => setConfirmCancel(true)}
            loading={cancelMutation.isPending && confirmCancel}
          >
            {t("ticket.cancel")}
          </Button>
        ) : null}

        <ButtonLink to="/my-tickets" variant="ghost">
          {t("ticket.back")}
        </ButtonLink>
      </div>

      <Modal
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title={t("ticket.cancelTitle")}
        description={t("ticket.cancelDescription", {
          seats: booking.seats.map((seat) => seat.label).join(", "),
        })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
              {t("ticket.keepTickets")}
            </Button>
            <Button
              variant="danger"
              loading={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              {t("ticket.cancel")}
            </Button>
          </>
        }
      />
    </div>
  );
}
