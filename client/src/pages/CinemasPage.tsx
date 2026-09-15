import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MapPin } from "lucide-react";
import type { City, Theater } from "@shared/types";
import { geoApi } from "@/api/endpoints";
import { queryKeys } from "@/api/queryKeys";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { loadStoredCityId, resolveCityId, saveStoredCityId } from "@/lib/city";
import { cn } from "@/lib/cn";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/Feedback";

const CITY_ZOOM = 11;

const PILL =
  "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500";
const PILL_ACTIVE = "bg-brand-500 text-ink-950";
const PILL_IDLE = "bg-white/5 text-white/70 hover:bg-white/10 hover:text-white";

/** DivIcon pins (styled in styles/index.css) — no image assets to resolve. */
function pinIcon(): L.DivIcon {
  return L.divIcon({
    className: "cinema-pin",
    html: '<span class="cinema-pin-dot" aria-hidden="true"></span>',
    // 28×28 hit area (WCAG 2.2 AA target-size ≥ 24px); the dot stays 20px.
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export default function CinemasPage() {
  const { t } = useTranslation();
  const { locale } = useAppConfig();
  useDocumentTitle(t("nav.cinemas"));

  const citiesQuery = useQuery({
    queryKey: queryKeys.cities(),
    queryFn: ({ signal }) => geoApi.cities(signal),
    staleTime: 30 * 60_000,
  });
  const geoQuery = useQuery({
    queryKey: queryKeys.geo(),
    queryFn: ({ signal }) => geoApi.region(signal),
    staleTime: 30 * 60_000,
  });

  const cities = citiesQuery.data?.items ?? [];
  const [storedCityId] = useState<string | null>(loadStoredCityId);
  const [cityId, setCityId] = useState<string | null>(null);
  const defaultCityId = resolveCityId({
    cities,
    storedCityId,
    detectedCityId: geoQuery.data?.region.cityId,
  });
  const activeCityId = cityId ?? defaultCityId;
  const activeCity: City | null = cities.find((city) => city.id === activeCityId) ?? null;

  const theatersQuery = useQuery({
    queryKey: queryKeys.theaters(activeCityId ?? "all", locale),
    queryFn: ({ signal }) => geoApi.theaters({ city: activeCityId ?? undefined, locale }, signal),
    enabled: cities.length > 0,
    staleTime: 60_000,
  });

  const selectCity = (next: string) => {
    setCityId(next);
    saveStoredCityId(next);
  };

  const cityName = (city: City): string => city.names[locale] ?? city.names.en;
  const detectedCity = cities.find((city) => city.id === geoQuery.data?.region.cityId) ?? null;
  const showDetectedHint = geoQuery.data?.region.detected === true && detectedCity !== null;

  const mapHostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.Marker[]>([]);

  // The Leaflet map is created once; React only drives its view and markers.
  // The host div mounts only after the cities resolve, so the effect keys off
  // its presence — a mount-time-only effect would never see the div.
  const mapHostPresent = activeCity !== null;
  useEffect(() => {
    if (!mapHostPresent || !mapHostRef.current || mapRef.current) return;
    const map = L.map(mapHostRef.current, { scrollWheelZoom: false }).setView([20, 0], 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [mapHostPresent]);

  const theatersData = theatersQuery.data;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !activeCity) return;
    for (const marker of markersRef.current) marker.remove();
    const theaters = theatersData?.items ?? [];
    const markers = theaters.flatMap((theater: Theater) => {
      const coords = theater.coordinates;
      if (!coords) return [];
      const marker = L.marker([coords.lat, coords.lng], { icon: pinIcon(), title: theater.name })
        .bindPopup(`<strong>${escapeHtml(theater.name)}</strong><br />${escapeHtml(theater.address)}`)
        .addTo(map);
      return [marker];
    });
    markersRef.current = markers;
    if (markers.length > 0) {
      map.flyToBounds(L.latLngBounds(markers.map((marker) => marker.getLatLng())).pad(0.2), {
        duration: 0.6,
      });
    } else {
      map.flyTo([activeCity.center.lat, activeCity.center.lng], CITY_ZOOM, { duration: 0.6 });
    }
  }, [activeCity, theatersData]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-3xl font-bold text-white sm:text-4xl">{t("cinemas.title")}</h1>
      <p className="mt-2 text-sm text-white/60 sm:text-base">{t("cinemas.subtitle")}</p>
      {showDetectedHint && detectedCity ? (
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-brand-300" role="status">
          <MapPin className="size-3.5" aria-hidden />
          {t("cinemas.detectedIn", { city: cityName(detectedCity) })}
        </p>
      ) : null}

      {citiesQuery.isPending ? (
        <div className="mt-6 flex gap-2" aria-hidden>
          <Skeleton className="h-9 w-28 rounded-full" />
          <Skeleton className="h-9 w-28 rounded-full" />
        </div>
      ) : citiesQuery.isError ? (
        <div className="mt-6">
          <ErrorState
            error={citiesQuery.error}
            onRetry={() => void citiesQuery.refetch()}
            title={t("cinemas.loadError")}
          />
        </div>
      ) : (
        <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label={t("cinemas.title")}>
          {cities.map((city) => (
            <button
              key={city.id}
              type="button"
              onClick={() => selectCity(city.id)}
              aria-pressed={activeCityId === city.id}
              className={cn(PILL, activeCityId === city.id ? PILL_ACTIVE : PILL_IDLE)}
            >
              {cityName(city)}
            </button>
          ))}
        </div>
      )}

      {activeCity ? (
        <div
          ref={mapHostRef}
          role="application"
          aria-label={t("cinemas.mapLabel", { city: cityName(activeCity) })}
          className="relative z-0 mt-6 h-[320px] overflow-hidden rounded-2xl border border-white/10 sm:h-[420px]"
        />
      ) : null}

      {activeCity ? (
        <section aria-labelledby="cinemas-list-heading" className="mt-10">
          <h2 id="cinemas-list-heading" className="text-xl font-semibold text-white sm:text-2xl">
            {t("cinemas.listHeading", { city: cityName(activeCity) })}
          </h2>
          {theatersQuery.isPending ? (
            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="space-y-3 rounded-2xl border border-white/10 p-5">
                  <Skeleton className="h-5 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              ))}
            </div>
          ) : theatersQuery.isError ? (
            <div className="mt-4">
              <ErrorState
                error={theatersQuery.error}
                onRetry={() => void theatersQuery.refetch()}
                title={t("cinemas.loadError")}
              />
            </div>
          ) : (theatersQuery.data?.items.length ?? 0) === 0 ? (
            <div className="mt-4">
              <EmptyState title={t("cinemas.empty")} />
            </div>
          ) : (
            <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {(theatersQuery.data?.items ?? []).map((theater) => (
                <li key={theater.id} className="rounded-2xl border border-white/10 bg-ink-800/50 p-5">
                  <h3 className="font-semibold text-white">{theater.name}</h3>
                  <p className="mt-2 flex items-start gap-1.5 text-sm text-white/55">
                    <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {theater.address}
                  </p>
                  <p className="mt-2 text-xs text-white/50">{theater.city}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
