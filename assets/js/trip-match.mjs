/* Trip Finder matching rules (2026-10-13), shared by BOTH bindings:
     - the website quiz (assets/js/trip-finder.js, bundled by Hugo js.Build)
     - the MCP tool find_destination (functions/mcp.js imports this file)
   so the site and an AI assistant can never give different answers to the
   same five questions. Pure functions: no DOM, no i18n. Reasons come back as
   codes ("warm", "style", "budget", ...) that each binding words itself.

   D is the data block built by layouts/_default/tripfinder.html:
     D.months[month] = [{p: path, h: avg high from that month guide}]
     D.styles[key]   = [path]
     D.places[path]  = {n, c, u, i, q, a (IATA), s: [best months], sk: [ski months], k: cost 1-3, pr} */

export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export const TRIP_TYPES = ['beach', 'city', 'hiking', 'ski', 'campervan', 'adventure', 'digital-nomad'];
export const BUDGETS = ['budget', 'mid', 'luxury'];
export const PARTIES = ['solo', 'couple', 'family', 'friends'];

/* EU/EEA roaming applies inside these; everywhere else gets the eSIM link. */
const NON_EU_EUROPE = /^europe\/(albania|montenegro|serbia|switzerland|turkey|united-kingdom)(\/|$)/;
const SOUTH = /^(oceania\/|americas\/(argentina|chile)|africa\/south-africa)/;

function related(a, b) { return a === b || a.indexOf(b + '/') === 0 || b.indexOf(a + '/') === 0; }

/* How far a place's cost level (data/trip_costs.yaml: 1 low, 2 mid, 3 high)
   drops it in the ranking for each budget answer, in tiers (see tier() below).
   A step of more than one tier between levels makes a cheaper place with no
   season data beat a pricier one in season. Capped in match() so cost never
   beats the trip type or the season. */
const COST_PENALTY = {
  budget: { 1: 0, 2: 0.5, 3: 1.8 },
  mid: { 1: 0, 2: 0, 3: 1.3 },
  luxury: { 1: 1.3, 2: 0.5, 3: 0 }
};
/* The budget a place is over: shown on the card as "pricier than your budget". */
export function overBudget(cost, b) { return cost === 3 && (b === 'budget' || b === 'mid'); }

/* "flex" = the next two calendar months from `now`. */
export function monthsFor(m, now) {
  if (m !== 'flex') return [m];
  const n = (now || new Date()).getMonth();
  return [MONTHS[(n + 1) % 12], MONTHS[(n + 2) % 12]];
}

/* ans = {m: month slug | "flex", s: trip type, b: budget, w: party}.
   Returns up to 3 {p, high, mon, fit, why: [{k, m?}], cost, pricey}, best first. */
export function match(D, ans, now) {
  const months = monthsFor(ans.m, now);
  const cand = new Map();
  function add(p, pts, why, high, mon) {
    if (!D.places[p]) return null;
    let c = cand.get(p);
    if (!c) { c = { p, pts: 0, why: [], high: null, mon: null, style: false }; cand.set(p, c); }
    c.pts += pts;
    if (why && !c.why.some((w) => w.k === why.k)) c.why.push(why);
    if (high != null && c.high == null) { c.high = high; c.mon = mon; }
    return c;
  }
  months.forEach((m) => {
    (D.months[m] || []).forEach((row, i) => add(row.p, 4 - i * 0.15, { k: 'warm', m }, row.h, m));
  });
  /* Ski follows the hemisphere: no Queenstown in January. */
  const mi = MONTHS.indexOf(months[0]);
  const northWinter = mi <= 3 || mi >= 10;
  const okSki = (p) => ans.s !== 'ski' || (northWinter ? !SOUTH.test(p) : SOUTH.test(p));
  const whyStyle = { k: 'style', s: ans.s };
  /* Which candidates a style-list entry vouches for. Ski: the exact place only
     (Italy on the ski list must not make Rome a ski pick). Hiking, road trips,
     adventure and remote work: the place or a country that contains it, never
     a city under a listed country (Iceland is a road trip; Reykjavik, the warm
     month pick, is not). Beach and city lists name the towns themselves. */
  const fitsStyle = (p, sp) => ans.s === 'ski' ? p === sp
    : (ans.s === 'beach' || ans.s === 'city') ? related(p, sp)
      : p === sp || sp.indexOf(p + '/') === 0;
  (D.styles[ans.s] || []).filter(okSki).forEach((sp) => {
    let hit = false;
    for (const c of cand.values()) {
      if (fitsStyle(c.p, sp)) {
        c.pts += 4; c.style = true; hit = true;
        if (!c.why.some((w) => w.k === 'style')) c.why.push(whyStyle);
      }
    }
    if (!hit) { const c = add(sp, 3, whyStyle); if (c) c.style = true; }
  });
  function boost(key) {
    (D.styles[key] || []).forEach((sp) => {
      for (const c of cand.values()) {
        if (related(c.p, sp)) { c.pts += 1.5; if (!c.why.some((w) => w.k === key)) c.why.push({ k: key }); }
      }
    });
  }
  if (ans.b === 'budget') boost('budget');
  if (ans.b === 'luxury') boost('luxury');
  if (ans.w === 'solo') boost('solo');
  if (ans.w === 'family') boost('family');

  /* Season fit. A month pick is in season by definition (beach also needs a
     22 °C average high: summer guides list cool escapes too). Other places use
     the best months their own guide states (data/trip_seasons.yaml); no data =
     unknown, which the card words as "check the season in the guide". */
  const mset = months.map((m) => MONTHS.indexOf(m) + 1);
  function fit(c) {
    if (c.high != null) return ans.s === 'beach' && c.high < 22 ? 'out' : 'in';
    /* Ski uses the ski season each guide states (trip_seasons.yaml `ski`), so
       November no longer proposes Bansko or Hokkaido before the lifts open; no
       data = unknown, which falls back to the hemisphere rule. City breaks and
       remote work use the guides' best months too (2026-10-16): without them
       every month gave the same three cities. Outside them is only ranked last. */
    if (ans.s === 'ski') {
      const sk = (D.places[c.p] || {}).sk || [];
      return !sk.length ? 'unknown' : mset.some((n) => sk.indexOf(n) >= 0) ? 'in' : 'out';
    }
    /* Beach: a warm (24 °C+) pick in the month before or after counts. The July
       guide lists only cool escapes, and the Mediterranean guides' sweet spots
       skip July for crowds, which left Phuket in the monsoon as July's pick. */
    if (ans.s === 'beach' && mset.some((n) => [n - 2, n].some((j) => (D.months[MONTHS[(j + 12) % 12]] || []).some((r) => r.p === c.p && r.h >= 24)))) return 'in';
    const s = (D.places[c.p] || {}).s || [];
    if (!s.length) return 'unknown';
    return mset.some((n) => s.indexOf(n) >= 0) ? 'in' : 'out';
  }
  const summer = mi >= 4 && mi <= 8;
  /* Tiers, trip type first: on the list AND in season, then on the list with no
     season data, then warm month picks (beach only), then places outside their
     sweet spot, then (tier 4) off-type warm picks as a last-resort fill. Beach in the northern winter prefers
     really warm month picks (25 °C+) to beach-list places with no data. */
  function tier(c) {
    const f = fit(c);
    /* Too cool for a beach: never. Outside the guide's sweet spot: last, so it
       only fills a gap (those months are often just pricier, not bad). */
    /* Ski: no lifts outside the season, so never; in season beats no data. */
    if (ans.s === 'ski') return !c.style || f === 'out' ? 9 : f === 'in' ? 0 : 1;
    if (f === 'out') return c.high != null ? 9 : (c.style || ans.s === 'beach' ? 3 : 4);
    /* Off-type warm picks only fill what the trip type cannot: a road-trip
       country outside its sweet spot beats Porto just because July is warm. */
    if (ans.s !== 'beach' && !c.style) return 4;
    if (c.style && f === 'in') return 0;
    if (ans.s === 'beach') {
      if (c.style) return summer ? 1 : 2;
      return c.high != null && c.high >= 25 ? (summer ? 2 : 1) : 9;
    }
    return c.style ? 1 : 2;
  }
  /* Rank = tier + the cost penalty for this budget, capped so a place that
     fits the trip type stays above a mere warm-month pick (tier 2) and a place
     in season stays above one outside its sweet spot (tier 3). Without this the
     budget answer only nudged points inside a tier, and "mid" did nothing:
     2026-10-16 audit, 41% of mid-range results opened on a high-cost place. */
  const pen = COST_PENALTY[ans.b] || COST_PENALTY.mid;
  function rank(c) {
    const t = tier(c);
    const r = t + (pen[(D.places[c.p] || {}).k || 2] || 0);
    if (t <= 1 && c.style && ans.s !== 'beach') return Math.min(r, 1.95);
    if (t <= 2) return Math.min(r, 2.95);
    if (t === 3) return Math.min(r, 3.95);
    return r;
  }
  const out = [...cand.values()]
    .filter((c) => c.why.length && okSki(c.p) && tier(c) < 9)
    .sort((a, b) => rank(a) - rank(b) || b.pts - a.pts);
  /* One per place family: a country and its own city never both. */
  const res = [];
  for (const c of out) {
    if (res.length === 3) break;
    if (!res.some((r) => related(r.p, c.p))) res.push({ p: c.p, high: c.high, mon: c.mon, fit: fit(c), why: c.why, cost: (D.places[c.p] || {}).k || 2, pricey: overBudget((D.places[c.p] || {}).k || 2, ans.b) });
  }
  return res;
}

/* Which partner links a result carries, in display order. */
export function partnerKinds(path, ans) {
  const k = ['hotels', 'flights'];
  if (ans.s === 'city' || ans.s === 'adventure' || ans.w === 'family') k.push('tours');
  if (ans.s === 'campervan' || ans.s === 'hiking' || ans.w === 'family') k.push('cars');
  if (path.indexOf('europe/') !== 0 || NON_EU_EUROPE.test(path)) k.push('esim');
  if (ans.s === 'digital-nomad') k.push('vpn');
  return k;
}

export function adultsFor(w) { return { solo: 1, couple: 2, family: 2, friends: 4 }[w] || 2; }

/* Travel dates: the 15th of the chosen month for a week (next year if that date
   is less than 3 days away), or a month from `now` when the traveller is flexible. */
export function tripDates(m, now) {
  now = now || new Date();
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  let d;
  const mi = MONTHS.indexOf(m);
  if (mi < 0) d = new Date(now.getTime() + 30 * 864e5);
  else {
    d = new Date(now.getFullYear(), mi, 15);
    if (d.getTime() < now.getTime() + 3 * 864e5) d = new Date(now.getFullYear() + 1, mi, 15);
  }
  return [iso(d), iso(new Date(d.getTime() + 7 * 864e5))];
}

/* booking.kayak.com route (ISO dates are mandatory there), or the plain landing. */
export function kayakTarget(origin, dest, dates, adults) {
  if (!origin || !dest || origin === dest) return 'https://booking.kayak.com/flights';
  return 'https://booking.kayak.com/flights/' + origin + '-' + dest + '/' + dates[0] + '/' + dates[1] +
    (adults > 1 ? '/' + adults + 'adults' : '') + '?sort=bestflight_a';
}

export function bookingTarget(name, dates, adults) {
  return 'https://www.booking.com/searchresults.html?ss=' + encodeURIComponent(name) +
    '&checkin=' + dates[0] + '&checkout=' + dates[1] + '&group_adults=' + adults;
}
