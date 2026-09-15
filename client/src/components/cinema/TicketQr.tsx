import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Skeleton } from "@/components/ui/Feedback";

/**
 * Renders the booking reference as a QR code so gate staff can scan it.
 * The payload is the reference itself — no personal data is encoded.
 */
export function TicketQr({ value, size = 168 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: size * 2,
      color: { dark: "#07090B", light: "#FFFFFF" },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!dataUrl) return <Skeleton className="rounded-xl" style={{ width: size, height: size }} />;

  return (
    <img
      src={dataUrl}
      alt={`QR code for booking ${value}`}
      width={size}
      height={size}
      className="rounded-xl bg-white p-2"
    />
  );
}
