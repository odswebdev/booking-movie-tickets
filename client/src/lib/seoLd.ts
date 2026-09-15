import type { Locale, Movie, ReviewSummary, Showtime, Theater } from "@shared/types";

/**
 * schema.org builders shared by the movie page, the cinemas page and the
 * account-side review UI (ТЗ §8: Movie / ScreeningEvent / MovieTheater /
 * Offer / AggregateRating / BreadcrumbList).
 *
 * The server renders the same graph into the prerendered shell; keeping the
 * client copy here means SPA navigation updates the graph without a reload.
 */

export function localePath(locale: Locale, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return clean === "/" ? `/${locale}` : `/${locale}${clean}`;
}

export function movieText(movie: Movie, locale: Locale): { title: string; synopsis: string } {
  const localized = movie.localized?.[locale];
  return {
    title: localized?.title ?? movie.title,
    synopsis: localized?.synopsis ?? movie.synopsis,
  };
}

const BASE_URL = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");

export function absolute(path: string): string {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${BASE_URL}${path}`;
}

export function buildMovieJsonLd(input: {
  movie: Movie;
  locale: Locale;
  url: string;
  screenings: Showtime[];
  theaters: Theater[];
  reviews?: ReviewSummary | null;
}): Array<Record<string, unknown>> {
  const { movie, locale, url, screenings, theaters, reviews } = input;
  const text = movieText(movie, locale);
  const fromPrice = screenings.reduce<number | null>(
    (min, showtime) => (min === null || showtime.fromPriceCents < min ? showtime.fromPriceCents : min),
    null,
  );

  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Movie",
    name: text.title,
    description: text.synopsis.replace(/\s+/g, " ").trim().slice(0, 300),
    url,
    genre: movie.genres,
    duration: `PT${movie.durationMinutes}M`,
    contentRating: movie.rating,
    inLanguage: locale,
  };
  if (movie.posterUrl) node.image = movie.posterUrl;
  if (movie.releaseDate) node.datePublished = movie.releaseDate;
  if (movie.trailerUrl)
    node.trailer = { "@type": "VideoObject", name: `${text.title} — trailer`, url: movie.trailerUrl };
  if (reviews && reviews.count > 0 && reviews.average !== null) {
    node.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: Number(reviews.average.toFixed(1)),
      ratingCount: reviews.count,
      bestRating: 10,
      worstRating: 1,
    };
  } else if (movie.voteAverage && movie.voteAverage > 0) {
    node.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: Number(movie.voteAverage.toFixed(1)),
      ratingCount: 1,
      bestRating: 10,
      worstRating: 1,
    };
  }

  const events = screenings.slice(0, 20).map((showtime) => ({
    "@context": "https://schema.org",
    "@type": "ScreeningEvent",
    name: `${text.title} — ${showtime.date} ${showtime.time}`,
    startDate: showtime.startsAt,
    endDate: showtime.endsAt,
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    workPresented: { "@type": "Movie", name: text.title },
    location: {
      "@type": "MovieTheater",
      name: showtime.theaterName,
      address: theaters.find((theater) => theater.id === showtime.theaterId)?.address,
    },
  }));

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "CineTickets", item: absolute(localePath(locale, "/")) },
      { "@type": "ListItem", position: 2, name: text.title, item: url },
    ],
  };

  const offer =
    fromPrice === null
      ? []
      : [
          {
            "@context": "https://schema.org",
            "@type": "Offer",
            price: (fromPrice / 100).toFixed(2),
            priceCurrency: screenings[0]?.currency ?? "USD",
            availability: "https://schema.org/InStock",
            url,
          },
        ];

  return [node, ...events, ...offer, breadcrumb];
}

export function buildCinemasJsonLd(input: {
  theaters: Theater[];
  locale: Locale;
  url: string;
}): Array<Record<string, unknown>> {
  const { theaters, locale, url } = input;
  return [
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: locale === "ru" ? "Кинотеатры" : "Cinemas",
      url,
      itemListElement: theaters.map((theater, index) => ({
        "@type": "ListItem",
        position: index + 1,
        item: {
          "@type": "MovieTheater",
          name: theater.localized?.[locale]?.name ?? theater.name,
          address: {
            "@type": "PostalAddress",
            streetAddress: theater.localized?.[locale]?.address ?? theater.address,
            addressLocality: theater.localized?.[locale]?.city ?? theater.city,
          },
        },
      })),
    },
  ];
}

export function buildWebsiteJsonLd(locale: Locale): Array<Record<string, unknown>> {
  const url = absolute(localePath(locale, "/"));
  return [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "CineTickets",
      url,
      inLanguage: locale,
    },
  ];
}
