import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, Clock, Tag, X } from "lucide-react";
import type { Booking } from "@shared/types";
import { bookingsApi } from "@/api/endpoints";
import { queryKeys } from "@/api/queryKeys";
import { ApiRequestError } from "@/api/http";
import { useToast } from "@/context/ToastContext";
import { useCountdown } from "@/hooks/useCountdown";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { formatCountdown, formatDuration, formatShowDateTime, localizeHall, movieText } from "@/lib/localize";
import { posterFor } from "@/lib/posters";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { translateApiError } from "@/lib/errors";
import { track } from "@/lib/analytics";
import { PriceSummary } from "@/components/cinema/PriceSummary";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert, ErrorState, Skeleton } from "@/components/ui/Feedback";

export default function CheckoutPage() {
  const { t } = useTranslation();
  const { locale, money } = useAppConfig();
  const { bookingId = "" } = useParams<{ bookingId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [promoCode, setPromoCode] = useState("");

  const bookingQuery = useQuery({
    queryKey: queryKeys.booking(bookingId),
    queryFn: () => bookingsApi.get(bookingId),
    enabled: bookingId.length > 0,
    retry: false,
  });

  useDocumentTitle(t("checkout.title"));

  const booking: Booking | undefined = bookingQuery.data?.booking;

  // A pending booking blocks its seats for 15 minutes, then the order dies.
  const expiresAt = booking
    ? new Date(new Date(booking.createdAt).getTime() + 15 * 60_000).toISOString()
    : null;
  const remainingMs = useCountdown(booking?.status === "pending" ? expiresAt : null);

  const promoMutation = useMutation({
    mutationFn: (code: string | null) =>
      code ? bookingsApi.applyPromo(bookingId, code) : bookingsApi.removePromo(bookingId),
    onSuccess: ({ booking: updated }) => {
      queryClient.setQueryData(queryKeys.booking(bookingId), { booking: updated });
      void queryClient.invalidateQueries({ queryKey: ["bookings"] });
      if (updated.quote.promoCode) {
        setPromoCode("");
        track("promo_applied", {
          booking_id: bookingId,
          code: updated.quote.promoCode,
          percent: updated.quote.discountPercent,
        });
        toast({
          title: t("checkout.promoApplied", {
            code: updated.quote.promoCode,
            percent: updated.quote.discountPercent,
          }),
          variant: "success",
        });
      }
    },
    onError: (error: unknown) => {
      toast({
        title: t("checkout.promoInvalid"),
        description: translateApiError(error, t),
        variant: "error",
      });
    },
  });

  useEffect(() => {
    if (booking && booking.status !== "pending") {
      navigate(`/tickets/${booking.id}`, { replace: true });
    }
  }, [booking, navigate]);

  // Funnel step (ТЗ §10): the buyer reached the checkout screen.
  useEffect(() => {
    if (bookingId) track("begin_checkout", { booking_id: bookingId });
  }, [bookingId]);

  if (bookingQuery.isPending) {
    return (
      <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-10 sm:px-6 lg:grid-cols-[1fr_360px]">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-80 rounded-2xl" />
      </div>
    );
  }

  if (bookingQuery.isError || !booking) {
    const error = bookingQuery.error;
    if (error instanceof ApiRequestError && error.status === 404) {
      return <Navigate to="/my-tickets" replace />;
    }
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6">
        <ErrorState
          error={error}
          onRetry={() => void bookingQuery.refetch()}
          title={t("checkout.unavailable")}
        />
      </div>
    );
  }

  const poster = posterFor(booking.movie.slug, booking.movie.posterUrl);
  const expiringSoon = remainingMs > 0 && remainingMs < 3 * 60_000;
  const title = movieText(booking.movie, locale).title;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-7">
        <h1 className="text-2xl font-bold text-white sm:text-3xl">{t("checkout.title")}</h1>
        <p className="mt-1.5 text-sm text-white/60">{t("checkout.subtitle")}</p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <section className="space-y-6">
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-white/50">
              {t("checkout.bookingDetail")}
            </h2>

            <div className="flex gap-4">
              {poster ? (
                <img
                  src={poster}
                  alt={t("movie.posterAlt", { title })}
                  className="hidden w-20 shrink-0 rounded-lg sm:block"
                />
              ) : null}
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-white">{title}</h3>
                <p className="mt-1 text-sm text-white/60">
                  {formatShowDateTime(booking.startsAt, locale, booking.timeZone)} ·{" "}
                  {formatDuration(booking.movie.durationMinutes, locale)}
                </p>
                <p className="mt-0.5 text-sm text-white/60">
                  {booking.theaterName} · {localizeHall(booking.hall, t)}
                </p>
                <p className="mt-0.5 text-sm text-white/55">{booking.theaterAddress}</p>
                <p className="mt-2 text-sm text-white/80">
                  {t("ticket.seats")}:{" "}
                  <strong className="font-semibold">
                    {booking.seats.map((seat) => seat.label).join(", ")}
                  </strong>
                </p>
              </div>
            </div>
          </div>

          <PromoBox
            value={promoCode}
            onChange={setPromoCode}
            appliedCode={booking.quote.promoCode}
            discountPercent={booking.quote.discountPercent}
            pending={promoMutation.isPending}
            onApply={() => promoMutation.mutate(promoCode)}
            onRemove={() => promoMutation.mutate(null)}
          />

          <div className="flex justify-end">
            <ButtonLink
              to={`/checkout/${bookingId}/payment`}
              size="lg"
              rightIcon={<CheckCircle2 className="size-4" aria-hidden />}
            >
              {t("checkout.payment")} · {money(booking.quote.totalCents)}
            </ButtonLink>
          </div>
        </section>

        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <PriceSummary
            quote={booking.quote}
            footer={
              <ul className="space-y-2 text-xs text-white/55">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-brand-400" aria-hidden />
                  {t("checkout.reservedNote")}
                </li>
                <li className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                  {t("checkout.noExchangeNote")}
                </li>
              </ul>
            }
          />

          {remainingMs > 0 ? (
            <Alert tone={expiringSoon ? "warning" : "info"} className="flex items-center gap-2">
              <Clock className="size-4 shrink-0" aria-hidden />
              <span>
                {t("checkout.completeIn")}{" "}
                <strong className="tabular-nums">{formatCountdown(remainingMs)}</strong>{" "}
                {t("checkout.orSeatsReleased")}
              </span>
            </Alert>
          ) : null}

          <p className="px-1 text-xs text-white/50">
            {t("checkout.reference")} <span className="font-mono text-white/60">{booking.code}</span>
          </p>
        </aside>
      </div>
    </div>
  );
}

function PromoBox({
  value,
  onChange,
  appliedCode,
  discountPercent,
  pending,
  onApply,
  onRemove,
}: {
  value: string;
  onChange: (value: string) => void;
  appliedCode: string | null;
  discountPercent: number;
  pending: boolean;
  onApply: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-white/50">
        <Tag className="size-4" aria-hidden />
        {t("checkout.promoLabel")}
      </h2>

      {appliedCode ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-brand-500/10 px-4 py-3">
          <p className="text-sm font-semibold text-brand-300">
            {t("checkout.promoApplied", { code: appliedCode, percent: discountPercent })}
          </p>
          <button
            type="button"
            onClick={onRemove}
            disabled={pending}
            className="inline-flex items-center gap-1 text-xs text-white/60 transition hover:text-white disabled:opacity-50"
          >
            <X className="size-3.5" aria-hidden />
            {t("checkout.promoRemove")}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            value={value}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
            placeholder={t("checkout.promoPlaceholder")}
            label={t("checkout.promoLabel")}
            aria-label={t("checkout.promoLabel")}
            maxLength={24}
            className="flex-1"
          />
          <Button
            type="button"
            variant="secondary"
            onClick={onApply}
            loading={pending}
            disabled={value.trim().length < 3}
            className="sm:mt-[26px]"
          >
            {t("checkout.promoApply")}
          </Button>
        </div>
      )}
    </div>
  );
}
