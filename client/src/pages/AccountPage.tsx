import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Download, Trash2 } from "lucide-react";
import { authApi } from "@/api/endpoints";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { LoyaltyCard } from "@/components/account/LoyaltyCard";
import { PhoneVerificationCard } from "@/components/account/PhoneVerificationCard";

export default function AccountPage() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  useDocumentTitle(t("account.title"));

  const [exporting, setExporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const data = await authApi.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "cinetickets-export.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast({ title: t("account.exportSuccess"), variant: "success" });
    } catch {
      toast({ title: t("account.exportFailed"), description: t("common.retry"), variant: "error" });
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await authApi.deleteAccount();
      await logout();
      toast({ title: t("account.deleteSuccess"), variant: "success" });
      navigate("/", { replace: true });
    } catch {
      toast({ title: t("account.deleteFailed"), description: t("common.retry"), variant: "error" });
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-3xl font-bold text-white sm:text-4xl">{t("account.title")}</h1>
      <p className="mt-2 text-sm text-white/60 sm:text-base">{t("account.subtitle")}</p>

      <section
        aria-labelledby="account-profile-heading"
        className="mt-8 rounded-2xl border border-white/10 bg-ink-800/50 p-6"
      >
        <h2 id="account-profile-heading" className="text-lg font-semibold text-white">
          {t("account.profile")}
        </h2>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-white/50">{t("account.name")}</dt>
            <dd className="truncate text-white">{user?.name}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-white/50">{t("account.email")}</dt>
            <dd className="truncate text-white">{user?.email}</dd>
          </div>
        </dl>
      </section>

      <PhoneVerificationCard />
      <LoyaltyCard />

      <section
        aria-labelledby="account-export-heading"
        className="mt-4 rounded-2xl border border-white/10 bg-ink-800/50 p-6"
      >
        <h2 id="account-export-heading" className="text-lg font-semibold text-white">
          {t("account.exportTitle")}
        </h2>
        <p className="mt-2 text-sm text-white/55">{t("account.exportDescription")}</p>
        <Button
          variant="ghost"
          className="mt-4"
          loading={exporting}
          onClick={() => void handleExport()}
          leftIcon={<Download className="size-4" aria-hidden />}
        >
          {t("account.export")}
        </Button>
      </section>

      <section
        aria-labelledby="account-delete-heading"
        className="mt-4 rounded-2xl border border-danger/30 bg-danger/5 p-6"
      >
        <h2 id="account-delete-heading" className="text-lg font-semibold text-white">
          {t("account.deleteTitle")}
        </h2>
        <p className="mt-2 text-sm text-white/55">{t("account.deleteDescription")}</p>
        <p className="mt-2 text-sm font-medium text-amber-200/90">{t("account.deleteWarning")}</p>
        <Button
          variant="danger"
          className="mt-4"
          onClick={() => setConfirmDelete(true)}
          leftIcon={<Trash2 className="size-4" aria-hidden />}
        >
          {t("account.delete")}
        </Button>
      </section>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("account.deleteConfirmTitle")}
        description={t("account.deleteConfirmDescription")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t("account.cancel")}
            </Button>
            <Button variant="danger" loading={deleting} onClick={() => void handleDelete()}>
              {t("account.delete")}
            </Button>
          </>
        }
      />
    </div>
  );
}
