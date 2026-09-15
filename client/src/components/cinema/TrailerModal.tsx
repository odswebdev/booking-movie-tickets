import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Film, ExternalLink } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { track } from "@/lib/analytics";

/**
 * Трейлер-модалка (ТЗ §5).
 *
 * The catalog stores a YouTube watch URL, so the modal embeds the privacy
 * friendly `youtube-nocookie.com` player with the video id extracted from it.
 * Movies without a trailer never render the trigger at all.
 */
export function youtubeEmbedUrl(watchUrl: string): string | null {
  const match = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{6,})/.exec(
    watchUrl,
  );
  return match?.[1] ? `https://www.youtube-nocookie.com/embed/${match[1]}?autoplay=1&rel=0` : null;
}

export interface TrailerModalProps {
  open: boolean;
  onClose: () => void;
  /** YouTube watch URL from the catalog. */
  trailerUrl: string;
  title: string;
  /** Analytics context (movie id/slug) — never PII. */
  movieId?: string;
}

export function TrailerModal({ open, onClose, trailerUrl, title, movieId }: TrailerModalProps) {
  const { t } = useTranslation();
  const embed = useMemo(() => youtubeEmbedUrl(trailerUrl), [trailerUrl]);

  return (
    <Modal open={open} onClose={onClose} title={t("movie.trailer")} size="lg">
      <div className="space-y-3">
        {embed ? (
          <div className="aspect-video w-full overflow-hidden rounded-xl border border-white/10 bg-black">
            <iframe
              key={embed}
              src={embed}
              title={`${title} — ${t("movie.trailer")}`}
              className="size-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={() => track("trailer_open", { movie_id: movieId, title })}
            />
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-white/70">
            <Film className="size-4" aria-hidden />
            {t("movie.trailerUnavailable")}
          </p>
        )}

        <a
          href={trailerUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1.5 text-sm text-brand-300 hover:underline"
        >
          <ExternalLink className="size-4" aria-hidden />
          {t("movie.trailerOnYouTube")}
        </a>
      </div>
    </Modal>
  );
}
