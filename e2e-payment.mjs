/* E2E: full purchase flow using ONLY X-Auth-Token (simulates a proxy that
 * strips `Authorization` and cookies — the exact production failure). */
import { publicEncrypt, constants } from "node:crypto";

const API = process.env.API_URL || "http://localhost:4000/api";
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) failures++;
}

const email = `e2e_${Date.now()}@example.com`;

// 1. register
let res = await fetch(`${API}/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "E2E Buyer", email, password: "Str0ngPassw0rd", confirmPassword: "Str0ngPassw0rd" }),
});
const session = await res.json();
check("register 201", res.status === 201, `status=${res.status}`);
const H = { "Content-Type": "application/json", "X-Auth-Token": session.accessToken };

// 2. /auth/me with ONLY the fallback header
res = await fetch(`${API}/auth/me`, { headers: { "X-Auth-Token": session.accessToken } });
check("me via X-Auth-Token only", res.status === 200, `status=${res.status}`);

// 3. pick a movie + showtime
res = await fetch(`${API}/movies`);
const { items } = await res.json();
const movie = items[0];
res = await fetch(`${API}/movies/${movie.slug}`);
const screen = await res.json();
const showtimeId = screen.screenings[0].days.at(-1).times[0].showtimeId;
check("showtime picked", Boolean(showtimeId), showtimeId);

// 4. seats + hold
res = await fetch(`${API}/showtimes/${showtimeId}/seats`);
const seatMap = await res.json();
const ids = seatMap.seats.filter((s) => s.status === "available").slice(0, 2).map((s) => s.id);
check("2 free seats", ids.length === 2);
res = await fetch(`${API}/showtimes/${showtimeId}/holds`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seatIds: ids }),
});
const { holdToken } = await res.json();
check("hold created", res.status === 200);

// 5. booking with ONLY X-Auth-Token (this was the 401 before the fix)
res = await fetch(`${API}/bookings`, {
  method: "POST", headers: H, body: JSON.stringify({ showtimeId, seatIds: ids, holdToken }),
});
const { booking } = await res.json();
check("booking 201 via X-Auth-Token", res.status === 201, `status=${res.status} total=${booking?.quote?.totalCents}`);

// 6. checkout page data (booking get) with ONLY X-Auth-Token
res = await fetch(`${API}/bookings/${booking.id}`, { headers: { "X-Auth-Token": session.accessToken } });
check("checkout booking get", res.status === 200, `status=${res.status}`);

// 7. payment intent (RSA-OAEP like the browser does)
res = await fetch(`${API}/config/payment-key`);
const key = await res.json();
const pem = `-----BEGIN PUBLIC KEY-----\n${key.publicKey.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----`;
const encrypted = publicEncrypt(
  { key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
  Buffer.from(JSON.stringify({ number: "4242424242424242", name: "E2E Buyer", expiry: "12/30", cvc: "123" }), "utf8"),
).toString("base64");
res = await fetch(`${API}/payments/intents`, {
  method: "POST", headers: H,
  body: JSON.stringify({ bookingId: booking.id, method: "card", phone: "+12025550123", card: { keyId: key.keyId, encrypted } }),
});
const intentBody = await res.json();
check("payment intent 201", res.status === 201, `status=${res.status} code=${intentBody.payment?.devCode}`);
const payment = intentBody.payment;

// 8. verify SMS code
res = await fetch(`${API}/payments/${payment.id}/verify`, {
  method: "POST", headers: H, body: JSON.stringify({ code: payment.devCode }),
});
const verified = await res.json();
check("payment verified, booking confirmed", res.status === 200 && verified.booking?.status === "confirmed",
  `status=${res.status} booking=${verified.booking?.status}`);

// 9. ticket readable
res = await fetch(`${API}/bookings/${booking.id}`, { headers: { "X-Auth-Token": session.accessToken } });
const ticket = await res.json();
check("ticket confirmed", ticket.booking?.status === "confirmed", `code=${ticket.booking?.code}`);

// 10. forged token still rejected
res = await fetch(`${API}/auth/me`, { headers: { "X-Auth-Token": "forged" } });
check("forged token 401", res.status === 401, `status=${res.status}`);

// 11. provider webhook is idempotent (redelivery of an already-settled payment)
res = await fetch(`${API}/webhooks/mock`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ eventId: "e2e-dup-1", providerRef: `mock_${payment.id}`, status: "succeeded" }),
});
const wh = await res.json();
check("webhook redelivery acknowledged", res.status === 200 && wh.outcome === "already_processed",
  `status=${res.status} outcome=${wh.outcome}`);

console.log(failures === 0 ? "\nE2E OK — payment works without Authorization header" : `\nE2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
