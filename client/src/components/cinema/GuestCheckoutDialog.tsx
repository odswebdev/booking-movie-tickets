import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Mail, Smartphone, User as UserIcon, Zap } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { formatPhoneInput } from "@/lib/phone";

export interface GuestCheckoutValues {
  name: string;
  email: string;
  phone?: string;
}

export interface GuestCheckoutDialogProps {
  open: boolean;
  onClose: () => void;
  loading?: boolean;
  onSubmit: (values: GuestCheckoutValues) => void | Promise<void>;
}

/**
 * Гостевой checkout (ТЗ §5): минимум данных, чтобы получить билеты, и
 * отдельная кнопка входа для тех, у кого аккаунт уже есть.
 */
export function GuestCheckoutDialog({ open, onClose, loading, onSubmit }: GuestCheckoutDialogProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<GuestCheckoutValues>({ name: "", email: "", phone: "" });
  const [errors, setErrors] = useState<Partial<Record<keyof GuestCheckoutValues, string>>>({});

  const submit = () => {
    const next: Partial<Record<keyof GuestCheckoutValues, string>> = {};
    if (values.name.trim().length < 2) next.name = t("errors.required");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email.trim())) next.email = t("errors.email");
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    void onSubmit({ ...values, name: values.name.trim(), email: values.email.trim().toLowerCase() });
  };

  return (
    <Modal open={open} onClose={onClose} title={t("auth.guestTitle")} description={t("auth.guestHint")}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          label={t("auth.guestName")}
          value={values.name}
          onChange={(event) => setValues((current) => ({ ...current, name: event.target.value }))}
          autoComplete="name"
          error={errors.name}
          leftAddon={<UserIcon className="size-4" aria-hidden />}
        />
        <Input
          label={t("auth.guestEmail")}
          type="email"
          value={values.email}
          onChange={(event) => setValues((current) => ({ ...current, email: event.target.value }))}
          autoComplete="email"
          error={errors.email}
          leftAddon={<Mail className="size-4" aria-hidden />}
        />
        <Input
          label={t("auth.guestPhone")}
          type="tel"
          inputMode="tel"
          value={values.phone ?? ""}
          onChange={(event) =>
            setValues((current) => ({ ...current, phone: formatPhoneInput(event.target.value) }))
          }
          autoComplete="tel"
          leftAddon={<Smartphone className="size-4" aria-hidden />}
        />
        <Button
          type="submit"
          size="lg"
          fullWidth
          loading={loading}
          leftIcon={<Zap className="size-4" aria-hidden />}
        >
          {t("auth.guestContinue")}
        </Button>
      </form>
    </Modal>
  );
}
