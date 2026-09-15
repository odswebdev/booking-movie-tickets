import PDFDocument from "pdfkit";
import type { Booking } from "../../../shared/types.js";

export interface ReceiptPdfOptions {
  /** pdfkit compresses text streams by default; tests disable it to assert content. */
  compress?: boolean;
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/**
 * Payment receipt (A4, Helvetica only — no embedded fonts to ship).
 * Pure function of the booking: the same bytes in tests and in production.
 */
export async function generateReceiptPdf(booking: Booking, options: ReceiptPdfOptions = {}): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: 56,
    compress: options.compress ?? true,
    info: { Title: `CineTickets receipt ${booking.code}`, Author: "CineTickets" },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  const finished = new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", (error: Error) => reject(error));
  });

  const { quote } = booking;
  doc.fontSize(22).text("CineTickets", { align: "left" });
  doc.fontSize(12).fillColor("#555").text("Payment receipt");
  doc.moveDown();
  doc.fillColor("#000").fontSize(11);
  doc.text(`Receipt: ${booking.code}`);
  doc.text(`Date: ${new Date(booking.createdAt).toUTCString()}`);
  doc.text(`Status: ${booking.status}`);
  doc.moveDown();

  doc.fontSize(13).text(booking.movie.title);
  doc.fontSize(11).fillColor("#333");
  doc.text(`${booking.theaterName} · ${booking.hall}`);
  doc.text(booking.theaterAddress);
  doc.text(new Date(booking.startsAt).toUTCString());
  doc.moveDown();

  doc.fillColor("#000").fontSize(12).text("Seats");
  doc.fontSize(11);
  for (const seat of booking.seats) {
    doc.text(`${seat.label} (${seat.seatClass}) — ${money(seat.priceCents, booking.currency)}`);
  }
  doc.moveDown();

  doc.fontSize(12).text("Total");
  doc.fontSize(11);
  doc.text(`Subtotal (${booking.seats.length} tickets) — ${money(quote.subtotalCents, booking.currency)}`);
  if (quote.discountCents > 0) {
    const promo = quote.promoCode ? ` (${quote.promoCode})` : "";
    doc.text(
      `Discount −${quote.discountPercent}%${promo} — −${money(quote.discountCents, booking.currency)}`,
    );
  }
  doc.text(`Service fee — ${money(quote.serviceFeeCents, booking.currency)}`);
  doc.fontSize(13).text(`Charged: ${money(quote.totalCents, booking.currency)}`);
  doc.moveDown();

  if (booking.payment) {
    const method =
      booking.payment.method === "card"
        ? `Card ${booking.payment.brand ?? ""} •••• ${booking.payment.last4 ?? ""}`.trim()
        : "PayPal";
    doc.fontSize(11).fillColor("#333").text(`Paid with: ${method}`);
    doc.moveDown();
  }

  doc
    .fontSize(9)
    .fillColor("#777")
    .text("Questions about this receipt? Reply to the email it came with — it reaches our support team.");
  doc.end();
  await finished;
  return Buffer.concat(chunks);
}
