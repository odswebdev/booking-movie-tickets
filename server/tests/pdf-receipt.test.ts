import { describe, expect, it } from "vitest";
import { generateReceiptPdf } from "../src/services/pdfService.js";
import type { Booking } from "../../shared/types.js";

function fakeBooking(): Booking {
  return {
    id: "bkg_test",
    code: "ABCD-1234",
    userId: "usr_test",
    showtimeId: "st_test",
    status: "confirmed",
    currency: "USD",
    movie: {
      id: "mv_test",
      slug: "test-movie",
      title: "Test Movie",
      posterUrl: "https://example.com/poster.jpg",
      durationMinutes: 120,
      localized: { en: { title: "Test Movie" }, ru: { title: "Test Movie" } },
      discountPercent: 0,
    },
    theaterName: "Test Theater",
    theaterAddress: "1 Test St",
    hall: "Hall 1",
    startsAt: "2026-09-20T14:30:00.000Z",
    endsAt: "2026-09-20T16:30:00.000Z",
    seats: [
      { seatId: "A1", label: "A1", seatClass: "standard", priceCents: 1500 },
      { seatId: "A2", label: "A2", seatClass: "standard", priceCents: 1500 },
    ],
    quote: {
      currency: "USD",
      lines: [],
      subtotalCents: 3000,
      discountCents: 600,
      discountPercent: 20,
      promoCode: "CINEMA20",
      serviceFeeCents: 144,
      totalCents: 2544,
    },
    payment: { method: "card", brand: "visa", last4: "4242", phoneMasked: "+1 ***-01-23" },
    createdAt: "2026-09-14T12:00:00.000Z",
    updatedAt: "2026-09-14T12:05:00.000Z",
    cancelledAt: null,
  };
}

describe("receipt PDF", () => {
  it("renders a valid PDF document", async () => {
    const pdf = await generateReceiptPdf(fakeBooking());
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.subarray(-6).toString("latin1")).toContain("%%EOF");
    expect(pdf.length).toBeGreaterThan(1024);
  });

  it("contains the booking code and the movie title", async () => {
    const pdf = await generateReceiptPdf(fakeBooking(), { compress: false });
    // pdfkit writes text as hex runs (`[<54>120<657374>] TJ`) even uncompressed,
    // split mid-word with kerning offsets — drop the offsets, decode, glue.
    const text = pdf
      .toString("latin1")
      .replace(/>\s*-?\d+(?:\.\d+)?\s*</g, "><")
      .replace(/<([0-9A-Fa-f]+)>/g, (_match, hex: string) => Buffer.from(hex, "hex").toString("latin1"))
      .replace(/\s+/g, "");
    expect(text).toContain("ABCD-1234");
    expect(text).toContain("TestMovie");
    expect(text).toContain("CINEMA20");
  });
});
