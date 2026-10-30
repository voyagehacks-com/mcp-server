/* Trip Finder matching rules (2026-10-13), shared by BOTH bindings:
     - the website quiz (assets/js/trip-finder.js, bundled by Hugo js.Build)
     - the MCP tool find_destination (functions/mcp.js imports this file)
   so the site and an AI assistant can never give different answers to the
   same five questions. Pure functions: no DOM, no i18n. Reasons come back as
   codes ("warm", "style", "budget", ...) that each binding words itself.

   D is the data block built by layouts/_default/tripfinder.html:
     D.months[month] = [{p: path, h: avg high from that month guide}]
     D.styles[key]   = [path]
     D.places[path]  = {n, c, u, i, q, a (IATA), s: [best months], sk: [ski months],
                        cs: [extra city-break months], k: cost 1-3,
                        pz: {lo, mid, hi: [min, max] EUR per night, double room}, ll: [lat, lng],
                        fc: fare city code (CDG -> PAR) for ans.fares}
   ans.b = the budget. Since 2026-10-29 (second pass) a WHOLE-TRIP total in EUR for
           everyone travelling, flights and hotel together: "t1000-2000" ("t3000-0" =
           no top). Older links still work: a nightly room range "60-120" or a band
           ("budget" | "mid" | "upper" | "luxury"), both hotel-only.
   ans.n = nights (3 | 7 | 14), ans.w = party (rooms and travellers come from it).
   ans.fares (optional) = {CITY: cheapest recent round-trip fare per person, EUR}
           from functions/_fares.js. With it a total budget is split per place:
           what the flights cost the party, and what is left per room-night.
   ans.o (optional) = departure airport [lat, lng]: a place with no fare found is
           judged long-haul from its real distance (over 4,000 km), not the zone.
   ans.h (optional) = the traveller's ISO country, for the flight-distance penalty. */

export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export const TRIP_TYPES = ['beach', 'city', 'hiking', 'ski', 'campervan', 'adventure', 'digital-nomad'];
export const BUDGETS = ['budget', 'mid', 'luxury'];
/* The four nightly bands the quiz offers (EUR, whole room; 0 max = no top),
   and what the three old answers mean in them (2026-10-29). */
export const BANDS = [[0, 60], [60, 120], [120, 250], [250, 0]];
const LEGACY = { budget: [0, 60], mid: [60, 120], upper: [120, 250], luxury: [250, 0] };
/* Whole-trip bands, EUR PER TRAVELLER for one week, flights and hotel together.
   The quiz multiplies them by the party size and scales them to the trip length
   (tripBands), then stores the absolute total ("t1600-3200"), so a shared link
   keeps its meaning. Edges sit where the price data splits: a week at a lo-level
   room (~50 a night, shared) plus a short-haul fare is about 400 a head. */
export const TRIP_BANDS = [[0, 400], [400, 800], [800, 1600], [1600, 0]];
const WEEK_SCALE = { 3: 0.6, 7: 1, 14: 1.7 };
export function tripBands(w, nights) {
  const k = travellersFor(w) * (WEEK_SCALE[nightsFor(nights)] || 1);
  const r = (v) => (v < 1000 ? Math.round(v / 50) * 50 : Math.round(v / 100) * 100);
  return TRIP_BANDS.map((b) => [r(b[0] * k), b[1] ? r(b[1] * k) : 0]);
}
/* {tmin, tmax (Infinity = no top)} for a whole-trip answer, else null. */
export function tripTotal(b) {
  const m = /^t(\d{1,6})-(\d{1,6})$/.exec(String(b || ''));
  if (!m) return null;
  let r = [+m[1], +m[2]];
  if (r[1] && r[1] < r[0]) r = [r[1], r[0]];
  return { tmin: r[0], tmax: r[1] ? r[1] : Infinity };
}
function tierOf(min, max) { return max <= 70 ? 'budget' : min >= 200 ? 'luxury' : min >= 110 ? 'upper' : 'mid'; }
/* What a whole-trip total leaves per room-night once the party's flights are
   paid: the nightly range priceFit() judges a place on. fare = per person. */
export function stayRange(t, fare, nights, rooms, people) {
  const fl = (fare || 0) * people, k = nights * rooms;
  const min = Math.max(0, Math.round((t.tmin - fl) / k));
  const max = t.tmax === Infinity ? Infinity : Math.round((t.tmax - fl) / k);
  return { min: Math.max(0, Math.min(min, max)), max, tier: tierOf(min, max === Infinity ? Infinity : Math.max(max, 0)) };
}

/* {min, max (Infinity = no top), tier} from ans.b. The tier drives the cost-level
   fallback for places with no price data, and the budget/luxury boosts. */
export function budgetRange(b, ctx) {
  const t = tripTotal(b);
  /* Whole-trip total: the nightly range it leaves with a typical fare (ctx.fare,
     the median of the fares found; 0 = hotel only). Used for the tier and for
     places with no fare of their own. */
  if (t) {
    const c = ctx || {};
    return Object.assign(stayRange(t, c.fare || 0, nightsFor(c.n), roomsFor(c.w), travellersFor(c.w)), { total: t });
  }
  let r = LEGACY[b];
  if (!r) {
    const m = /^(\d{1,5})-(\d{1,5})$/.exec(String(b || ''));
    r = m ? [+m[1], +m[2]] : LEGACY.mid;
    if (r[1] && r[1] < r[0]) r = [r[1], r[0]];
  }
  const max = r[1] ? r[1] : Infinity;
  return { min: r[0], max, tier: tierOf(r[0], max) };
}

const LEVELS = ['lo', 'mid', 'hi'];
/* The place's price level closest to the traveller's range: {lv, r, fit}
   fit = "in" (overlaps), "over" (cheapest known level above the range),
   "under" (dearest known level below it). null = no price data. */
export function priceFit(pz, br) {
  if (!pz) return null;
  const lv = LEVELS.filter((k) => pz[k]);
  if (!lv.length) return null;
  let best = null, bestOv = -1;
  /* A level fits when its middle sits inside the range: a 45-300 spread does
     not make a place a shoestring pick just because its floor touches 60. */
  for (const k of lv) {
    const [a, b] = pz[k], m = (a + b) / 2;
    const ov = Math.min(b, br.max) - Math.max(a, br.min);
    if (m >= br.min && m <= br.max && ov > bestOv) { best = k; bestOv = ov; }
  }
  /* No level centred in the range: the one that overlaps it most still fits
     (a 60-120 budget between Mexico's 39-51 guesthouses and 99-216 3-stars). */
  if (!best) {
    for (const k of lv) {
      const [a, b] = pz[k], ov = Math.min(b, br.max) - Math.max(a, br.min);
      if (ov > 0 && ov > bestOv) { best = k; bestOv = ov; }
    }
  }
  if (best) return { lv: best, r: pz[best], fit: 'in', mid: pz.mid };
  const mid = (r) => (r[0] + r[1]) / 2;
  /* The cheapest level we know (lo, else mid) above the range = over budget. */
  const cheap = pz.lo ? 'lo' : pz.mid ? 'mid' : null;
  if (cheap && mid(pz[cheap]) > br.max) return { lv: cheap, r: pz[cheap], fit: 'over' };
  if (pz.hi && mid(pz.hi) < br.min) return { lv: 'hi', r: pz.hi, fit: 'under' };
  /* Partial data that cannot tell (only "hi" known, above a budget range): show
     the nearest level, judge cost by the level in trip_costs.yaml instead. */
  const near = lv.reduce((x, k) => (Math.abs(mid(pz[k]) - br.min) < Math.abs(mid(pz[x]) - br.min) ? k : x), lv[0]);
  return { lv: near, r: pz[near], fit: 'unknown' };
}
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
  upper: { 1: 0.5, 2: 0, 3: 0.3 },
  luxury: { 1: 1.3, 2: 0.5, 3: 0 }
};
/* Flight distance (2026-10-23). trip_costs.yaml prices the ground only, so a
   low-budget December city break from France returned Bangkok, Hanoi and Ho Chi
   Minh City: cheap to stay in, a long-haul fare for two to get there. With the
   traveller's country known, a place outside their home zone's short- and
   medium-haul reach drops by FAR_PENALTY tiers (same caps as the cost penalty,
   so it never beats the trip type or the season). Unknown country = no penalty. */
const FAR_PENALTY = { budget: 1, mid: 0.3, upper: 0, luxury: 0 };
const ZONE_OF_COUNTRY = {
  eu: 'AD AL AT BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GI GR HR HU IE IM IS IT JE GG LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM TR UA VA XK',
  mena: 'AE AM AZ BH DZ EG GE IQ IR JO KW LB LY MA OM PS QA SA SY TN YE',
  na: 'US CA MX GT BZ HN SV NI CR PA CU DO HT JM PR BS BB TT AG DM GD KN LC VC AW CW BM KY TC VG VI',
  sa: 'BR AR CL CO PE UY PY BO EC VE GY SR',
  asia: 'CN JP KR KP TW HK MO MN SG MY TH VN ID PH KH LA MM BN TL IN PK BD LK NP BT MV AF KZ UZ KG TJ TM',
  oc: 'AU NZ FJ PG NC PF WS TO VU SB',
  af: 'ZA NG KE GH ET TZ UG RW SN CI CM AO MZ ZM ZW BW NA MU MG SD SS SO DJ ER ML BF NE TD BJ TG GN SL LR GM GW CV CF CG CD GA GQ ST MW LS SZ KM SC MR'
};
const HOME_ZONE = {};
Object.keys(ZONE_OF_COUNTRY).forEach((z) => ZONE_OF_COUNTRY[z].split(' ').forEach((cc) => { HOME_ZONE[cc] = z; }));
/* Zones a traveller reaches without a long-haul fare. */
const NEAR = { eu: ['eu', 'mena'], mena: ['mena', 'eu'], na: ['na'], sa: ['sa'], asia: ['asia'], oc: ['oc', 'asia'], af: ['af'] };
export function placeZone(p) {
  if (/^europe\//.test(p)) return 'eu';
  if (/^(middle-east|africa\/(morocco|egypt|tunisia|cape-verde)|asia\/georgia)(\/|$)/.test(p)) return 'mena';
  if (/^africa\//.test(p)) return 'af';
  if (/^americas\/(usa|canada|mexico|costa-rica)(\/|$)/.test(p)) return 'na';
  if (/^americas\//.test(p)) return 'sa';
  if (/^asia\//.test(p)) return 'asia';
  if (/^oceania\//.test(p)) return 'oc';
  return '';
}
/* True when the place is long-haul from the traveller's country ('' = unknown). */
export function isFar(p, home) {
  const z = HOME_ZONE[String(home || '').toUpperCase()];
  const pz = placeZone(p);
  return !!(z && pz && NEAR[z].indexOf(pz) < 0);
}

/* The budget a place is over: shown on the card as "pricier than your budget".
   b = a tier; places with price data are judged on the prices instead (match()). */
export function overBudget(cost, b) { return cost === 3 && (b === 'budget' || b === 'mid'); }
/* Price-data penalty in tiers, on the COST_PENALTY scale: over the range =
   what a high cost level costs this budget; upscale rooms below the range =
   what a low cost level costs it. null = no verdict, use the cost level. */
function pricePenalty(pf, br) {
  if (!pf || pf.fit === 'unknown') return null;
  /* Only the budget hotels fit while a typical 3-star costs far more: it can
     be done, but other places suit this budget better. */
  if (pf.fit === 'in') return pf.lv === 'lo' && pf.mid && (pf.mid[0] + pf.mid[1]) / 2 > br.max * 1.6 ? 0.6 : 0;
  /* Over: as strong as a high cost level for this budget, more when the
     cheapest rooms cost double the top of the range. */
  if (pf.fit === 'over') return COST_PENALTY[br.tier][3] + ((pf.r[0] + pf.r[1]) / 2 > br.max * 2 ? 0.5 : 0);
  return COST_PENALTY[br.tier][1];
}

/* "flex" = the next two calendar months from `now`. */
export function monthsFor(m, now) {
  if (m !== 'flex') return [m];
  const n = (now || new Date()).getMonth();
  return [MONTHS[(n + 1) % 12], MONTHS[(n + 2) % 12]];
}

/* ans = {m: month slug | "flex", s: trip type, b: budget, w: party}.
   Returns up to 3 {p, high, mon, fit, why: [{k, m?}], cost, pricey, price: priceFit()}, best first. */
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
  /* A whole-trip total is judged per place: its own fare for the party comes off
     first. The global range (for the boosts and places with no fare) uses the
     median fare found, so a missing fare is neither free nor guessed. */
  const fares = ans.fares || null;
  const fareOf = (p) => { const pl = D.places[p] || {}; const f = fares && fares[pl.fc || pl.a]; return f > 0 ? f : null; };
  const known = fares ? Object.keys(D.places).map(fareOf).filter((x) => x).sort((a, b) => a - b) : [];
  const medFare = known.length ? known[Math.floor(known.length / 2)] : 0;
  const ctx = { n: ans.n, w: ans.w };
  const br = budgetRange(ans.b, Object.assign({ fare: medFare }, ctx));
  const total = br.total || null;
  const brOf = (p) => (total && fareOf(p) ? budgetRange(ans.b, Object.assign({ fare: fareOf(p) }, ctx)) : br);
  if (br.tier === 'budget') boost('budget');
  if (br.tier === 'luxury') boost('luxury');
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
    /* City breaks also count the months a guide dates as worth the trip on their
       own (`cs`: the Christmas markets in December, mild winter-sun cities). */
    const pl = D.places[c.p] || {};
    const s = ans.s === 'city' ? (pl.s || []).concat(pl.cs || []) : (pl.s || []);
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
  const pen = COST_PENALTY[br.tier];
  const far = FAR_PENALTY[br.tier];
  /* Price data (data/trip_prices.yaml) wins over the 1-3 cost level when it
     can tell whether the place fits the traveller's nightly range. */
  function costPen(p) {
    const pl = D.places[p] || {}, b = brOf(p);
    /* The flights alone eat the whole budget: as bad as the dearest place. */
    if (total && fareOf(p) && b.max <= 0) return COST_PENALTY[br.tier][3] + 0.5;
    const pp = pricePenalty(priceFit(pl.pz, b), b);
    /* A total budget with fares found for other places but not this one: the
       trip cannot be costed, so it ranks a little lower rather than free. */
    const nf = total && known.length && !fareOf(p) ? 0.3 : 0;
    return (pp != null ? pp : ((COST_PENALTY[b.tier] || pen)[pl.k || 2] || 0)) + nf;
  }
  function isPricey(p) {
    const pl = D.places[p] || {}, b = brOf(p);
    if (total && fareOf(p) && b.max <= 0) return true;
    const pf = priceFit(pl.pz, b);
    if (pf && pf.fit !== 'unknown') return pf.fit === 'over';
    return overBudget(pl.k || 2, b.tier);
  }
  function farOf(p) {
    if (total && fareOf(p)) return false;
    const ll = (D.places[p] || {}).ll;
    if (ans.o && ll && ll.length) return distanceKm(ans.o, ll) > 4000;
    return isFar(p, ans.h);
  }
  function rank(c) {
    const t = tier(c);
    /* A real fare already prices the distance: no zone penalty on top. */
    const r = t + costPen(c.p) + (farOf(c.p) ? far : 0);
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
    if (!res.some((r) => related(r.p, c.p))) {
      const pl = D.places[c.p] || {}, b = brOf(c.p), price = priceFit(pl.pz, b);
      res.push({ p: c.p, high: c.high, mon: c.mon, fit: fit(c), why: c.why, cost: pl.k || 2, pricey: isPricey(c.p), price,
        trip: tripCost(price, fareOf(c.p), ans.n, ans.w, total) });
    }
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

/* The whole trip in EUR for the card: flights for everyone (fare = cheapest
   recent round trip per person, null = not found) + the stay at the level shown.
   total = [min, max] only when both parts are known; fit against the budget. */
export function tripCost(price, fare, n, w, budget) {
  const nights = nightsFor(n), rooms = roomsFor(w), people = travellersFor(w);
  const stay = price ? [price.r[0] * rooms * nights, price.r[1] * rooms * nights] : null;
  const flights = fare ? fare * people : null;
  const tot = stay && flights != null ? [stay[0] + flights, stay[1] + flights] : null;
  let fit = null;
  if (tot && budget) fit = tot[0] > budget.tmax ? 'over' : tot[1] < budget.tmin ? 'under' : 'in';
  return { nights, rooms, people, fare: fare || null, flights, stay, total: tot, fit };
}
export function travellersFor(w) { return adultsFor(w) + childrenFor(w); }

export function adultsFor(w) { return { solo: 1, couple: 2, family: 2, friends: 4 }[w] || 2; }
/* Families travel as 2 adults + 2 children (family rooms, not doubles), four
   friends in two rooms. The nightly budget is per room, so two rooms double it. */
export function childrenFor(w) { return w === 'family' ? 2 : 0; }
export function roomsFor(w) { return w === 'friends' ? 2 : 1; }
export const NIGHTS = [3, 7, 14];
export function nightsFor(n) { n = parseInt(n, 10); return NIGHTS.indexOf(n) >= 0 ? n : 7; }

/* Great-circle distance from airport coordinates -> a nonstop flight time
   estimate in minutes (800 km/h cruise + 30 min for climb, approach, taxi),
   rounded to 15 min (30 over 6 h). An estimate, worded as one on the card. */
export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b[0] - a[0]) * rad / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin((b[1] - a[1]) * rad / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
export function flightMinutes(a, b) {
  if (!a || !b) return 0;
  const km = distanceKm(a, b);
  if (km < 150) return 0;
  const min = km / 800 * 60 + 30;
  const step = min > 360 ? 30 : 15;
  return Math.round(min / step) * step;
}

/* Travel dates: the 15th of the chosen month for `nights` (default 7; next year
   if that date is less than 3 days away), or a month from `now` when flexible. */
export function tripDates(m, now, nights) {
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
  return [iso(d), iso(new Date(d.getTime() + (nights || 7) * 864e5))];
}

/* booking.kayak.com route (ISO dates are mandatory there), or the plain landing. */
export function kayakTarget(origin, dest, dates, adults) {
  if (!origin || !dest || origin === dest) return 'https://booking.kayak.com/flights';
  return 'https://booking.kayak.com/flights/' + origin + '-' + dest + '/' + dates[0] + '/' + dates[1] +
    (adults > 1 ? '/' + adults + 'adults' : '') + '?sort=bestflight_a';
}

/* opts: {children, rooms, range: budgetRange()}. The nightly range becomes
   Booking.com's own "Your budget (per night)" filter (nflt=price=EUR-60-120-1,
   "max" for no top; checked in a real browser 2026-10-29). It covers every room
   booked, so two rooms double it. */
export function bookingTarget(name, dates, adults, opts) {
  const o = opts || {};
  let u = 'https://www.booking.com/searchresults.html?ss=' + encodeURIComponent(name) +
    '&checkin=' + dates[0] + '&checkout=' + dates[1] + '&group_adults=' + adults;
  if (o.children) u += '&group_children=' + o.children;
  if (o.rooms > 1) u += '&no_rooms=' + o.rooms;
  /* No filter when the flights alone use the whole budget (max <= 0). */
  if (o.range && o.range.max > 0) {
    const k = o.rooms > 1 ? o.rooms : 1;
    const lo = o.range.min * k, hi = o.range.max === Infinity ? 'max' : o.range.max * k;
    if (lo || hi !== 'max') u += '&nflt=' + encodeURIComponent('price=EUR-' + lo + '-' + hi + '-1');
  }
  return u;
}
