import type { Locale, Movie, Showtime, Theater } from "../../../shared/types.js";
import { getCatalog } from "./catalog.js";
import { movieReviewSummary } from "./loyaltyService.js";

/**
 * SEO layer (ТЗ §8): canonical URLs, hreflang alternates, Open Graph and
 * schema.org JSON-LD — plus the "витрина" injected into the SPA shell so
 * crawlers (and link unfurlers) see real content without executing JS.
 *
 * Everything is derived from the live catalog, so the storefront, sitemap and
 * structured data can never drift from what the API serves.
 */

export type JsonLd = Record<string, unknown>;

export interface SeoMeta {
  title: string;
  description: string;
  canonical: string;
  /** `hreflang` alternates, including `x-default`. */
  alternates: Array<{ hreflang: string; href: string }>;
  image?: string | undefined;
  type: "website" | "video.movie";
  jsonLd: JsonLd[];
  /** Body of the noscript storefront block (plain HTML). */
  storefrontHtml: string;
  /** `noindex` for private/utility routes. */
  noindex?: boolean;
}

const LOCALES: Locale[] = ["en", "ru"];

function trim(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** `</script>` inside JSON-LD would end the tag early — and `<!--` can break parsers. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Splits `/ru/movies/dune-two` into `{ locale: "ru", rest: "/movies/dune-two" }`. */
export function splitLocalePath(pathname: string): { locale: Locale; rest: string } {
  const match = /^\/(en|ru)(?=\/|$)/.exec(pathname);
  if (!match) return { locale: "en", rest: pathname || "/" };
  const locale = match[1] as Locale;
  const rest = pathname.slice(match[0].length) || "/";
  return { locale, rest: rest.startsWith("/") ? rest : `/${rest}` };
}

/** Locale-prefixed path — the canonical URL shape of the SPA (ТЗ §9b). */
export function localePath(locale: Locale, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return clean === "/" ? `/${locale}` : `/${locale}${clean}`;
}

function absolute(origin: string, path: string): string {
  return `${origin.replace(/\/$/, "")}${path}`;
}

function alternatesFor(origin: string, rest: string): Array<{ hreflang: string; href: string }> {
  const base = rest === "/" ? "" : rest;
  return [
    ...LOCALES.map((locale) => ({ hreflang: locale, href: absolute(origin, `/${locale}${base}`) })),
    { hreflang: "x-default", href: absolute(origin, `/en${base}`) },
  ];
}

function movieText(movie: Movie, locale: Locale): { title: string; synopsis: string } {
  const localized = movie.localized?.[locale];
  return {
    title: localized?.title ?? movie.title,
    synopsis: localized?.synopsis ?? movie.synopsis,
  };
}

function theaterText(theater: Theater, locale: Locale): { name: string; city: string; address: string } {
  const localized = theater.localized?.[locale];
  return {
    name: localized?.name ?? theater.name,
    city: localized?.city ?? theater.city,
    address: localized?.address ?? theater.address,
  };
}

/* --------------------------------------------------------------------------
 * JSON-LD builders
 * ------------------------------------------------------------------------ */

export function movieJsonLd(input: {
  movie: Movie;
  locale: Locale;
  url: string;
  screenings: Showtime[];
  theaters: Theater[];
  rating?: { average: number | null; count: number };
}): JsonLd[] {
  const { movie, locale, url, screenings, theaters } = input;
  const text = movieText(movie, locale);
  const nowShowing = theaters.filter((theater) =>
    screenings.some((showtime) => showtime.theaterId === theater.id),
  );
  const fromPrice = screenings.reduce<number | null>(
    (min, showtime) => (min === null || showtime.fromPriceCents < min ? showtime.fromPriceCents : min),
    null,
  );

  const movieNode: JsonLd = {
    "@context": "https://schema.org",
    "@type": "Movie",
    name: text.title,
    description: trim(text.synopsis, 300),
    url,
    ...(movie.posterUrl ? { image: movie.posterUrl } : {}),
    ...(movie.releaseDate ? { datePublished: movie.releaseDate } : {}),
    genre: movie.genres,
    duration: `PT${movie.durationMinutes}M`,
    contentRating: movie.rating,
    inLanguage: locale,
    ...(movie.trailerUrl
      ? { trailer: { "@type": "VideoObject", name: `${text.title} — trailer`, url: movie.trailerUrl } }
      : {}),
  };

  // AggregateRating must be a real aggregate: our own reviews first, then the
  // catalog rating (TMDB) — never an invented number.
  const rating = input.rating ?? { average: null, count: 0 };
  if (rating.average !== null && rating.count > 0) {
    movieNode.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: Number(rating.average.toFixed(1)),
      ratingCount: rating.count,
      bestRating: 10,
      worstRating: 1,
    };
  } else if (movie.voteAverage && movie.voteAverage > 0) {
    movieNode.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: Number(movie.voteAverage.toFixed(1)),
      ratingCount: 1,
      bestRating: 10,
      worstRating: 1,
    };
  }

  const events: JsonLd[] = screenings.slice(0, 20).map((showtime) => ({
    "@context": "https://schema.org",
    "@type": "ScreeningEvent",
    name: `${text.title} — ${showtime.date} ${showtime.time}`,
    startDate: showtime.startsAt,
    endDate: showtime.endsAt,
    url: absolute(new URL(url).origin, `${new URL(url).pathname}`),
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    workPresented: { "@type": "Movie", name: text.title },
    location: {
      "@type": "MovieTheater",
      name: showtime.theaterName,
      address: theaters.find((theater) => theater.id === showtime.theaterId)?.address ?? undefined,
    },
    ...(fromPrice !== null
      ? {
          offers: {
            "@type": "Offer",
            price: (showtime.fromPriceCents / 100).toFixed(2),
            priceCurrency: showtime.currency,
            availability: "https://schema.org/InStock",
            url,
          },
        }
      : {}),
  }));

  const theaterNodes: JsonLd[] = nowShowing.slice(0, 6).map((theater) => {
    const place = theaterText(theater, locale);
    return {
      "@context": "https://schema.org",
      "@type": "MovieTheater",
      name: place.name,
      address: { "@type": "PostalAddress", streetAddress: place.address, addressLocality: place.city },
      ...(theater.coordinates
        ? {
            geo: {
              "@type": "GeoCoordinates",
              latitude: theater.coordinates.lat,
              longitude: theater.coordinates.lng,
            },
          }
        : {}),
    };
  });

  const breadcrumb: JsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "CineTickets",
        item: absolute(new URL(url).origin, `/${locale}`),
      },
      {
        "@type": "ListItem",
        position: 2,
        name: locale === "ru" ? "Фильмы" : "Movies",
        item: absolute(new URL(url).origin, `/${locale}`),
      },
      { "@type": "ListItem", position: 3, name: text.title, item: url },
    ],
  };

  const offer: JsonLd | null =
    fromPrice === null
      ? null
      : {
          "@context": "https://schema.org",
          "@type": "Offer",
          name: `${text.title} — ${locale === "ru" ? "билеты" : "tickets"}`,
          price: (fromPrice / 100).toFixed(2),
          priceCurrency: screenings[0]?.currency ?? "USD",
          availability: "https://schema.org/InStock",
          url,
          validFrom: new Date().toISOString(),
        };

  return [movieNode, ...events, ...theaterNodes, ...(offer ? [offer] : []), breadcrumb];
}

export function cinemasJsonLd(input: { theaters: Theater[]; locale: Locale; url: string }): JsonLd[] {
  const { theaters, locale, url } = input;
  const list: JsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: locale === "ru" ? "Кинотеатры" : "Cinemas",
    url,
    itemListElement: theaters.map((theater, index) => {
      const place = theaterText(theater, locale);
      return {
        "@type": "ListItem",
        position: index + 1,
        item: {
          "@type": "MovieTheater",
          name: place.name,
          address: { "@type": "PostalAddress", streetAddress: place.address, addressLocality: place.city },
          ...(theater.coordinates
            ? {
                geo: {
                  "@type": "GeoCoordinates",
                  latitude: theater.coordinates.lat,
                  longitude: theater.coordinates.lng,
                },
              }
            : {}),
        },
      };
    }),
  };
  const breadcrumb: JsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "CineTickets",
        item: absolute(new URL(url).origin, `/${locale}`),
      },
      { "@type": "ListItem", position: 2, name: locale === "ru" ? "Кинотеатры" : "Cinemas", item: url },
    ],
  };
  return [list, breadcrumb];
}

/* --------------------------------------------------------------------------
 * Route → metadata
 * ------------------------------------------------------------------------ */

const COPY = {
  en: {
    home: "Book cinema tickets online: pick a movie, cinema, showtime and seat, pay securely and keep every ticket in one place.",
    cinemas:
      "Cinemas, halls and showtimes — find the closest venue, check the map and book seats in seconds.",
    movies: "Now showing",
    notFound: "This page does not exist.",
  },
  ru: {
    home: "Билеты в кино онлайн: выберите фильм, кинотеатр, сеанс и место, оплатите безопасно — все билеты в одном месте.",
    cinemas:
      "Кинотеатры, залы и расписание — найдите ближайший, посмотрите на карте и забронируйте места за минуту.",
    movies: "Сейчас в кино",
    notFound: "Такой страницы нет.",
  },
} as const;

const PRIVATE_PREFIXES = [
  "/checkout",
  "/payment-success",
  "/tickets",
  "/my-tickets",
  "/account",
  "/login",
  "/register",
];

function storefrontBlock(input: {
  locale: Locale;
  title: string;
  intro: string;
  links: Array<{ href: string; label: string }>;
}): string {
  const { locale, title, intro, links } = input;
  const heading = locale === "ru" ? "Доступное расписание сеансов" : "Showtimes you can crawl";
  const items = links
    .map((link) => `<li><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></li>`)
    .join("");
  return [
    `<div id="seo-storefront" style="max-width:720px;margin:0 auto;padding:24px;font-family:system-ui,sans-serif;color:#e8eaed">`,
    `<h1 style="font-size:22px">${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<h2 style="font-size:17px">${escapeHtml(heading)}</h2>`,
    `<ul>${items}</ul>`,
    `</div>`,
  ].join("");
}

/** Builds the full metadata set for one SPA path. */
export async function buildSeo(pathname: string, origin: string): Promise<SeoMeta> {
  const { locale, rest } = splitLocalePath(pathname);
  const catalog = getCatalog();
  const copy = COPY[locale];
  const canonical = absolute(origin, localePath(locale, rest));
  const alternates = alternatesFor(origin, rest);
  const siteUrl = absolute(origin, `/${locale}`);
  const isPrivate = PRIVATE_PREFIXES.some((prefix) => rest === prefix || rest.startsWith(`${prefix}/`));

  if (isPrivate) {
    return {
      title: "CineTickets",
      description: copy.home,
      canonical,
      alternates,
      type: "website",
      jsonLd: [],
      noindex: true,
      storefrontHtml: "",
    };
  }

  const movieMatch = /^\/movies\/([^/]+)\/?$/.exec(rest);
  if (movieMatch?.[1]) {
    const movie = catalog.movieBySlug(decodeURIComponent(movieMatch[1]));
    if (movie) {
      const text = movieText(movie, locale);
      const screenings = catalog.listShowtimes({ movieId: movie.id });
      const theaters = catalog.theaters;
      const summary = await movieReviewSummary(movie.id, locale);
      const title = `${text.title} — CineTickets`;
      const description = trim(text.synopsis, 160);
      const links = screenings.slice(0, 8).map((showtime) => ({
        href: localePath(locale, `/movies/${movie.slug}`),
        label: `${text.title} — ${showtime.date} ${showtime.time} · ${showtime.theaterName}`,
      }));
      return {
        title,
        description,
        canonical,
        alternates,
        image: movie.posterUrl || movie.backdropUrl || undefined,
        type: "video.movie",
        jsonLd: movieJsonLd({
          movie,
          locale,
          url: canonical,
          screenings,
          theaters,
          rating: { average: summary.average, count: summary.count },
        }),
        storefrontHtml: storefrontBlock({ locale, title: text.title, intro: description, links }),
      };
    }
  }

  if (rest === "/cinemas") {
    const theaters = catalog.theatersForLocale(locale);
    const title = locale === "ru" ? "Кинотеатры — CineTickets" : "Cinemas — CineTickets";
    return {
      title,
      description: copy.cinemas,
      canonical,
      alternates,
      type: "website",
      jsonLd: cinemasJsonLd({ theaters, locale, url: canonical }),
      storefrontHtml: storefrontBlock({
        locale,
        title: locale === "ru" ? "Наши кинотеатры" : "Our cinemas",
        intro: copy.cinemas,
        links: theaters.map((theater) => ({
          href: localePath(locale, "/cinemas"),
          label: `${theater.name} · ${theater.city} · ${theater.address}`,
        })),
      }),
    };
  }

  // Home + movie catalogue (the "витрина" lists what is actually bookable).
  const movies = catalog.nowShowing(locale);
  const links = movies.map((movie) => {
    const text = movieText(movie, locale);
    return { href: localePath(locale, `/movies/${movie.slug}`), label: text.title };
  });
  const firstDate = catalog.availableDates()[0];
  return {
    title: "CineTickets — Book movie tickets online",
    description: copy.home,
    canonical: absolute(origin, localePath(locale, "/")),
    alternates: alternatesFor(origin, "/"),
    type: "website",
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "CineTickets",
        url: siteUrl,
        inLanguage: locale,
        potentialAction: {
          "@type": "SearchAction",
          target: `${siteUrl}/?q={search_term_string}`,
          "query-input": "required name=search_term_string",
        },
      },
    ],
    storefrontHtml: storefrontBlock({
      locale,
      title: locale === "ru" ? "Билеты в кино онлайн" : "Book movie tickets online",
      intro: firstDate
        ? `${copy.home} ${locale === "ru" ? "Ближайшая дата:" : "Nearest date:"} ${firstDate}`
        : copy.home,
      links,
    }),
  };
}

/* --------------------------------------------------------------------------
 * Shell injection (пререндер «витрины») and machine-readable files
 * ------------------------------------------------------------------------ */

/** Removes the tags we are about to replace, so the shell keeps one of each. */
function stripManaged(html: string): string {
  return html
    .replace(/\n?\s*<title>[\s\S]*?<\/title>/i, "")
    .replace(/\n?\s*<meta\s+name="description"[^>]*>/i, "")
    .replace(/\n?\s*<link\s+rel="canonical"[^>]*>/i, "")
    .replace(/\n?\s*<meta\s+property="og:[^"]*"[^>]*>/gi, "")
    .replace(/\n?\s*<meta\s+name="twitter:[^"]*"[^>]*>/gi, "")
    .replace(/\n?\s*<link\s+rel="alternate"[^>]*>/gi, "")
    .replace(/\n?\s*<script\s+type="application\/ld\+json">[\s\S]*?<\/script>/gi, "");
}

export function renderSeoBlock(meta: SeoMeta): string {
  const lines = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    `<link rel="canonical" href="${escapeHtml(meta.canonical)}" />`,
    ...meta.alternates.map(
      (alternate) =>
        `<link rel="alternate" hreflang="${escapeHtml(alternate.hreflang)}" href="${escapeHtml(alternate.href)}" />`,
    ),
    `<meta property="og:type" content="${meta.type}" />`,
    `<meta property="og:site_name" content="CineTickets" />`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(meta.canonical)}" />`,
    ...(meta.image ? [`<meta property="og:image" content="${escapeHtml(meta.image)}" />`] : []),
    `<meta name="twitter:card" content="${meta.image ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
    ...(meta.noindex ? [`<meta name="robots" content="noindex, nofollow" />`] : []),
    ...meta.jsonLd.map((node) => `<script type="application/ld+json">${safeJson(node)}</script>`),
  ];
  return lines.map((line) => `    ${line}`).join("\n");
}

/**
 * Injects the metadata + noscript storefront into the built SPA shell.
 * The `#root` div and the module script stay untouched — hydration is intact.
 */
export function injectSeoIntoShell(html: string, meta: SeoMeta): string {
  let out = stripManaged(html);
  out = out.replace("</head>", `${renderSeoBlock(meta)}\n  </head>`);
  if (meta.storefrontHtml) {
    out = out.replace(
      '<div id="root"></div>',
      `<div id="root"></div>\n    <noscript>${meta.storefrontHtml}</noscript>`,
    );
  }
  return out;
}

/** `sitemap.xml` with hreflang alternates for every indexable route. */
export function sitemapXml(origin: string, now: Date = new Date()): string {
  const catalog = getCatalog();
  const lastmod = now.toISOString().slice(0, 10);
  const routes = ["/", "/cinemas", ...catalog.nowShowing().map((movie) => `/movies/${movie.slug}`)];

  const entries = routes.flatMap((rest) =>
    LOCALES.map((locale) => {
      const loc = absolute(origin, localePath(locale, rest));
      const alternates = alternatesFor(origin, rest === "/" ? "/" : rest)
        .map(
          (alternate) =>
            `    <xhtml:link rel="alternate" hreflang="${alternate.hreflang}" href="${escapeHtml(alternate.href)}" />`,
        )
        .join("\n");
      const priority = rest === "/" ? "1.0" : rest === "/cinemas" ? "0.7" : "0.8";
      return [
        `  <url>`,
        `    <loc>${escapeHtml(loc)}</loc>`,
        `    <lastmod>${lastmod}</lastmod>`,
        `    <changefreq>daily</changefreq>`,
        `    <priority>${priority}</priority>`,
        alternates,
        `  </url>`,
      ].join("\n");
    }),
  );

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">`,
    ...entries,
    `</urlset>`,
    ``,
  ].join("\n");
}

export function robotsTxt(origin: string): string {
  const base = origin.replace(/\/$/, "");
  return [
    "User-agent: *",
    "Allow: /",
    // Private/transactional routes: nothing to index, and they require a session.
    "Disallow: /en/checkout",
    "Disallow: /ru/checkout",
    "Disallow: /en/my-tickets",
    "Disallow: /ru/my-tickets",
    "Disallow: /en/tickets",
    "Disallow: /ru/tickets",
    "Disallow: /en/account",
    "Disallow: /ru/account",
    "Disallow: /api/",
    "",
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");
}
