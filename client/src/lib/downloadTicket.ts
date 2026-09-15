import { formatShowDateTime } from "./localize";

export interface TicketDownloadData {
  code: string;
  movieTitle: string;
  theaterName: string;
  theaterAddress: string;
  hall: string;
  startsAt: string;
  seats: string[];
  /** Pre-formatted for the active language/currency. */
  totalLabel: string;
  /** Labels for the exported rows, already translated. */
  labels: { admit: string; seats: string; reference: string; total: string };
  locale: "en" | "ru";
  timeZone?: string;
  qrDataUrl: string | null;
}

const WIDTH = 900;
const HEIGHT = 360;
const PADDING = 36;

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

/**
 * Renders the ticket to a canvas and downloads it as a PNG.
 * Using the canvas (rather than html2canvas) keeps this dependency-free and
 * guarantees the exported file looks the same in every browser.
 */
export async function downloadTicketPng(data: TicketDownloadData): Promise<void> {
  const canvas = document.createElement("canvas");
  const scale = window.devicePixelRatio > 1 ? 2 : 1;
  canvas.width = WIDTH * scale;
  canvas.height = HEIGHT * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser");
  ctx.scale(scale, scale);

  // Background
  const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, "#0b0e12");
  gradient.addColorStop(1, "#121a22");
  ctx.fillStyle = gradient;
  roundRect(ctx, 0, 0, WIDTH, HEIGHT, 24);
  ctx.fill();

  ctx.strokeStyle = "rgba(29,231,130,0.45)";
  ctx.lineWidth = 2;
  roundRect(ctx, 1, 1, WIDTH - 2, HEIGHT - 2, 24);
  ctx.stroke();

  // Header
  ctx.fillStyle = "#1DE782";
  ctx.font = "600 20px Inter, system-ui, sans-serif";
  ctx.fillText("CINETICKETS", PADDING, PADDING + 16);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "400 13px Inter, system-ui, sans-serif";
  ctx.fillText("Admit one · e-ticket", PADDING, PADDING + 38);

  // Movie
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "700 34px Inter, system-ui, sans-serif";
  ctx.fillText(truncate(ctx, data.movieTitle, WIDTH - PADDING * 2 - 160), PADDING, PADDING + 92);

  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = "400 16px Inter, system-ui, sans-serif";
  ctx.fillText(`${data.theaterName} · ${data.hall}`, PADDING, PADDING + 124);
  ctx.fillText(formatShowDateTime(data.startsAt, data.locale, data.timeZone), PADDING, PADDING + 150);

  // Details grid
  const rows: Array<[string, string]> = [
    [data.labels.seats, data.seats.join(", ")],
    [data.labels.reference, data.code],
    [data.labels.total, data.totalLabel],
  ];
  let y = PADDING + 196;
  for (const [label, value] of rows) {
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "500 12px Inter, system-ui, sans-serif";
    ctx.fillText(label.toUpperCase(), PADDING, y);
    ctx.fillStyle = "#FFFFFF";
    ctx.font = "600 16px Inter, system-ui, sans-serif";
    ctx.fillText(truncate(ctx, value, WIDTH - PADDING * 2 - 170), PADDING, y + 22);
    y += 46;
  }

  // QR code
  const qrDataUrl = data.qrDataUrl;
  if (qrDataUrl) {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Failed to load QR code"));
      image.src = qrDataUrl;
    });
    const size = 150;
    ctx.fillStyle = "#FFFFFF";
    roundRect(ctx, WIDTH - PADDING - size, HEIGHT - PADDING - size, size, size, 12);
    ctx.fill();
    ctx.drawImage(image, WIDTH - PADDING - size + 8, HEIGHT - PADDING - size + 8, size - 16, size - 16);
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not export the ticket");

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cinetickets-${data.code}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let value = text;
  while (value.length > 4 && ctx.measureText(`${value}…`).width > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}…`;
}
