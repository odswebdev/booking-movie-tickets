import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppShell } from "@/components/layout/AppShell";
import { AnalyticsBridge } from "@/components/analytics/AnalyticsBridge";
import { ProtectedRoute } from "@/router/ProtectedRoute";
import { Spinner } from "@/components/ui/Feedback";

// Route-level code splitting keeps the initial bundle small.
const HomePage = lazy(() => import("@/pages/HomePage"));
const MoviePage = lazy(() => import("@/pages/MoviePage"));
const SeatsPage = lazy(() => import("@/pages/SeatsPage"));
const CheckoutPage = lazy(() => import("@/pages/CheckoutPage"));
const PaymentPage = lazy(() => import("@/pages/PaymentPage"));
const PaymentSuccessPage = lazy(() => import("@/pages/PaymentSuccessPage"));
const TicketPage = lazy(() => import("@/pages/TicketPage"));
const MyTicketsPage = lazy(() => import("@/pages/MyTicketsPage"));
const LoginPage = lazy(() => import("@/pages/LoginPage"));
const RegisterPage = lazy(() => import("@/pages/RegisterPage"));
const CinemasPage = lazy(() => import("@/pages/CinemasPage"));
const AccountPage = lazy(() => import("@/pages/AccountPage"));
const NotFoundPage = lazy(() => import("@/pages/NotFoundPage"));

function RouteFallback() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Spinner label={t("common.loading")} />
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      {/* GA4 + Метрика through GTM (ТЗ §10): a single bridge keeps the page
          views and the funnel events in one place. */}
      <AnalyticsBridge />
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="movies/:slug" element={<MoviePage />} />
          <Route path="cinemas" element={<CinemasPage />} />
          <Route path="showtimes/:showtimeId/seats" element={<SeatsPage />} />

          <Route
            path="checkout/:bookingId"
            element={
              <ProtectedRoute>
                <CheckoutPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="checkout/:bookingId/payment"
            element={
              <ProtectedRoute>
                <PaymentPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="payment-success/:bookingId"
            element={
              <ProtectedRoute>
                <PaymentSuccessPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="tickets/:bookingId"
            element={
              <ProtectedRoute>
                <TicketPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="my-tickets"
            element={
              <ProtectedRoute>
                <MyTicketsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="account"
            element={
              <ProtectedRoute>
                <AccountPage />
              </ProtectedRoute>
            }
          />

          <Route path="login" element={<LoginPage />} />
          <Route path="register" element={<RegisterPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
