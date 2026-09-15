import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { initAnalytics, trackPageView } from "@/lib/analytics";

/**
 * Подключает аналитику один раз на всю сессию (ТЗ §10): инициализирует
 * GTM/GA4/Метрику из `/api/config` и отправляет `page_view` на каждый переход
 * SPA (history-изменения не видны тегам сами по себе).
 */
export function AnalyticsBridge() {
  const { config, analytics } = useAppConfig();
  const { pathname, search } = useLocation();

  useEffect(() => {
    initAnalytics(analytics);
  }, [analytics]);

  useEffect(() => {
    trackPageView(`${pathname}${search}`, document.title);
  }, [pathname, search, config.catalogSource]);

  return null;
}
