/**
 * Cheapest recent round-trip fares from one origin to every destination, for
 * the trip finder's whole-trip budget (2026-10-29). Shared by GET /fares (the
 * website quiz) and find_destination in functions/mcp.js.
 *
 * Source: the Travelpayouts Aviasales Data API (/v1/prices/cheap with no
 * destination), the cheapest fares Aviasales users found for the month in
 * the last days, one adult, economy, in EUR. Travelpayouts allows this data
 * on partner sites with an API token and recommends it "to inform users"
 * (support.travelpayouts.com article 203956083, read 2026-10-29). These are
 * cached search results, never a live quote: every surface says so.
 *
 * Token: the TP_TOKEN secret (the Pages project), else TP. Without one the
 * result is null and the finder falls back to hotel-only budgets.
 * Prices are keyed by Travelpayouts CITY code (PAR, LON, BUE); map airport
 * codes with data/airport_city.json first. Edge-cached 6 h per query.
 */
const TTL = 6 * 3600;
const MONTH = /^20\d\d-(0[1-9]|1[0-2])$/;

export async function cheapFares(env, origin, depart) {
  const token = env && (env.TP_TOKEN || env.TP);
  origin = String(origin || '').toUpperCase();
  if (!token || !/^[A-Z]{3}$/.test(origin) || !MONTH.test(depart)) return null;
  const key = new Request(`https://fares.voyagehacks.internal/${origin}/${depart}`);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  }
    /* Departure month only: also constraining the return month dropped about a
     third of the destinations (a 7-night trip from the 28th returns next month). */
  const url = `https://api.travelpayouts.com/v1/prices/cheap?origin=${origin}&depart_date=${depart}&currency=eur&token=${token}`;
  let data;
  try {
    const r = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
    if (!r.ok) return null;
    data = await r.json();
  } catch (e) { return null; }
  if (!data || !data.success || !data.data) return null;
  const f = {};
  for (const [city, byStops] of Object.entries(data.data)) {
    let min = Infinity;
    for (const v of Object.values(byStops || {})) if (v && v.price > 0 && v.price < min) min = v.price;
    if (min !== Infinity) f[city] = Math.round(min);
  }
  const out = { origin, depart, at: new Date().toISOString().slice(0, 10), f };
  if (cache) {
    await cache.put(key, new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${TTL}` } }));
  }
  return out;
}
