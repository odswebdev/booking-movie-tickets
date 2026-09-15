import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MessageSquarePlus, Star } from "lucide-react";
import { moviesApi } from "@/api/endpoints";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { track } from "@/lib/analytics";
import { translateApiError } from "@/lib/errors";
import { cn } from "@/lib/cn";

/**
 * Отзывы (ТЗ §2: Review): 1–10, один отзыв на фильм и пользователя,
 * публикуются только зрителями с оплаченным билетом (проверка на сервере).
 */
export function MovieReviews({ slug, movieId }: { slug: string; movieId: string }) {
  const { t, i18n } = useTranslation();
  const { status } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const locale = i18n.language === "ru" ? "ru" : "en";

  const [rating, setRating] = useState(8);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);

  const summaryQuery = useQuery({
    queryKey: ["reviews", slug, locale],
    queryFn: () => moviesApi.reviews(slug, locale),
    staleTime: 60_000,
  });

  const mineQuery = useQuery({
    queryKey: ["reviews", slug, "mine"],
    queryFn: () => moviesApi.myReview(slug),
    enabled: status === "authenticated",
    staleTime: 30_000,
  });

  const submit = useMutation({
    mutationFn: () => moviesApi.submitReview(slug, { rating, text: text.trim() }),
    onSuccess: (result) => {
      queryClient.setQueryData(["reviews", slug, locale], { summary: result.summary });
      queryClient.setQueryData(["reviews", slug, "mine"], { review: result.review });
      track("review_submitted", { movie_id: movieId, rating });
      toast({
        title: mineQuery.data?.review ? t("reviews.updated") : t("reviews.submitted"),
        variant: "success",
      });
      setOpen(false);
    },
    onError: (error) => {
      toast({ title: t("reviews.failed"), description: translateApiError(error, t), variant: "error" });
    },
  });

  const summary = summaryQuery.data?.summary;
  const mine = mineQuery.data?.review ?? null;

  return (
    <section
      aria-labelledby="movie-reviews-heading"
      className="mt-10 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="movie-reviews-heading" className="flex items-center gap-2 text-lg font-semibold text-white">
          <Star className="size-4 text-brand-400" aria-hidden />
          {t("reviews.title")}
          {summary && summary.count > 0 ? (
            <span className="text-sm font-normal text-white/50">
              {summary.average?.toFixed(1)} · {t("reviews.count", { count: summary.count })}
            </span>
          ) : null}
        </h2>
        {status === "authenticated" ? (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<MessageSquarePlus className="size-4" aria-hidden />}
            onClick={() => {
              setOpen((value) => !value);
              if (mine) {
                setRating(mine.rating);
                setText(mine.text);
              }
            }}
          >
            {mine ? t("reviews.edit") : t("reviews.write")}
          </Button>
        ) : null}
      </div>

      {open ? (
        <form
          className="mt-4 space-y-3 rounded-xl border border-white/10 bg-ink-900/60 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim().length < 3) return;
            submit.mutate();
          }}
        >
          <label className="block text-sm text-white/70">
            {t("reviews.rating")}
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={rating}
              onChange={(event) => setRating(Number(event.target.value))}
              className="mt-2 w-full accent-brand-500"
              aria-valuemin={1}
              aria-valuemax={10}
              aria-valuenow={rating}
            />
            <span className="mt-1 inline-block font-semibold text-brand-300">{rating}/10</span>
          </label>
          <Input
            label={t("reviews.text")}
            value={text}
            maxLength={600}
            onChange={(event) => setText(event.target.value)}
            hint={`${text.length}/600`}
          />
          <div className="flex gap-2">
            <Button type="submit" loading={submit.isPending} disabled={text.trim().length < 3}>
              {t("reviews.submit")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel", { defaultValue: "Cancel" })}
            </Button>
          </div>
          <p className="text-xs text-white/55">{t("reviews.needTicket")}</p>
        </form>
      ) : null}

      {summary && summary.items.length > 0 ? (
        <ul className="mt-5 space-y-4">
          {summary.items.map((review) => (
            <li key={review.id} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-white/85">{review.authorName}</span>
                <span className="flex items-center gap-1 text-sm text-brand-300">
                  <Star className="size-3.5" aria-hidden />
                  {review.rating}/10
                </span>
              </div>
              <p className={cn("mt-2 text-sm leading-relaxed text-white/70")}>{review.text}</p>
              <time dateTime={review.createdAt} className="mt-2 block text-xs text-white/50">
                {new Date(review.createdAt).toLocaleDateString(locale)}
              </time>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-white/50">{t("reviews.empty")}</p>
      )}
    </section>
  );
}
