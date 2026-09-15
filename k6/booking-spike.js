/*
 * Booking spike — load + mutual-exclusion proof for seat holds.
 *
 * Two scenarios run in parallel against two different showtimes:
 *
 *   1. hot_seat_race — HOT_VUS virtual users (default 1000) hold THE SAME seat,
 *      exactly once each. The `hot_seat_wins` counter must equal 1: a single
 *      winner and HOT_VUS-1 HTTP 409s is the distributed proof that a seat can
 *      never be double-booked, no matter how many buyers collide.
 *   2. booking_spike — a realistic mix (seat-map reads + 1-2 seat holds) ramping
 *      to SPIKE_VUS users. Thresholds: zero unexpected statuses, p95 < 500ms.
 *
 * Run against a fresh server (stale 5-minute holds shrink the free-seat pool):
 *
 *   DATA_DIR=$(mktemp -d) PORT=4000 JWT_SECRET=dev-secret-long-enough \
 *     npm run dev -w @movie-tickets/server &
 *   BASE_URL=http://localhost:4000 k6 run k6/booking-spike.js
 *
 * Env knobs: BASE_URL (default http://localhost:4000), HOT_VUS (default 1000),
 * SPIKE_VUS (default 100), SPIKE_TIME (ramp-hold seconds, default 60).
 */

import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL ?? "http://localhost:4000";
const HOT_VUS = Number(__ENV.HOT_VUS ?? 1000);
const SPIKE_VUS = Number(__ENV.SPIKE_VUS ?? 100);
const SPIKE_TIME = Number(__ENV.SPIKE_TIME ?? 60);

/** Every 200 on the hot seat. Must be exactly 1 after HOT_VUS single attempts. */
const hotWins = new Counter("hot_seat_wins");
/** Any status outside the expected set (200 reads, 200/409 holds). */
const spikeErrors = new Rate("spike_errors");
const seatsLatency = new Trend("spike_seats_latency");
const holdsLatency = new Trend("spike_holds_latency");

export const options = {
  scenarios: {
    hot_seat_race: {
      executor: "per-vu-iterations",
      vus: HOT_VUS,
      iterations: 1,
      maxDuration: "5m",
      exec: "hotSeatRace",
    },
    booking_spike: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: `${Math.floor(SPIKE_TIME / 3)}s`, target: Math.floor(SPIKE_VUS / 2) },
        { duration: `${Math.floor(SPIKE_TIME / 3)}s`, target: SPIKE_VUS },
        { duration: `${Math.ceil(SPIKE_TIME / 3)}s`, target: 0 },
      ],
      exec: "bookingSpike",
    },
  },
  thresholds: {
    hot_seat_wins: ["count == 1"],
    spike_errors: ["rate == 0"],
    spike_seats_latency: ["p(95) < 500"],
    spike_holds_latency: ["p(95) < 500"],
  },
};

const jsonHeaders = { "Content-Type": "application/json" };

function showtimes() {
  const res = http.get(`${BASE_URL}/api/showtimes`, {
    responseCallback: http.expectedStatuses(200),
  });
  if (res.status !== 200) fail(`GET /api/showtimes -> ${res.status} (is the API up at ${BASE_URL}?)`);
  return res.json("items") ?? [];
}

function freeSeats(showtimeId) {
  const res = http.get(`${BASE_URL}/api/showtimes/${showtimeId}/seats`, {
    responseCallback: http.expectedStatuses(200),
  });
  if (res.status !== 200) return [];
  return (res.json("seats") ?? []).filter((seat) => seat.status === "available").map((seat) => seat.id);
}

export function setup() {
  const items = showtimes();
  if (items.length < 2) fail(`need 2+ showtimes, got ${items.length}`);

  const candidates = [];
  for (const item of items.slice(0, 12)) {
    const free = freeSeats(item.id);
    if (free.length > 0) candidates.push({ id: item.id, free });
    if (candidates.length >= 3) break;
  }
  // The roomiest hall takes the spike; the smallest one hosts the hot race.
  candidates.sort((a, b) => a.free.length - b.free.length);
  if (candidates.length < 2 || candidates[1].free.length < 10) {
    fail(
      "need 2 showtimes with free seats (10+ in one) — " +
        "stale 5-minute holds from a previous run? Restart the API with a fresh DATA_DIR.",
    );
  }
  const [hot, spike] = candidates;
  console.log(
    `hot race: showtime ${hot.id} seat ${hot.free[0]} x ${HOT_VUS} VUs | ` +
      `spike: showtime ${spike.id} (${spike.free.length} free) up to ${SPIKE_VUS} VUs`,
  );
  return { hotShowtime: hot.id, hotSeat: hot.free[0], spikeShowtime: spike.id, spikeSeats: spike.free };
}

export function hotSeatRace(data) {
  const res = http.post(
    `${BASE_URL}/api/showtimes/${data.hotShowtime}/holds`,
    JSON.stringify({ seatIds: [data.hotSeat] }),
    { headers: jsonHeaders, responseCallback: http.expectedStatuses(200, 409) },
  );
  check(res, { "race: 200 or 409": (r) => r.status === 200 || r.status === 409 });
  if (res.status === 200) hotWins.add(1);
  else if (res.status !== 409) spikeErrors.add(true);
}

export function bookingSpike(data) {
  const map = http.get(`${BASE_URL}/api/showtimes/${data.spikeShowtime}/seats`, {
    responseCallback: http.expectedStatuses(200),
  });
  seatsLatency.add(map.timings.duration);
  const mapOk = check(map, { "spike: seats 200": (r) => r.status === 200 });
  spikeErrors.add(!mapOk);

  // 1-2 random seats from the setup-time pool; collisions (409) are expected.
  const pool = data.spikeSeats;
  const first = pool[Math.floor(Math.random() * pool.length)];
  const wanted = Math.random() < 0.5 ? [first] : [first, pool[Math.floor(Math.random() * pool.length)]];
  const seatIds = [...new Set(wanted)];

  const hold = http.post(
    `${BASE_URL}/api/showtimes/${data.spikeShowtime}/holds`,
    JSON.stringify({ seatIds }),
    { headers: jsonHeaders, responseCallback: http.expectedStatuses(200, 409) },
  );
  holdsLatency.add(hold.timings.duration);
  const holdOk = check(hold, { "spike: hold 200|409": (r) => r.status === 200 || r.status === 409 });
  spikeErrors.add(!holdOk);

  // A granted hold must be immediately visible as held to everyone else.
  if (hold.status === 200) {
    const verify = http.get(`${BASE_URL}/api/showtimes/${data.spikeShowtime}/seats`, {
      responseCallback: http.expectedStatuses(200),
    });
    check(verify, {
      "spike: won seats read back as held": (r) =>
        seatIds.every((id) => (r.json("seats") ?? []).find((seat) => seat.id === id)?.status === "held"),
    });
  }

  sleep(0.2 + Math.random() * 0.5);
}

export function teardown(data) {
  const res = http.get(`${BASE_URL}/api/showtimes/${data.hotShowtime}/seats`, {
    responseCallback: http.expectedStatuses(200),
  });
  check(res, {
    "teardown: hot seat held after the race": (r) =>
      (r.json("seats") ?? []).find((seat) => seat.id === data.hotSeat)?.status === "held",
  });
}
