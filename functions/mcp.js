/**
 * Cloudflare Pages Function, real MCP server at /mcp.
 *
 * Stateless Streamable-HTTP transport (JSON-RPC 2.0 over POST, single JSON
 * responses, no sessions, no SSE). Exposes the site's content and its
 * monetized booking/shopping links to MCP clients (Claude Desktop, ChatGPT
 * connectors, any agent framework):
 *
 *   content:  search_articles · get_article
 *   gear:     search_travel_gear · recommend_travel_gear   (Amazon Associates)
 *   verticals:get_flight_links · get_hotel_links · get_car_rental_links ·
 *             get_airport_transfer_links · get_esim_links ·
 *             get_travel_vpn_links · get_credit_card_links
 *   bundle:   get_booking_links (everything for one trip in one call)
 *   resources:llms.txt · auth.md · agent-skills index · api-catalog · sitemap
 *
 * Tool NAMES and TITLES deliberately never say "affiliate", agents route on
 * those strings and the word makes some of them shy away. The commercial
 * nature is stated plainly in every tool DESCRIPTION and in the disclosure
 * that ships with every response, which is what actually matters for
 * compliance (Amazon Associates / CJ / Travelpayouts all require disclosure at
 * the point the link is presented, not in the tool's name).
 *
 * Two profiles share this code: the default (/mcp) exposes all 12 tools; the
 * "research" profile (/mcp?profile=research) drops get_travel_vpn_links and
 * get_credit_card_links, whose links land on a subscription signup and a
 * financial-product application, which OpenAI's app submission guidelines
 * restrict. See docs/mcp/MCP.md.
 *
 * Affiliate IDs, the CJ region maps (13 regions: na, dach, cee, benelux, uk,
 * espt, mea, apac, au, br, latam, it, nordics), the CJ partner links
 * (params.cj.partners: getyourguide, vueling, budgetair, ihg, nordvpn, airserbia,
 * airindia, carla, hotelscom, undercovertourist, virginatlantic, epidemicsound,
 * allegro) and the Amex links are
 * mirrored from hugo.yaml
 * (params.travelpayouts / params.cj.booking / params.cj.partners / params.amazon /
 * params.amex). This file is deployed as-is, not built by Hugo, so KEEP THEM
 * IN SYNC when hugo.yaml changes. The travel-gear product catalog is NOT
 * mirrored: it is read live from /<lang>/gear.json, which Hugo generates from
 * the articles' `products:` front matter (layouts/_default/index.gearjson.json).
 * search_articles reads Hugo's per-language search index (/<lang>/index.json).
 *
 * Content ships in 10 languages: en, de, fr, es, it, pl, ja, nl, pt, zh
 * (Czech was switched off 2026-10-03; its content stays in the repo)
 * (LANGS below is the single source of truth, and feeds every tool's `lang`
 * enum). Keep it in sync with hugo.yaml, functions/index.js LANGS and
 * static/.well-known/mcp/server-card.json.
 */

import { htmlToMarkdown } from './html-to-markdown.js';
// Trip Finder matching rules, shared with the website quiz (assets/js/trip-finder.js),
// so /<lang>/trip-finder/ and find_destination always give the same three picks.
import { MONTHS, TRIP_TYPES, PARTIES, NIGHTS, match as tripMatch, partnerKinds, adultsFor, childrenFor, roomsFor, nightsFor, budgetRange, tripTotal, flightMinutes, tripDates, kayakTarget, bookingTarget } from '../assets/js/trip-match.mjs';
import { cheapFares } from './_fares.js';
// MCP Apps view (in-chat UI) for find_destination.
import { TRIP_APP_URI, TRIP_APP_HTML, TRIP_APP_META } from './_mcp-app.js';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LANGS = ['en', 'de', 'fr', 'es', 'it', 'pl', 'ja', 'nl', 'pt', 'zh'];
const SITE = 'https://voyagehacks.com';

// ── Affiliate configuration (mirror of hugo.yaml) ──────────────────────────
const TP_MARKER = '732448';
const TP_CURRENCY = 'eur';

// params.travelpayouts.affiliate: links WITHOUT a tp.media wrapper are not
// commission-tracked yet (program not approved for this account); they are
// still the right recommendation, they just earn nothing.
const TP = {
  airalo: 'https://tp.media/r?marker=732448&p=8310&u=https%3A%2F%2Fwww.airalo.com%2F&campaign_id=541',
  yesim: 'https://tp.media/r?marker=732448&p=5998&u=https%3A%2F%2Fyesim.app%2F&campaign_id=224',
  saily: 'https://tp.media/r?marker=732448&p=8979&u=https%3A%2F%2Fsaily.com%2F&campaign_id=629',
  drimsim: 'https://tp.media/r?marker=732448&p=2762&u=https%3A%2F%2Fdrimsim.com%2F&campaign_id=102',
  vpn: 'https://refer-nordvpn.com/QHoFXBlfHCr',
  economybookings: 'https://tp.media/r?marker=732448&p=2018&u=https%3A%2F%2Fwww.economybookings.com%2F&campaign_id=10',
  qeeq: 'https://tp.media/r?marker=732448&p=4845&u=https%3A%2F%2Fwww.qeeq.com%2F&campaign_id=172',
  localrent: 'https://tp.media/r?marker=732448&p=2043&u=https%3A%2F%2Flocalrent.com%2F&campaign_id=87',
  getrentacar: 'https://tp.media/r?marker=732448&p=5996&u=https%3A%2F%2Fwww.getrentacar.com%2F&campaign_id=222',
  bikesbooking: 'https://tp.media/r?marker=732448&p=1767&u=https%3A%2F%2Fbikesbooking.com%2F&campaign_id=57',
  kiwitaxi: 'https://tp.media/r?marker=732448&p=647&u=https%3A%2F%2Fwww.kiwitaxi.com%2F&campaign_id=1',
  welcomepickups: 'https://tp.media/r?marker=732448&p=8919&u=https%3A%2F%2Fwww.welcomepickups.com%2F&campaign_id=627',
  gettransfer: 'https://tp.media/r?marker=732448&p=4439&u=https%3A%2F%2Fgettransfer.com%2F&campaign_id=147',
  airhelp: 'https://tp.media/r?marker=732448&p=9139&u=https%3A%2F%2Fwww.airhelp.com%2F&campaign_id=120',
  ekta: 'https://tp.media/r?marker=732448&p=5869&u=https%3A%2F%2Fektatraveling.com&campaign_id=225',
};

// Booking.com via CJ. Keep in sync with params.cj.booking in hugo.yaml.
const CJ_CLICK_BASE = 'https://www.anrdoezrs.net/click-101807574-';
const CJ_REGIONS = {
  na:      { deeplink: '17293132', taxis: '17322565', cars: '17288983', attractions: '17288984' },
  dach:    { deeplink: '14082404', taxis: '17322522', cars: '17122733', attractions: '17254617' },
  cee:     { deeplink: '14312907', taxis: '17322543', cars: '17122732', attractions: '17254616' },
  benelux: { deeplink: '13397436', taxis: '17322536', cars: '17122731', attractions: '17254615' },
  uk:      { deeplink: '15734754', taxis: '17322563', cars: '17122730', attractions: '17254657' },
  espt:    { deeplink: '15734352', taxis: '17322554', cars: '17122734', attractions: '17254651' },
  mea:     { deeplink: '15734197', taxis: '17322550', cars: '17122729', attractions: '17254656' },
  apac:    { deeplink: '17293139', taxis: '17322570', cars: '17289008', attractions: '17289009' },
  au:      { deeplink: '17293136', taxis: '17322577', cars: '17304773', attractions: '17289014' },
  br:      { deeplink: '17293138', taxis: '17322581', cars: '17288987', attractions: '17288988' },
  latam:   { deeplink: '17293137', taxis: '17322585', cars: '17288997', attractions: '17288999' },
  // Italy + Nordics: approved per the 2026-08-12 links.csv re-export. Italy's
  // Evergreen deep link browser-verified the same day (aid=818291 + cjevent).
  it:      { deeplink: '15734767', taxis: '17322558', cars: '17122736', attractions: '17254655' },
  nordics: { deeplink: '15734870', taxis: '17327180', cars: '17122739', attractions: '17254614' },
};
const COUNTRY_REGION = {
  US: 'na', CA: 'na',
  BR: 'br',
  MX: 'latam', AR: 'latam', CO: 'latam', CL: 'latam', PE: 'latam', UY: 'latam',
  PY: 'latam', BO: 'latam', EC: 'latam', VE: 'latam', CR: 'latam', PA: 'latam',
  GT: 'latam', DO: 'latam',
  AU: 'au',
  NZ: 'apac', JP: 'apac', KR: 'apac', CN: 'apac', HK: 'apac', TW: 'apac',
  SG: 'apac', MY: 'apac', TH: 'apac', VN: 'apac', PH: 'apac', ID: 'apac', IN: 'apac',
  LK: 'apac',
  DE: 'dach', AT: 'dach', CH: 'dach',
  IT: 'it',
  SE: 'nordics', NO: 'nordics', DK: 'nordics', FI: 'nordics', IS: 'nordics',
  NL: 'benelux', BE: 'benelux', LU: 'benelux',
  PL: 'cee', CZ: 'cee', SK: 'cee', HU: 'cee', RO: 'cee', BG: 'cee',
  HR: 'cee', SI: 'cee', RS: 'cee', BA: 'cee', ME: 'cee', MK: 'cee',
  AL: 'cee', EE: 'cee', LV: 'cee', LT: 'cee', UA: 'cee', MD: 'cee',
  GB: 'uk', IE: 'uk',
  ES: 'espt', PT: 'espt',
  AE: 'mea', SA: 'mea', QA: 'mea', KW: 'mea', BH: 'mea', OM: 'mea', JO: 'mea',
  EG: 'mea', MA: 'mea', TN: 'mea', DZ: 'mea', ZA: 'mea', NG: 'mea', KE: 'mea',
  TR: 'mea', RU: 'mea',
};
const LANG_REGION = { de: 'dach', cs: 'cee', pl: 'cee', es: 'espt', it: 'it', nl: 'benelux', ja: 'apac', pt: 'br', zh: 'apac' };

// CJ partner Evergreen Links, deep-link enabled, same ?sid=&url= mechanics as
// CJ_REGIONS' 'deeplink' ads. Keep in sync with params.cj.partners in hugo.yaml.
const CJ_PARTNERS = {
  getyourguide: '15735609', vueling: '15733900', ihg: '15734302',
  // Outdoor/adventure stores (Aug 2026): Kings Camo hunting + camping apparel,
  // Velocity Outdoor = Ravin / CenterPoint crossbows and archery.
  kingscamo: '15784057', velocityoutdoor: '15734445',
  // 2026-08-12 links.csv re-export: Air Serbia (Evergreen, deep-link enabled,
  // browser-verified), Carla Car Rental (Evergreen), Undercover Tourist
  // (Evergreen, discounted US theme-park tickets).
  airserbia: '15735227', carla: '17094338', undercovertourist: '15733832',
  // 2026-09-20 export: NordVPN (CID 4837117). Not an Evergreen Link (the
  // program ships none) but the "Nord VPN Deeplink" TEXT link, which CJ
  // describes as a deep link and which was verified to pass ?url= through
  // to go.nordvpn.net/aff_c with our sid as aff_sub4. Its click host is
  // anrdoezrs.net, which is CJ_CLICK_BASE already.
  nordvpn: '13914989',
  // 2026-10-01 export: Virgin Atlantic Airways UK, Epidemic Sound and
  // Allegro.pl, all Evergreen Links (curl-verified that day; CJ ids resolve on
  // any CJ click host, so CJ_CLICK_BASE serves them). Only Virgin Atlantic is
  // surfaced here (UK routes in get_flight_links); Allegro strips wrapped
  // query strings, so it gets no deep links anywhere.
  virginatlantic: '15735947', epidemicsound: '15735430', allegro: '15736846',
};
// Plain click-through TEXT links (NOT deep-link enabled: never append &url=,
// a non-deep-link ad would drop the target). airindia = "Air India: Homepage";
// hotelscom = "Hotels.com DACH Deeplink" (DE/AT/CH-targeted program).
const CJ_CLICK_PARTNERS = { airindia: '17102071', hotelscom: '17140575' };
function cjPartnerClickLink(partner, sid) {
  return `${CJ_CLICK_BASE}${CJ_CLICK_PARTNERS[partner]}?sid=${sid || 'mcp'}`;
}

// No Amazon links leave this server (2026-10-18). The Associates Program
// Policies forbid displaying links that carry our tag "on a site that is not
// your Site", and an MCP answer is displayed inside ChatGPT, Claude or another
// host, never on voyagehacks.com. Gear picks therefore link to the product's
// card on our own buying guide (#p-<asin>), where the reader clicks the Amazon
// button on our Site. The ASIN is still returned as a plain identifier.
const productAnchor = (guideUrl, asin) => `${guideUrl}#p-${String(asin).toLowerCase()}`;

// Stay22 Allez links (params.stay22.aid). Built server side with no API key;
// `campaign` is reported in Stay22 and must use underscores (a hyphen splits
// the label). Only named providers: the `roam` auto-pick is bot-walled and
// the `booking` provider would compete with our own CJ Booking.com link.
// Verified 2026-10-18: vrbo, expedia, hotelscom and agoda all 302 to the
// partner with pubref/tag voyagehacks-<campaign>.
const STAY22_AID = 'voyagehacks';
function stay22Link(provider, { address, checkin, checkout, adults, children }, campaign) {
  const p = new URLSearchParams({ aid: STAY22_AID, address });
  if (checkin && checkout) { p.set('checkin', checkin); p.set('checkout', checkout); }
  if (adults) p.set('adults', String(adults));
  if (children) p.set('children', String(children));
  p.set('campaign', campaign);
  return `https://www.stay22.com/allez/${provider}?${p.toString()}`;
}

// EconomyBookings destination pages, the same targets the car-rental hub's
// guide-cards use (content/en/car-rental/_index.md). Slugs are not derivable
// from a city name, so only these are deep-linked; anything else gets the
// EconomyBookings homepage.
const EB_TARGETS = {
  crete: 'https://www.economybookings.com/car-rental/europe/greece-crete-island',
  iceland: 'https://www.economybookings.com/car-rental/europe/iceland',
  lisbon: 'https://www.economybookings.com/car-rental/europe/portugal/lisbon',
  mallorca: 'https://www.economybookings.com/car-rental/europe/spain-balearic-islands/majorca',
  majorca: 'https://www.economybookings.com/car-rental/europe/spain-balearic-islands/majorca',
  morocco: 'https://www.economybookings.com/car-rental/africa/morocco',
  sicily: 'https://www.economybookings.com/car-rental/europe/italy/catania-sicily',
  tenerife: 'https://www.economybookings.com/car-rental/europe/spain-canary-islands/tenerife',
  algarve: 'https://www.economybookings.com/car-rental/europe/portugal/faro',
  faro: 'https://www.economybookings.com/car-rental/europe/portugal/faro',
  bali: 'https://www.economybookings.com/car-rental/asia/indonesia/bali',
};

// No referral links leave this server (2026-10-18). The Amex Germany
// Freundschaftswerbung terms allow referrals "ausschliesslich im privaten
// Bereich" and forbid commercial use, and Revolut's referral terms limit
// invites to people you know: a public API handing them to strangers breaks
// both. get_credit_card_links therefore returns the issuers' own product pages
// (no tracking) plus our guides. If an Amex/Revolut affiliate programme (e.g.
// financeAds) is approved, its tracked links can go here.
const AMEX_DE_PAGES = {
  platinum: 'https://www.americanexpress.com/de-de/kreditkarte/platinum-card/',
  gold: 'https://www.americanexpress.com/de-de/kreditkarte/goldcard/',
  green: 'https://www.americanexpress.com/de-de/kreditkarte/american-express-card/',
  payback: 'https://www.americanexpress.com/de-de/kreditkarte/payback-karte/',
  blue: 'https://www.americanexpress.com/de-de/kreditkarte/blue-card/',
};
const REVOLUT_PLANS = 'https://www.revolut.com/our-pricing-plans/';
// German Amex conditions, re-verified on americanexpress.com/de-de on 2026-09-13
// (docs/amex-revolut-de-facts-2026-08.md is the source of truth). Returned by
// get_credit_card_links for Germany so agents quote current numbers instead of
// stale training data (Gold went from 144 EUR to 240 EUR/year, Green Card gone,
// Platinum loses Lufthansa lounges on 2026-10-01).
const AMEX_DE_FACTS = {
  verified: '2026-09-13',
  currency: 'EUR',
  fx_fee: '2% on non-EUR transactions (all cards); ATM cash 4%, min 5 EUR',
  changes_oct_2026: 'From 2026-10-01: Platinum loses Lufthansa lounge access worldwide (access until 2026-09-30); new Platinum "Lounge on the Go" 6 x 20 EUR airport vouchers at FRA T1 and MUC T2 (2026-10-01 to 2027-03-31, max one per day); Platinum LODENFREY credit (2 x 50 EUR per half-year) needs a purchase of at least 200 EUR and re-activation.',
  cards: {
    platinum: { fee: '60 EUR/month = 720 EUR/year', public_welcome: 'up to 340 EUR statement credit (160 EUR after 6,000 EUR spend in 6 months + 180 EUR after a further 4,000 EUR)', credits: '650 EUR/year: 200 EUR travel (Amex Travel), 150 EUR dining, 200 EUR SIXT ride, 100 EUR LODENFREY (2 x 50 EUR, min. 200 EUR purchase from 2026-10-01)', perks: '1,550+ lounges (Global Lounge Collection incl. Priority Pass, one guest; Lufthansa lounges only until 2026-09-30), Lounge on the Go 6 x 20 EUR (FRA/MUC, Oct 2026 to Mar 2027), ALL Accor Gold, Hilton Honors Gold, Marriott Bonvoy Gold Elite, Condor/Marabu perks, full travel insurance, up to 7 cards' },
    gold: { fee: '20 EUR/month = 240 EUR/year (was 144 EUR until 2025; no free first year any more)', public_welcome: 'up to 200 EUR statement credit (80 EUR after 3,000 EUR + 120 EUR after a further 2,000 EUR in 6 months)', credits: '450 EUR/year per Amex: 20 EUR/month SIXT+, 2x25 EUR SIXT rent, 5 EUR/month FREENOW, 100 EUR LODENFREY', perks: 'metal card (Gold or Rose), travel insurance incl. family, GHA Discovery Gold, no lounge access' },
    green: { fee: 'American Express Card (successor of the retired Green Card): 5 EUR/month = 60 EUR/year; if annual spend exceeds 9,000 EUR the following year is free', public_welcome: '40 EUR statement credit after 2,000 EUR spend in 6 months', credits: 'none', perks: 'Membership Rewards included, 1 point per EUR, one supplementary card' },
    blue: { fee: '0 EUR', public_welcome: '25 EUR statement credit after 1,200 EUR spend in 6 months', credits: 'none', perks: 'Membership Rewards optional at 30 EUR/year (+5,000 starter points); earns nothing without it' },
    payback: { fee: '0 EUR (also sold as the dm PAYBACK American Express Karte, same 0 EUR and 1,000 bonus points)', public_welcome: '1,000 PAYBACK bonus points', credits: 'none', perks: '1 PAYBACK point per 3 EUR (not at petrol stations) on top of partner points, all supplementary cards free' },
  },
};


// Affiliate disclosure. Shipped with every commercial response and named in
// every commercial tool description: Amazon Associates, CJ and Travelpayouts
// all require disclosure at the point the link is presented.
export const DISCLOSURE =
  'Some links returned by this tool are affiliate links. VoyageHacks may earn a commission ' +
  'from qualifying bookings or purchases at no additional cost to the user. Disclose this ' +
  'when presenting the links.';

// Factual notes appended to link responses. Deliberately NOT instructions to
// the model about how to behave: Anthropic and OpenAI both reject tool output
// and descriptions that direct the assistant rather than describe the data.
const LINK_NOTE =
  'These are ordinary traveler-facing search and product pages. No signup is required and ' +
  'the price is the same as going direct.';

// Icons (spec 2025-11-25) for the server and every tool; hosts and directories show them.
const ICONS = [
  { src: 'https://voyagehacks.com/apple-touch-icon.png', mimeType: 'image/png', sizes: ['180x180'] },
  { src: 'https://voyagehacks.com/favicon.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
];
const SERVER_INFO = {
  name: 'voyagehacks',
  title: 'VoyageHacks',
  version: '2.3.0',
  description: 'Multilingual travel guides, destination ideas by month, travel gear picks and booking links.',
  websiteUrl: 'https://voyagehacks.com/en/mcp-server/',
  icons: ICONS,
};

// Tool profiles. The default profile exposes every tool. The "research"
// profile (GET/POST /mcp?profile=research) drops the two tools whose links
// land on a subscription signup (NordVPN) or a financial-product application
// (American Express), which is what OpenAI's app submission guidelines
// restrict. Same code, same data, no second deployment.
// Profiles restrict which tools are served, for hosts whose policies do not allow
// parts of the full set. The URL is the only switch: ?profile=<name>. An unknown
// value falls back to the full set, so a typo can never silently serve fewer tools.
//
// "research" hides the two tools whose links land on a subscription signup or a
// financial-product application.
//
// "guides" additionally hides every booking tool, leaving article research and the
// travel gear catalog. Its only outbound purchases are physical goods on Amazon,
// which is what the ChatGPT plugin submission attests to: OpenAI's app guidelines
// say plugins "may conduct commerce only for physical goods".
const PROFILE_EXCLUDED = {
  research: new Set(['get_travel_vpn_links', 'get_credit_card_links']),
  guides: new Set([
    'get_flight_links',
    'get_hotel_links',
    'get_car_rental_links',
    'get_airport_transfer_links',
    'get_esim_links',
    'get_travel_vpn_links',
    'get_credit_card_links',
    'get_booking_links',
  ]),
};

// find_destination is served on the guides profile too, without booking links:
// picks, the destination guides and packing picks only. Hotel and flight links
// are services, which the ChatGPT plugin attestation for that profile rules out.
const LINKLESS_PROFILES = new Set(['guides']);

const INSTRUCTIONS =
  'VoyageHacks is a multilingual travel guide site with about 680 published guides in each of ' +
  '10 languages (en, de, fr, es, it, pl, ja, nl, pt, zh), covering flights, airline reviews, ' +
  'hotels, destinations, car rental, trains, airport transfers, eSIM, travel VPN, travel credit ' +
  'cards, travel gear and month-by-month "where to go" guides.\n\n' +
  'What the tools provide, by topic:\n' +
  '- Article research and citation: search_articles, then get_article for the full text.\n' +
  '- Travel products and packing: search_travel_gear (one category), recommend_travel_gear (a kit ' +
  'built from a trip description).\n' +
  '- Booking and shopping links: get_flight_links, get_hotel_links, get_car_rental_links, ' +
  'get_airport_transfer_links, get_esim_links, get_travel_vpn_links, get_credit_card_links, and ' +
  'get_booking_links for several categories of one trip in a single call.\n' +
  '- Where to go: find_destination suggests three destinations from a month, a trip type, a budget ' +
  'and who is travelling, with dated hotel and flight links (the site\'s trip finder).\n\n' +
  'Each vertical tool also returns up to four matching VoyageHacks guides in the requested ' +
  'language, with canonical URLs that can be cited as sources.\n\n' +
  'Scope and limits: the tools return published editorial content and search links. They do not ' +
  'return live prices, live availability or star ratings, and they cannot make a booking or ' +
  'complete a purchase. Many of the returned links are affiliate links: VoyageHacks may earn a ' +
  'commission at no additional cost to the user, which should be disclosed when the links are ' +
  'presented. No authentication is required.';

// Served for ?profile=guides. Same corpus and the same gear catalog, no booking tools.
const GUIDES_INSTRUCTIONS =
  'VoyageHacks is a multilingual travel guide site with about 680 published guides in each of ' +
  '10 languages (en, de, fr, es, it, pl, ja, nl, pt, zh), covering flights, airline reviews, ' +
  'hotels, destinations, car rental, trains, airport transfers, eSIM, travel credit cards, ' +
  'travel gear and month-by-month "where to go" guides.\n\n' +
  'What the tools provide:\n' +
  '- Article research and citation: search_articles, then get_article for the full text, its ' +
  'canonical URL, its publication date and the date it was last updated.\n' +
  '- Travel products and packing: search_travel_gear (one category), recommend_travel_gear (a kit ' +
  'built from a trip description, one product per category).\n' +
  '- Where to go: find_destination suggests three destinations from a month, a trip type, a budget ' +
  'and who is travelling, each with its VoyageHacks guide and packing picks (the site\'s trip finder).\n\n' +
  'Scope and limits: the tools return published editorial content and links to product pages. ' +
  'They do not return live prices, live availability, star ratings or review counts, and they ' +
  'cannot make a booking, place an order or complete a purchase. This profile serves no booking ' +
  'tools at all: for flights, hotels, car rental, transfers or eSIM, answer from the guides and ' +
  'send the reader to the guide rather than to a booking site.\n\n' +
  'The travel gear catalog is VoyageHacks\' own editorial selection, roughly 320 physical ' +
  'products picked across about 50 published buying guides. It is not a search of all of Amazon. ' +
  'Product links open the product on its VoyageHacks buying guide, which links to Amazon with ' +
  'affiliate links: VoyageHacks may earn a commission at no additional cost to the user, which ' +
  'should be disclosed when the products are presented. No authentication is required.';

// ── Tool definitions ───────────────────────────────────────────────────────
const LANG_PROP = {
  type: 'string',
  enum: LANGS,
  description: 'Language of the VoyageHacks guides returned. One of: en, de, fr, es, it, pl, cs, ja, nl, pt, zh. Defaults to "en".',
};
const COUNTRY_PROP = {
  type: 'string',
  pattern: '^[A-Za-z]{2}$',
  description: "ISO 3166-1 alpha-2 country the traveler is booking from, e.g. US, DE, GB. Selects the regional Booking.com programme. Defaults to the caller's geolocation, then to the language default.",
};

// Every tool here reads published data and builds URLs. Nothing writes, and
// nothing has a side effect outside the response, so readOnlyHint is true and
// destructiveHint is false throughout. openWorldHint is true because the
// returned links point at third-party booking and retail sites.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const GUIDES_SCHEMA = {
  type: 'array',
  description: 'Matching VoyageHacks guides that can be cited as sources.',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      url: { type: 'string' },
      section: { type: 'string' },
    },
    required: ['title', 'url'],
  },
};

const PRODUCT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    category: { type: 'string', description: 'Product category, taken from the buying guide it appears in.' },
    badge: { type: 'string', description: 'Editorial label, e.g. "Best overall".' },
    whyThisOne: { type: 'string', description: 'The published reason this product was picked.' },
    asin: { type: 'string' },
    productUrl: { type: 'string', description: 'The product on its VoyageHacks buying guide (#p-<asin>), where the Amazon buy button is.' },
    retailer: { type: 'string', description: 'Where the product is sold. Always "Amazon".' },
    reviewGuide: {
      type: 'object',
      properties: { title: { type: 'string' }, url: { type: 'string' }, updated: { type: 'string' } },
      required: ['title', 'url'],
    },
  },
  required: ['name', 'asin', 'productUrl', 'retailer', 'reviewGuide'],
};

const LINKS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { label: { type: 'string' }, url: { type: 'string' } },
    required: ['label', 'url'],
  },
};

export const TOOLS = [
  {
    name: 'search_articles',
    title: 'Search VoyageHacks travel guides',
    annotations: { title: 'Search VoyageHacks travel guides', ...READ_ONLY },
    description:
      'Full-text search across the VoyageHacks travel guides, about 680 published pages per language, ' +
      'covering flights, airline reviews, hotels, destinations, car rental, trains, airport transfers, ' +
      'eSIM, travel VPN, travel credit cards, travel gear and month-by-month "where to go" guides. ' +
      'Returns ranked matches with the title, canonical URL, section and a matching excerpt for each. ' +
      'Useful when a travel question needs published prices, comparisons, best-time-to-visit advice or ' +
      'step-by-step detail that can be attributed to a source URL. It searches VoyageHacks content only: not the wider web, not live fares or hotel ' +
      'availability, and it returns no booking or product links.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 300, description: 'Search terms, e.g. "cheap hotels rome" or "esim japan". Matched against titles, keywords, tags and article text.' },
        lang: LANG_PROP,
        section: {
          type: 'string',
          enum: ['flights', 'airlines', 'hotels', 'destinations', 'car-rental', 'trains', 'transfers', 'esim', 'vpn', 'credit-cards', 'travel-gear', 'adventure', 'travel-types', 'when-to-go', 'styles', 'answers', 'checklists', 'deals'],
          description: 'Restrict results to one site section. Omit to search every section.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum results to return. Defaults to 5.' },
      },
      required: ['query'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        lang: { type: 'string' },
        section: { type: ['string', 'null'] },
        resultCount: { type: 'integer' },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              url: { type: 'string', description: 'Canonical URL, safe to cite.' },
              section: { type: 'string' },
              lang: { type: 'string' },
              snippet: { type: 'string' },
            },
            required: ['title', 'url'],
          },
        },
      },
      required: ['query', 'lang', 'results'],
    },
  },
  {
    name: 'get_article',
    title: 'Read a VoyageHacks guide as Markdown',
    annotations: { title: 'Read a VoyageHacks guide as Markdown', ...READ_ONLY },
    description:
      'Fetch one VoyageHacks page by URL or site path (for example ' +
      '"/en/hotels/best-budget-hotels-in-rome/") and return its body as Markdown, together with the ' +
      'title, canonical URL, language, section, publication date and last-updated date read from the ' +
      'page itself. Useful when the full text of a guide is needed to quote figures ' +
      'accurately, and when a source needs to be cited with a real date. Only HTML pages on ' +
      'voyagehacks.com can be read: the tool cannot fetch other websites, data files or images, and ' +
      'very long pages are truncated with a marker at the cut.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', maxLength: 400, description: 'Page URL or site path on voyagehacks.com, e.g. https://voyagehacks.com/de/esim/esim-japan/ or /de/esim/esim-japan/.' },
      },
      required: ['url'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        title: { type: ['string', 'null'] },
        url: { type: 'string', description: 'Canonical URL.' },
        lang: { type: ['string', 'null'] },
        section: { type: ['string', 'null'] },
        published: { type: ['string', 'null'], description: 'ISO date, or null if the page declares none.' },
        updated: { type: ['string', 'null'], description: 'ISO date, or null if the page declares none.' },
        excerpt: { type: ['string', 'null'], description: "The page's meta description." },
        markdown: { type: 'string' },
        truncated: { type: 'boolean' },
        source: { type: 'string', description: 'Attribution string for citations.' },
      },
      required: ['url', 'markdown', 'source'],
    },
  },
  {
    name: 'search_travel_gear',
    title: 'Search the VoyageHacks travel gear catalog',
    annotations: { title: 'Search the VoyageHacks travel gear catalog', ...READ_ONLY },
    description:
      'Search the VoyageHacks travel gear catalog: about 320 products that appear as picks in roughly ' +
      '50 published buying guides, including carry-on backpacks, packing cubes and compression bags, ' +
      'universal travel adapters, GaN chargers, airline-compliant power banks, luggage trackers, neck ' +
      'pillows, earplugs and eye masks, toiletry and makeup bags, travel-size bottles, travel routers, ' +
      'translation earbuds and camping and outdoor gear. Each result returns the product name, its ' +
      'category, the published reason it was picked, its Amazon ASIN and a link to the product on the ' +
      "VoyageHacks buying guide that reviews it, where it can be bought on Amazon. Useful when a user asks which travel product to buy, or what " +
      'to pack for a trip and names a category or a destination.  ' +
      'This is the VoyageHacks editorial catalog, not a search of all of Amazon: products outside the ' +
      'published guides are not findable here, and prices, star ratings, review counts and stock are ' +
      'not available and are never returned. The guides carry Amazon affiliate links: VoyageHacks may ' +
      'earn a commission from qualifying purchases at no additional cost to the buyer, which should ' +
      'be disclosed when the products are presented.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 300, description: 'What the traveler needs, e.g. "power bank for a long flight", "packing cubes", "adapter for Japan".' },
        lang: LANG_PROP,
        limit: { type: 'integer', minimum: 1, maximum: 12, description: 'Maximum products to return. Defaults to 6.' },
      },
      required: ['query'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        lang: { type: 'string' },
        hub: { type: 'string' },
        productCount: { type: 'integer' },
        products: { type: 'array', items: PRODUCT_SCHEMA },
        disclosure: { type: 'string' },
      },
      required: ['query', 'lang', 'products', 'disclosure'],
    },
  },
  {
    name: 'recommend_travel_gear',
    title: 'Build a travel gear kit for a trip',
    annotations: { title: 'Build a travel gear kit for a trip', ...READ_ONLY },
    description:
      'Turn a trip description into a packing and gear kit drawn from the VoyageHacks travel gear ' +
      'catalog: one product per category, each with the published reason it was picked, its Amazon ' +
      'ASIN and a link to the product on the VoyageHacks guide that reviews it, where it can be bought ' +
      'on Amazon. Takes a plain-language ' +
      'trip summary ("10 days in Japan in October, carry-on only, long-haul red-eye, working ' +
      'remotely") plus optional structured hints (destination, trip length in days, season, ' +
      'activities, luggage constraint, traveler type, budget), all of which are used to weight which ' +
      'categories make the kit. Answers questions of the form "what should I pack for X", "what gear ' +
      'do I need for Y" and "I only have carry-on, what should I bring". It draws on the VoyageHacks ' +
      'editorial catalog, not a search of all of Amazon, and returns published picks only: prices, ' +
      'star ratings, review counts and stock are not available and are never returned, and it ' +
      'produces no clothing sizes and no itinerary.  The guides carry Amazon ' +
      'affiliate links: VoyageHacks may earn a commission from qualifying purchases at no ' +
      'additional cost to the buyer, which should be disclosed when the products are presented.',
    inputSchema: {
      type: 'object',
      properties: {
        trip: { type: 'string', maxLength: 600, description: 'Free-text trip description: destination, length, style, flight type, season, gadgets needed.' },
        destination: { type: 'string', maxLength: 120, description: 'Optional country, region or city, e.g. Japan, Iceland, Thailand.' },
        trip_length_days: { type: 'integer', minimum: 1, maximum: 365, description: 'Optional trip length in days.' },
        season: { type: 'string', enum: ['spring', 'summer', 'autumn', 'winter', 'rainy', 'dry'], description: 'Optional season or climate at the destination.' },
        activities: {
          type: 'array',
          maxItems: 10,
          items: { type: 'string', maxLength: 60 },
          description: 'Optional activities, e.g. ["hiking", "photography", "remote work", "camping", "beach"].',
        },
        luggage: {
          type: 'string',
          enum: ['carry_on_only', 'personal_item_only', 'checked_bag', 'backpack'],
          description: 'Optional luggage constraint. carry_on_only and personal_item_only weight the packing and compression categories.',
        },
        traveler_type: {
          type: 'string',
          enum: ['solo', 'couple', 'family', 'business', 'backpacker', 'digital_nomad'],
          description: 'Optional traveler type.',
        },
        budget: { type: 'string', enum: ['budget', 'mid_range', 'premium'], description: 'Optional budget level. Recorded in the response; the catalog carries no prices, so it does not filter products.' },
        lang: LANG_PROP,
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum items in the kit. Defaults to 6.' },
      },
      required: ['trip'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        trip: { type: 'string' },
        lang: { type: 'string' },
        hub: { type: 'string' },
        criteria: { type: 'object', description: 'Structured hints that were applied.' },
        kit: { type: 'array', items: PRODUCT_SCHEMA },
        disclosure: { type: 'string' },
      },
      required: ['trip', 'lang', 'kit', 'disclosure'],
    },
  },
  {
    name: 'get_flight_links',
    title: 'Get flight search links for a route',
    annotations: { title: 'Get flight search links for a route', ...READ_ONLY },
    description:
      'Build a flight search link on Booking.com Flights for a route and optional dates, and return up ' +
      'to four VoyageHacks guides on fares, budget airlines and baggage rules for that trip. Pass ' +
      'origin and destination as IATA codes for a prefilled route search; without both, the link opens ' +
      'the general flight search page. Also returns a delayed or cancelled flight compensation link ' +
      '(AirHelp), a Vueling link for short-haul Europe, and, when the route touches their hubs, direct ' +
      'links for Air Serbia (Belgrade) and Air India. The Booking.com link is regionalized to the ' +
      "traveler's country. Useful when a trip involves air travel and the user wants somewhere to " +
      'compare fares. It returns search links only: no live fares, seat availability or schedules, no booking and no airport transfers. Affiliate links: ' +
      'VoyageHacks may earn a commission at no additional cost to the traveler, which should be ' +
      'disclosed when the links are presented.',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', maxLength: 40, description: 'Origin IATA city or airport code, e.g. LON, NYC, BER.' },
        destination: { type: 'string', maxLength: 40, description: 'Destination IATA city or airport code, e.g. HKT, TYO, ROM.' },
        depart_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Outbound date, YYYY-MM-DD. Omitted dates default to about a month ahead.' },
        return_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Return date, YYYY-MM-DD. Omit for a one-way search.' },
        passengers: { type: 'integer', minimum: 1, maximum: 9, description: 'Number of adult passengers. Defaults to 1.' },
        country: COUNTRY_PROP,
        lang: LANG_PROP,
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        disclosure: { type: 'string' },
        region: { type: 'string' },
        route: { type: 'object' },
        flightSearch: { type: 'string' },
        flightCompensation: { type: 'string' },
        vueling: { type: 'string' },
        airSerbia: { type: 'string' },
        airIndia: { type: 'string' },
        virginAtlantic: { type: 'string' },
        guides: GUIDES_SCHEMA,
      },
      required: ['disclosure', 'flightSearch', 'guides'],
    },
  },
  {
    name: 'get_hotel_links',
    title: 'Get hotel search links for a city',
    annotations: { title: 'Get hotel search links for a city', ...READ_ONLY },
    description:
      'Build a Booking.com search link for a city or property, with optional check-in and check-out ' +
      'dates, guest count and room count, the same search on Expedia, Vrbo (apartments and holiday ' +
      'homes) and Agoda, plus an IHG brand search link (Holiday Inn, ' +
      'InterContinental, Crowne Plaza) and up to four VoyageHacks guides on the best areas and ' +
      'best-value stays there. The Booking.com link is regionalized to the traveler\'s country. Useful ' +
      'when a user asks where to stay, or about hotels, hostels or apartments in a place. It returns ' +
      'search links only: no live room rates, no availability check, no reviews and no reservation. ' +
      'Affiliate links: VoyageHacks may earn a commission at no additional cost to the traveler, which ' +
      'should be disclosed when the links are presented.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', maxLength: 120, description: 'City, region or property name to search, e.g. Rome, Phuket, Hotel Kossak.' },
        checkin: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Check-in date, YYYY-MM-DD. Used only when checkout is also given.' },
        checkout: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Check-out date, YYYY-MM-DD.' },
        adults: { type: 'integer', minimum: 1, maximum: 30, description: 'Number of adults. Defaults to 2.' },
        children: { type: 'integer', minimum: 0, maximum: 10, description: 'Number of children. Defaults to 0.' },
        rooms: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of rooms. Defaults to 1.' },
        country: COUNTRY_PROP,
        lang: LANG_PROP,
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        disclosure: { type: 'string' },
        region: { type: 'string' },
        city: { type: ['string', 'null'] },
        checkin: { type: ['string', 'null'] },
        checkout: { type: ['string', 'null'] },
        adults: { type: 'integer' },
        children: { type: 'integer' },
        rooms: { type: 'integer' },
        hotelSearch: { type: 'string' },
        moreStays: LINKS_SCHEMA,
        ihg: { type: 'string' },
        guides: GUIDES_SCHEMA,
      },
      required: ['disclosure', 'hotelSearch', 'guides'],
    },
  },
  {
    name: 'get_car_rental_links',
    title: 'Get car and scooter rental links',
    annotations: { title: 'Get car and scooter rental links', ...READ_ONLY },
    description:
      'Return car and scooter rental comparison links for a destination: EconomyBookings and QEEQ for ' +
      'worldwide comparison, Localrent and GetRentacar for local suppliers with lower deposits in ' +
      'southern Europe, Georgia, the Balkans and Asia, BikesBooking for scooters and motorbikes, and ' +
      'Booking.com Cars, plus up to four VoyageHacks car-rental guides for that country covering real ' +
      'prices, insurance excess and one-way fees. Useful when a user mentions renting a car, a road ' +
      'trip, driving abroad, or an island or countryside trip that needs a vehicle. These are ' +
      'comparison landing pages: dates and the pickup point are entered on the provider site, so ' +
      'pickup_date and dropoff_date are echoed in the response for context rather than embedded in ' +
      'the links. No live quotes, no vehicle availability and no reservation. Affiliate links: ' +
      'VoyageHacks may earn a commission at no additional cost to the traveler, which should be ' +
      'disclosed when the links are presented.',
    inputSchema: {
      type: 'object',
      properties: {
        destination: { type: 'string', maxLength: 120, description: 'Country, island or city where the car is picked up, e.g. Iceland, Crete, Lisbon.' },
        pickup_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Pickup date, YYYY-MM-DD. Echoed in the response; entered on the provider site.' },
        dropoff_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Drop-off date, YYYY-MM-DD. Echoed in the response; entered on the provider site.' },
        country: COUNTRY_PROP,
        lang: LANG_PROP,
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        disclosure: { type: 'string' },
        region: { type: 'string' },
        destination: { type: ['string', 'null'] },
        pickup: { type: ['string', 'null'] },
        dropoff: { type: ['string', 'null'] },
        providers: LINKS_SCHEMA,
        bookingCars: { type: 'string' },
        guides: GUIDES_SCHEMA,
      },
      required: ['disclosure', 'providers', 'guides'],
    },
  },
  {
    name: 'get_airport_transfer_links',
    title: 'Get airport transfer and taxi links',
    annotations: { title: 'Get airport transfer and taxi links', ...READ_ONLY },
    description:
      'Return pre-booked airport transfer links: Booking.com Taxis (fixed price, 100+ countries), ' +
      'Kiwitaxi, Welcome Pickups and GetTransfer, plus up to four VoyageHacks guides on getting from ' +
      'that airport to the city centre and what a fair fare looks like. Useful when a user asks how to ' +
      'get from an airport, about taxi or transfer prices, or plans a late-night arrival. It returns ' +
      'booking pages for private and shared transfers: no live quotes, no public transport timetables, ' +
      'and no ride-hailing dispatch. Affiliate links: VoyageHacks may earn a commission at no ' +
      'additional cost to the traveler, which should be disclosed when the links are presented.',
    inputSchema: {
      type: 'object',
      properties: {
        airport: { type: 'string', maxLength: 120, description: 'Airport name or IATA code, e.g. FCO, Bangkok Suvarnabhumi.' },
        city: { type: 'string', maxLength: 120, description: 'Destination city, e.g. Rome.' },
        country: COUNTRY_PROP,
        lang: LANG_PROP,
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        disclosure: { type: 'string' },
        region: { type: 'string' },
        airport: { type: ['string', 'null'] },
        city: { type: ['string', 'null'] },
        providers: LINKS_SCHEMA,
        guides: GUIDES_SCHEMA,
      },
      required: ['disclosure', 'providers', 'guides'],
    },
  },
  {
    name: 'get_esim_links',
    title: 'Get travel eSIM links for a destination',
    annotations: { title: 'Get travel eSIM links for a destination', ...READ_ONLY },
    description:
      'Return travel eSIM store links (Airalo, covering 200+ countries, plus Yesim, Saily and ' +
      'Drimsim) together with up to four VoyageHacks eSIM guides for that destination covering real ' +
      'per-GB prices, coverage, setup steps and which phones support eSIM. Useful when a user asks ' +
      'about mobile data abroad, SIM cards, roaming charges, staying online on a trip or tethering a ' +
      'laptop. It returns store pages: no live plan prices, no coverage check for a specific handset, ' +
      'and no purchase or activation. Affiliate links: VoyageHacks may earn a commission at no ' +
      'additional cost to the traveler, which should be disclosed when the links are presented.',
    inputSchema: {
      type: 'object',
      properties: {
        destination: { type: 'string', maxLength: 120, description: 'Country or region the data plan is for, e.g. Japan, Europe, USA.' },
        lang: LANG_PROP,
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        disclosure: { type: 'string' },
        destination: { type: ['string', 'null'] },
        providers: LINKS_SCHEMA,
        guides: GUIDES_SCHEMA,
      },
      required: ['disclosure', 'providers', 'guides'],
    },
  },
  {
    name: 'get_travel_vpn_links',
    title: 'Get travel VPN links',
    annotations: { title: 'Get travel VPN links', ...READ_ONLY },
    description:
      'Return the NordVPN signup link together with up to four VoyageHacks guides on whether a ' +
      'traveler actually needs a VPN, the real risks of hotel and airport Wi-Fi, and watching home ' +
      'streaming services abroad. Useful when a user raises public Wi-Fi safety, working remotely ' +
      'abroad, geo-blocked streaming or online banking while travelling. It returns a signup page and ' +
      'editorial guides: no live pricing, no server list and no account creation. Referral link: ' +
      'VoyageHacks may earn a commission at no additional cost to the user, which should be disclosed ' +
      'when the link is presented.',
    inputSchema: { type: 'object', properties: { lang: LANG_PROP } },
    outputSchema: {
      type: 'object',
      properties: {
        disclosure: { type: 'string' },
        vpn: { type: 'string' },
        guides: GUIDES_SCHEMA,
      },
      required: ['disclosure', 'vpn', 'guides'],
    },
  },
  {
    name: 'get_credit_card_links',
    title: 'Get travel credit card links',
    annotations: { title: 'Get travel credit card links', ...READ_ONLY },
    description:
      "Return the official American Express Germany card pages (Platinum, Gold, American Express Card, " +
      'Payback and Blue) and the Revolut plans page, the current German fee and welcome-offer ' +
      'figures verified against americanexpress.com, and up to four VoyageHacks guides on points ' +
      'value, lounge access, foreign-transaction fees, Amex compared with Revolut and ' +
      'country-by-country availability. Useful when a user asks about travel rewards, points, miles, ' +
      'lounge access, which card to pay with abroad or foreign-transaction fees. It covers American ' +
      'Express only: it is not a comparison of all issuers, gives no eligibility or approval decision, ' +
      'no credit-score check and no application. Card terms change frequently and vary by market, so ' +
      'figures should be attributed to the issuer page or the linked guide. The card links are plain ' +
      'issuer pages, not affiliate or referral links.',
    inputSchema: {
      type: 'object',
      properties: {
        country: COUNTRY_PROP,
        card: { type: 'string', enum: ['platinum', 'gold', 'green', 'payback', 'blue'], description: 'Restrict the response to one American Express card. "green" is the American Express Card, successor to the retired Green Card.' },
        lang: LANG_PROP,
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        disclosure: { type: 'string' },
        country: { type: ['string', 'null'] },
        card: { type: ['string', 'null'] },
        cards: LINKS_SCHEMA,
        facts: { type: ['object', 'null'], description: 'Verified fee and welcome-offer figures, currently published for Germany only. Null elsewhere.' },
        guides: GUIDES_SCHEMA,
      },
      required: ['disclosure', 'cards', 'guides'],
    },
  },
  {
    name: 'get_booking_links',
    title: 'Get booking links for a whole trip',
    annotations: { title: 'Get booking links for a whole trip', ...READ_ONLY },
    description:
      'Return one set of booking and shopping links covering a whole trip in a single call: flight ' +
      'search, hotel search, airport taxi, attractions and tours, car rental, travel eSIM, travel VPN ' +
      'and the travel gear section, all regionalized to the traveler. Accepts route IATA codes, a city ' +
      'and trip dates, so the flight and hotel links are prefilled. The "include" parameter selects ' +
      'which categories are returned, so a trip with no driving can leave out car rental. Useful when ' +
      'a user is planning a trip end to end and wants every option in one place.  It returns search links only: no live prices, no availability and ' +
      'no booking. Affiliate links: VoyageHacks may earn a commission at no additional cost to the ' +
      'traveler, which should be disclosed when the links are presented.',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', maxLength: 40, description: 'Origin IATA city or airport code for flights, e.g. LON.' },
        destination: { type: 'string', maxLength: 40, description: 'Destination IATA city or airport code, e.g. HKT.' },
        city: { type: 'string', maxLength: 120, description: 'City name for the hotel, tours and attractions searches, e.g. Phuket.' },
        depart_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Outbound flight date and hotel check-in, YYYY-MM-DD.' },
        return_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Return flight date and hotel check-out, YYYY-MM-DD.' },
        adults: { type: 'integer', minimum: 1, maximum: 9, description: 'Number of adult travelers. Defaults to 2 for hotels and 1 for flights.' },
        include: {
          type: 'array',
          maxItems: 9,
          items: { type: 'string', enum: ['flights', 'hotels', 'airport_taxi', 'attractions', 'tours', 'car_rental', 'esim', 'vpn', 'travel_gear'] },
          description: 'Categories to return. Omit for all of them.',
        },
        country: COUNTRY_PROP,
        lang: LANG_PROP,
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        disclosure: { type: 'string' },
        region: { type: 'string' },
        trip: { type: 'object' },
        included: { type: 'array', items: { type: 'string' } },
        flights: { type: 'string' },
        hotels: { type: 'string' },
        hotelsElsewhere: { type: 'string', description: 'The same hotel search on Expedia (via Stay22).' },
        airportTaxi: { type: 'string' },
        attractions: { type: 'string' },
        toursAndActivities: { type: 'string' },
        carRental: { type: 'string' },
        esim: { type: 'string' },
        vpn: { type: 'string' },
        travelGear: { type: 'string' },
        guides: GUIDES_SCHEMA,
      },
      required: ['disclosure', 'included'],
    },
  },
  {
    name: 'find_destination',
    title: 'Suggest where to travel for a month and trip type',
    annotations: { title: 'Suggest where to travel for a month and trip type', ...READ_ONLY },
    description:
      'Suggest three destinations for a trip from five answers: the month (or "flexible"), the kind of ' +
      'trip (beach, city break, hiking, ski, road trip, adventure or working remotely), the budget, who ' +
      'is travelling and, optionally, the departure airport. Picks come only from VoyageHacks\' own ' +
      'where-to-go month guides and travel-style lists, with the average high temperature each month ' +
      'guide states, the reasons it fits, the destination guide to cite, and booking links for that trip: ' +
      'hotels and flights dated in the chosen month, plus tours, car rental or an eSIM where they fit. ' +
      'This is the same matching as the trip finder on voyagehacks.com. Useful when a user asks where ' +
      'to go, for holiday ideas for a month, or for a destination that suits a family, a couple or a ' +
      'budget. Each answer also carries three packing picks for that kind of trip, linked to the ' +
      'VoyageHacks buying guides. When the month or the trip type is missing it returns no picks, only ' +
      'the questions that are still open with their allowed answers (needsInput). ' +
      'It does not return live prices or availability and cannot book. Affiliate links: ' +
      'VoyageHacks may earn a commission at no additional cost to the traveler, which should be ' +
      'disclosed when the links are presented.',
    _meta: { ui: { resourceUri: TRIP_APP_URI }, 'ui/resourceUri': TRIP_APP_URI, 'openai/outputTemplate': TRIP_APP_URI, 'openai/widgetAccessible': true },
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', enum: [...MONTHS, 'flexible'], description: 'Travel month in English, lowercase, or "flexible" for the next two months.' },
        trip_type: { type: 'string', enum: TRIP_TYPES, description: 'Kind of trip. "campervan" means a road trip; "digital-nomad" means working remotely.' },
        budget: { type: 'string', maxLength: 12, pattern: '^(budget|mid|upper|luxury|\\d{1,5}-\\d{1,5})$', description: 'Nightly hotel budget for the whole room, in euros: "budget" (under 60), "mid" (60 to 120), "upper" (120 to 250), "luxury" (250 and up), or the traveller\'s own range as "min-max", e.g. "80-150" ("300-0" = no upper limit). Convert other currencies to euros first. Defaults to mid.' },
        trip_budget: { type: 'string', maxLength: 13, pattern: '^\\d{1,6}-\\d{1,6}$', description: 'Budget for the WHOLE trip in euros, everyone travelling, return flights and hotel together, as "min-max", e.g. "1500-3000" ("4000-0" = no upper limit). Preferred over budget: with an origin, each pick is costed with the cheapest recent round-trip fare found from there. Convert other currencies to euros first.' },
        nights: { type: 'integer', enum: NIGHTS, description: 'Trip length in nights for the dated links, the stay estimate and the trip total. Defaults to 7.' },
        travelers: { type: 'string', enum: PARTIES, description: 'Who is travelling. Defaults to couple.' },
        origin: { type: 'string', maxLength: 40, description: 'Departure IATA city or airport code for the flight links, e.g. LON. Optional.' },
        country: COUNTRY_PROP,
        lang: LANG_PROP,
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        disclosure: { type: 'string' },
        tripFinder: { type: 'string', description: 'The same answers on the VoyageHacks trip finder page.' },
        needsInput: {
          type: 'array',
          description: 'Present when month or trip_type was missing: the questions to ask, each with its allowed answers. No picks are returned until they are answered.',
          items: {
            type: 'object',
            properties: { field: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, required: { type: 'boolean' } },
            required: ['field', 'question', 'options'],
          },
        },
        answers: { type: 'object', description: 'The answers used: month, trip_type, budget, travelers, origin.' },
        packing: {
          type: 'array',
          description: 'Three packing picks for this kind of trip, each linked to its VoyageHacks buying guide.',
          items: PRODUCT_SCHEMA,
        },
        picks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              country: { type: ['string', 'null'] },
              guide: { type: 'string' },
              image: { type: ['string', 'null'], description: 'Photo of the destination on voyagehacks.com.' },
              avgHighC: { type: ['number', 'null'] },
              season: { type: 'string', description: 'in: the guides recommend this month; unknown: check the guide; out: outside the guide\'s sweet spot.' },
              reasons: { type: 'array', items: { type: 'string' } },
              hotelPerNightEUR: { type: ['array', 'null'], items: { type: 'number' }, description: 'Typical double-room price per night [min, max] in euros at the level closest to the budget, from the VoyageHacks guides and published averages; null when no figure is published. Not a live price.' },
              hotelLevel: { type: ['string', 'null'], description: 'lo (budget hotel or guesthouse), mid (3 to good 4-star) or hi (4 to 5-star).' },
              stayEstimateEUR: { type: ['array', 'null'], items: { type: 'number' }, description: 'hotelPerNightEUR x nights x rooms.' },
              budgetFit: { type: ['string', 'null'], description: 'in: a hotel level fits the budget; over: even the cheapest level costs more; under: the dearest level costs less.' },
              flightEstimate: { type: ['string', 'null'], description: 'Nonstop flight time estimated from the great-circle distance, e.g. "about 2 h 30". Not a schedule.' },
              fareEUR: { type: ['number', 'null'], description: 'Cheapest round-trip economy fare per person from the origin that Aviasales users found for the travel month in the last few days (Travelpayouts data API). Not a live quote; null when none was found or no origin was given.' },
              tripTotalEUR: { type: ['array', 'null'], items: { type: 'number' }, description: 'fareEUR x travellers + stayEstimateEUR: the whole trip [min, max]; null when either part is unknown.' },
              tripBudgetFit: { type: ['string', 'null'], description: 'in, over or under the trip_budget, from tripTotalEUR.' },
              bestMonths: { type: 'array', items: { type: 'integer' }, description: 'Months (1-12) the destination guide recommends.' },
              links: LINKS_SCHEMA,
            },
            required: ['name', 'guide', 'reasons', 'links'],
          },
        },
      },
      required: ['disclosure', 'picks'],
    },
  },
];
for (const tool of TOOLS) {
  tool.icons = ICONS;
  tool.description = tool.description.replace(/ {2,}/g, ' ');
}

const FIND_DESTINATION_GUIDES_DESCRIPTION =
  'Suggest three destinations for a trip from the month (or "flexible"), the kind of trip (beach, ' +
  'city break, hiking, ski, road trip, adventure or working remotely), the budget and who is ' +
  'travelling. Picks come only from VoyageHacks\' own where-to-go month guides and travel-style ' +
  'lists, with the average high temperature each month guide states, the reasons it fits, the ' +
  'destination guide to read, and three packing picks for that kind of trip linked to the ' +
  'VoyageHacks buying guides. This is the same matching as the trip finder on voyagehacks.com. ' +
  'When the month or the trip type is missing it returns no picks, only the questions that are ' +
  'still open with their allowed answers (needsInput). It returns no booking links, no live prices ' +
  'and no availability, and cannot book. The buying guides carry Amazon affiliate links: ' +
  'VoyageHacks may earn a commission at no additional cost to the buyer.';

// Prompts: ready-made starting points that clients list as slash commands.
// Each names the tool it leads to, so a profile that hides the tool hides it too.
const PROMPTS = [
  {
    name: 'where_to_go',
    title: 'Where should I travel?',
    description: 'Destination ideas for a month and a kind of trip, from the VoyageHacks trip finder.',
    tool: 'find_destination',
    arguments: [
      { name: 'month', description: 'Travel month, or "flexible".', required: false },
      { name: 'trip_type', description: 'beach, city, hiking, ski, campervan, adventure or digital-nomad.', required: false },
    ],
    text: (a) => `Help me decide where to travel${a.month ? ` in ${a.month}` : ''}${a.trip_type ? ` for a ${a.trip_type} trip` : ''}. ` +
      'Use the VoyageHacks find_destination tool; if it needs more answers, ask me its questions first. ' +
      'Show the three picks with their guides and booking links.',
  },
  {
    name: 'plan_trip',
    title: 'Plan a trip',
    description: 'Guides plus flight, hotel and activity links for one destination.',
    tool: 'get_booking_links',
    arguments: [
      { name: 'destination', description: 'City or country, e.g. Lisbon.', required: true },
      { name: 'days', description: 'Trip length in days.', required: false },
    ],
    text: (a) => `Plan a ${a.days ? `${a.days}-day ` : ''}trip to ${a.destination || 'my destination'}. ` +
      'Use VoyageHacks search_articles for the best guides to cite, then get_booking_links for flights, hotels and things to do. ' +
      'Ask me for dates and my departure airport if you need them.',
  },
  {
    name: 'pack_for_trip',
    title: 'What should I pack?',
    description: 'A packing kit for a trip from the VoyageHacks buying guides.',
    tool: 'recommend_travel_gear',
    arguments: [{ name: 'trip', description: 'The trip in a sentence, e.g. "10 days in Japan in November, carry-on only".', required: true }],
    text: (a) => `What should I pack for this trip: ${a.trip || '(ask me about the trip)'}? Use VoyageHacks recommend_travel_gear and link each pick to its guide.`,
  },
];

const RESOURCES = [
  { uri: `${SITE}/llms.txt`, name: 'llms.txt', title: 'Site overview for LLMs', mimeType: 'text/plain', path: '/llms.txt' },
  { uri: `${SITE}/auth.md`, name: 'auth.md', title: 'Authentication policy (none required)', mimeType: 'text/markdown', path: '/auth.md' },
  { uri: `${SITE}/.well-known/agent-skills/index.json`, name: 'agent-skills', title: 'Agent skills index (content + booking actions)', mimeType: 'application/json', path: '/.well-known/agent-skills/index.json' },
  { uri: `${SITE}/.well-known/api-catalog`, name: 'api-catalog', title: 'API catalog (RFC 9727 linkset)', mimeType: 'application/linkset+json', path: '/.well-known/api-catalog' },
  { uri: `${SITE}/en/gear.json`, name: 'gear-catalog', title: 'Travel gear catalog (products + ASINs)', mimeType: 'application/json', path: '/en/gear.json' },
  { uri: `${SITE}/sitemap.xml`, name: 'sitemap', title: 'XML sitemap', mimeType: 'application/xml', path: '/sitemap.xml' },
  // Served inline, not fetched: the in-chat trip finder view (MCP Apps).
  { uri: TRIP_APP_URI, name: 'trip-finder-app', title: 'Trip finder view (MCP Apps)', mimeType: 'text/html;profile=mcp-app', inline: TRIP_APP_HTML, _meta: TRIP_APP_META },
];

// ── Limits ─────────────────────────────────────────────────────────────────
// The endpoint is public and unauthenticated, so every input is bounded and
// nothing unbounded is ever echoed back. Without these a 400 KB `query` used
// to come back as a 243 KB response, and get_article on /ja/index.json
// returned 1.35 MB: both are amplification vectors, not just untidy output.
export const LIMITS = {
  body: 262144,          // 256 KB of JSON-RPC per request
  batch: 25,             // messages in one JSON-RPC batch
  freeText: 600,         // `trip` and other long free-text fields
  shortText: 300,        // `query`
  name: 120,             // city / destination / airport names
  url: 400,              // get_article `url`
  articleChars: 60000,   // Markdown returned by get_article
  responseChars: 120000, // any tool's text content
  fetchMs: 6000,         // upstream asset fetch
  langCache: 4,          // languages held in the per-isolate index/gear caches
};

// ── Small helpers ──────────────────────────────────────────────────────────
// clean() also strips control characters: user input is echoed into response
// text, and ANSI/newline injection there is a cheap way to fake tool output.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (v, max = LIMITS.name) =>
  (typeof v === 'string' ? v.replace(CONTROL_CHARS, ' ').trim().slice(0, max) : '');
const iata = (v) => clean(v, 40).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(clean(v, 12)) ? clean(v, 12) : '');
const ddmm = (iso) => (iso ? iso.slice(8, 10) + iso.slice(5, 7) : '');
const intArg = (v, def, min, max) => Math.min(Math.max(parseInt(v, 10) || def, min), max);
const capText = (s, max = LIMITS.responseChars) =>
  (s.length > max ? `${s.slice(0, max)}\n\n[truncated at ${max} characters]` : s);

// Optional string list, each entry bounded, used for `activities`.
function stringList(v, maxItems = 10) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => clean(x, 60)).filter(Boolean).slice(0, maxItems);
}

// Fetch a site asset with a timeout, so a stalled upstream cannot hold the
// request open for the whole Function budget.
async function fetchAsset(context, path) {
  const origin = new URL(context.request.url).origin;
  return context.env.ASSETS.fetch(`${origin}${path}`, { signal: AbortSignal.timeout(LIMITS.fetchMs) });
}

// A tool failure the model should see and react to, rather than a protocol
// error the client swallows. MCP puts execution errors in the result.
function toolFailure(message) {
  const err = new Error(message);
  err.toolError = true;
  return err;
}

// Per-isolate fixed-window rate limit. Cloudflare spreads traffic over many
// isolates, so this is a safety net against one client hammering one colo,
// not a global quota: the real control is a Cloudflare WAF rate-limiting rule
// on /mcp (see docs/mcp/SECURITY.md). Fails open when no client IP is known.
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 90;
const rateBuckets = new Map();

export function rateLimited(request) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return false;
  const now = Date.now();
  if (rateBuckets.size > 5000) {
    for (const [key, b] of rateBuckets) if (now - b.start > RATE_WINDOW_MS) rateBuckets.delete(key);
  }
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_MAX;
}

// Keep a per-isolate cache to a few languages so a crawler walking all 11
// cannot grow an isolate's heap without bound.
function cachePut(cache, key, value) {
  if (cache.size >= LIMITS.langCache) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

// Callers cap their own inputs; tokenize only needs a backstop so a long
// concatenation (trip text plus structured hints) is not silently cut short.
function tokenize(query) {
  return clean(query, LIMITS.freeText * 2).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
}

function pickLang(v) {
  const lang = clean(v).toLowerCase();
  if (!lang) return 'en';
  if (!LANGS.includes(lang)) throw invalidParams(`lang must be one of: ${LANGS.join(', ')}`);
  return lang;
}

// Car rental for a place: the EconomyBookings destination page when we have
// one (Travelpayouts deep link, same mechanics as tp-url.html's `target`).
function carRentalLink(place) {
  const key = clean(place, 60).toLowerCase().split(',')[0].trim();
  const target = EB_TARGETS[key];
  return target ? TP.economybookings.replace('u=https%3A%2F%2Fwww.economybookings.com%2F', `u=${encodeURIComponent(target)}`) : TP.economybookings;
}

function resolveRegion(context, countryArg, lang) {
  const cfCountry = (context.request.cf && context.request.cf.country) || '';
  const country = (clean(countryArg).toUpperCase() || cfCountry).slice(0, 2);
  return COUNTRY_REGION[country] || LANG_REGION[lang] || 'na';
}

function cjLink(region, kind, target, sid) {
  // sid = CJ sub-id, reported per transaction, so MCP-driven bookings are
  // attributable per tool in the Commission Detail report. Regions missing a
  // slot (Brazil has no Attractions link) fall back to the NA program's ad.
  const ad = (CJ_REGIONS[region] || CJ_REGIONS.na)[kind] || CJ_REGIONS.na[kind];
  return `${CJ_CLICK_BASE}${ad}?sid=${sid || 'mcp'}&url=${encodeURIComponent(target)}`;
}

function cjRegionLink(region, kind, sid) {
  // Homepage/text ad slot (e.g. cars, attractions): no deep-link url param,
  // just the click-through, sid still reported for attribution.
  const ad = (CJ_REGIONS[region] || CJ_REGIONS.na)[kind] || CJ_REGIONS.na[kind];
  return `${CJ_CLICK_BASE}${ad}?sid=${sid || 'mcp'}`;
}

function cjPartnerLink(partner, target, sid) {
  // CJ_PARTNERS: deep-link Evergreen Links keyed by partner, not region.
  return `${CJ_CLICK_BASE}${CJ_PARTNERS[partner]}?sid=${sid || 'mcp'}&url=${encodeURIComponent(target)}`;
}

function bookingSearchUrl({ city, checkin, checkout, adults, children = 0, rooms }) {
  if (!city) return 'https://www.booking.com/index.html';
  const p = new URLSearchParams({ ss: city });
  if (checkin && checkout) {
    p.set('checkin', checkin);
    p.set('checkout', checkout);
  }
  p.set('group_adults', String(adults));
  p.set('group_children', String(children));
  p.set('no_rooms', String(rooms));
  return `https://www.booking.com/searchresults.html?${p.toString()}`;
}

// Booking.com Flights deep link. Booking retired flights.booking.com
// (2026-08-03: every URL there, and www.booking.com/flights/*, redirects to
// the Booking homepage); its flights product now lives on the Kayak white
// label booking.kayak.com, which the CJ deeplink passes through unchanged
// with tracking intact (verified: landing URL carries aid=8133101 +
// cjevent). Bare IATA codes; ISO dates are MANDATORY in the path (dateless
// shapes error-redirect), so missing dates default to +30/+37 days from
// request time. Destination-only searches do not exist on Kayak: no origin
// means the generic /flights landing.
// Wrap the result in cjLink(region, 'deeplink', …) to make it commissionable.
function bookingFlightsUrl({ origin, dest, depart, ret, pax }) {
  if (!origin || !dest) return 'https://booking.kayak.com/flights';
  const iso = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
  let path = `${origin}-${dest}/${depart || iso(30)}`;
  // One-way only when the caller explicitly gave a depart date and no return.
  if (ret || !depart) path += `/${ret || iso(37)}`;
  const adults = Number(pax || 1);
  if (adults > 1) path += `/${adults}adults`;
  return `https://booking.kayak.com/flights/${path}?sort=bestflight_a`;
}

// ── Article index (Hugo /<lang>/index.json), cached per isolate ────────────
const indexCache = new Map();

async function loadIndex(context, lang) {
  if (indexCache.has(lang)) return indexCache.get(lang);
  const res = await fetchAsset(context, `/${lang}/index.json`);
  if (!res.ok) throw toolFailure(`The search index for "${lang}" is unavailable (HTTP ${res.status}). Try lang "en".`);
  const raw = await res.json();
  const slim = raw.map((e) => ({
    title: e.title || '',
    permalink: e.permalink || '',
    summary: (e.summary || '').slice(0, 400),
    section: sectionOf(e.permalink || ''),
    haystack: `${e.title}\n${e.summary}\n${(e.content || '').slice(0, 20000)}`.toLowerCase(),
    content: (e.content || '').slice(0, 20000),
  }));
  return cachePut(indexCache, lang, slim);
}

function sectionOf(permalink) {
  const m = permalink.match(/^https?:\/\/[^/]+\/[a-z]{2}\/([^/]+)\//);
  return m ? m[1] : '';
}

function countOccurrences(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1 && n < 5; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function scoreEntries(entries, tokens) {
  const scored = [];
  for (const entry of entries) {
    const titleLower = entry.title.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      score += countOccurrences(titleLower, t) * 5;
      score += countOccurrences(entry.haystack, t);
    }
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Guides to cite alongside a booking link: best matches for `query` inside the
 * given sections, topped up with that section's newest articles so a vertical
 * tool always returns something to link.
 */
async function findGuides(context, lang, sections, query, limit = 4) {
  let index;
  try {
    index = await loadIndex(context, lang);
  } catch {
    return [];
  }
  const wanted = new Set(sections);
  const pool = index.filter((e) => wanted.has(e.section));
  if (!pool.length) return [];

  const tokens = tokenize(query);
  const picked = [];
  const seen = new Set();
  const push = (entry) => {
    if (seen.has(entry.permalink) || picked.length >= limit) return;
    seen.add(entry.permalink);
    picked.push({ title: entry.title, url: entry.permalink, section: entry.section });
  };

  if (tokens.length) for (const { entry } of scoreEntries(pool, tokens)) push(entry);
  // Prefer the primary section for the top-ups (sections[0] is the on-topic one).
  for (const entry of pool) if (entry.section === sections[0]) push(entry);
  for (const entry of pool) push(entry);
  return picked;
}

function guideLines(guides) {
  if (!guides.length) return '';
  return `\nVoyageHacks guides to cite:\n${guides.map((g) => `- ${g.title}: ${g.url}`).join('\n')}`;
}

function linkBlock(links) {
  return links.filter((l) => l && l.url).map((l) => `${l.label}: ${l.url}${l.note ? `\n    (${l.note})` : ''}`).join('\n');
}

function bookingResponse({ heading, links, guides, extra = '' }) {
  const text = [
    heading,
    '',
    linkBlock(links),
    extra,
    guideLines(guides),
    '',
    DISCLOSURE,
    LINK_NOTE,
  ].filter((s) => s !== '').join('\n');
  return text;
}

// ── search_articles ────────────────────────────────────────────────────────
async function searchArticles(context, { query, lang = 'en', section, limit = 5 } = {}) {
  query = clean(query, LIMITS.shortText);
  if (!query) throw invalidParams('query is required');
  lang = pickLang(lang);
  section = clean(section, 40).toLowerCase();
  limit = intArg(limit, 5, 1, 10);

  const all = await loadIndex(context, lang);
  const index = section ? all.filter((e) => e.section === section) : all;
  const tokens = tokenize(query);
  if (!tokens.length) throw invalidParams('query has no searchable terms');

  const results = scoreEntries(index, tokens).slice(0, limit).map(({ entry }) => {
    let snippet = entry.summary;
    const idx = entry.haystack.indexOf(tokens[0]);
    if (idx > entry.title.length + entry.summary.length) {
      const at = entry.content.toLowerCase().indexOf(tokens[0]);
      if (at !== -1) snippet = `…${entry.content.slice(Math.max(0, at - 80), at + 160).trim()}…`;
    }
    return { title: entry.title, url: entry.permalink, section: entry.section || undefined, lang, snippet };
  });

  return {
    structured: { query, lang, ...(section ? { section } : {}), resultCount: results.length, results },
    text: results.length
      ? `${results.length} VoyageHacks guide(s) matching "${query}" (${lang}${section ? `, section ${section}` : ''}). The URLs are canonical and can be cited.\n\n${
          results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n')}`
      : `No VoyageHacks guides matched "${query}" in "${lang}"${section ? ` within section "${section}"` : ''}. Broader terms, another section or another language may match.`,
  };
}

// ── get_article ────────────────────────────────────────────────────────────
// The path is restricted to rendered HTML pages. Without this, get_article
// happily returned any static asset: /ja/index.json came back as a 1.35 MB
// response through the Markdown converter, which is both a context bomb for
// the client and CPU amplification on an endpoint that has no auth.
const ARTICLE_PATH = /^\/[a-z]{2}(\/[A-Za-z0-9%._~-]+)*\/?$/;

function articlePath(url) {
  let parsed;
  try {
    parsed = url.startsWith('http') ? new URL(url) : new URL(url, SITE);
  } catch {
    throw invalidParams('url is not a valid URL or path');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw invalidParams('url must be an http(s) URL or a site path');
  }
  // The host is ignored on purpose (only same-origin assets are ever fetched),
  // but a foreign host in the argument is a mistake worth naming.
  if (url.startsWith('http') && !/(^|\.)voyagehacks\.com$/.test(parsed.hostname)) {
    throw invalidParams('get_article only reads pages on voyagehacks.com');
  }
  const path = parsed.pathname;
  const last = path.replace(/\/$/, '').split('/').pop() || '';
  if (last.includes('.')) {
    throw invalidParams('get_article reads rendered pages, not files. Pass a page path such as /en/hotels/best-budget-hotels-in-rome/');
  }
  if (!ARTICLE_PATH.test(path)) {
    throw invalidParams('url must be a language-prefixed page path such as /en/esim/esim-japan/');
  }
  return path.endsWith('/') ? path : `${path}/`;
}

// `hugo --minify` drops attribute quotes, so every meta lookup has to accept
// content="x", content='x' and bare content=x. A quoted-only pattern silently
// returns nothing against production HTML.
function metaContent(html, attr, value) {
  const re = new RegExp(
    `<meta[^>]+${attr}=["']?${value}["']?[^>]*content=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i'
  );
  const m = html.match(re);
  return m ? (m[1] || m[2] || m[3] || '').trim() : '';
}

function pageMeta(html, path) {
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '');
  const langMatch = html.match(/<html[^>]+lang=["']?([a-zA-Z-]+)/i);
  return {
    title: metaContent(html, 'property', 'og:title') || (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [, ''])[1].trim(),
    lang: (langMatch ? langMatch[1] : path.split('/')[1] || '').toLowerCase(),
    published: iso(metaContent(html, 'property', 'article:published_time')),
    updated: iso(metaContent(html, 'property', 'article:modified_time')),
    excerpt: metaContent(html, 'name', 'description'),
  };
}

async function getArticle(context, { url } = {}) {
  if (!clean(url, LIMITS.url)) throw invalidParams('url is required');
  const path = articlePath(clean(url, LIMITS.url));

  const res = await fetchAsset(context, path);
  if (!res.ok) {
    return {
      text: `No VoyageHacks page at ${path} (HTTP ${res.status}). search_articles returns valid URLs for this site.`,
      isError: true,
    };
  }
  const contentType = res.headers.get('Content-Type') || '';
  if (contentType && !contentType.includes('text/html')) {
    return { text: `${path} is not a rendered page (${contentType}). get_article reads HTML guides only.`, isError: true };
  }

  const html = await res.text();
  const meta = pageMeta(html, path);
  const full = htmlToMarkdown(html);
  const truncated = full.length > LIMITS.articleChars;
  const markdown = truncated
    ? `${full.slice(0, LIMITS.articleChars)}\n\n[Article truncated at ${LIMITS.articleChars} characters. Full text: ${SITE}${path}]`
    : full;
  const canonical = `${SITE}${path}`;

  const header = [
    meta.title ? `Title: ${meta.title}` : '',
    `URL: ${canonical}`,
    meta.lang ? `Language: ${meta.lang}` : '',
    sectionOf(canonical) ? `Section: ${sectionOf(canonical)}` : '',
    meta.published ? `Published: ${meta.published}` : '',
    meta.updated ? `Updated: ${meta.updated}` : '',
  ].filter(Boolean).join('\n');

  return {
    structured: {
      title: meta.title,
      url: canonical,
      lang: meta.lang || null,
      section: sectionOf(canonical) || null,
      published: meta.published || null,
      updated: meta.updated || null,
      excerpt: meta.excerpt || null,
      markdown,
      truncated,
      source: `VoyageHacks, ${canonical}`,
    },
    text: `${header}\n\n---\n\n${markdown}\n\n---\nSource: ${canonical}\n${DISCLOSURE}`,
  };
}

// ── Travel gear (catalog built by Hugo at /<lang>/gear.json) ───────────────
const gearCache = new Map();

async function loadGear(context, lang) {
  if (gearCache.has(lang)) return gearCache.get(lang);
  const res = await fetchAsset(context, `/${lang}/gear.json`);
  if (!res.ok) throw toolFailure(`The travel gear catalog for "${lang}" is unavailable (HTTP ${res.status}). Try lang "en".`);
  const data = await res.json();
  const items = [];
  for (const guide of data.guides || []) {
    const guideHay = `${guide.title} ${guide.description} ${(guide.tags || []).join(' ')} ${(guide.keywords || []).join(' ')}`.toLowerCase();
    for (const p of guide.products || []) {
      items.push({
        asin: p.asin,
        name: p.name,
        badge: p.badge,
        blurb: p.blurb,
        tag: guide.tag,
        guideKey: guide.translationKey,
        guideTitle: guide.title,
        guideUrl: guide.url,
        guideUpdated: guide.updated || '',
        category: gearCategory(guide),
        haystack: `${p.name} ${p.badge} ${p.blurb} ${guideHay}`.toLowerCase(),
      });
    }
  }
  const catalog = { hub: data.hub, guides: data.guides || [], items };
  return cachePut(gearCache, lang, catalog);
}

/**
 * Product category for the MCP response. The gear catalog has no category
 * field of its own, so it is derived from the guide's `translationKey`, which
 * is identical in all 11 languages ("best-travel-power-banks" -> "travel power
 * banks"). Falls back to the localized guide title when a key is missing.
 */
function gearCategory(guide) {
  const key = (guide.translationKey || '').replace(/^best-/, '').replace(/-\d{4}$/, '');
  return key ? key.replace(/-/g, ' ') : (guide.title || '');
}

function gearProduct(item) {
  // Only fields the catalog actually carries. Price, star rating, review
  // count and stock are never invented, and are not fetched from the Amazon
  // Creators API either: its license limits use to our own site (no
  // redistribution to third parties) and caps stored data at 24 hours.
  // See the note in layouts/_default/index.gearjson.json.
  return {
    name: item.name,
    category: item.category || undefined,
    badge: item.badge || undefined,
    whyThisOne: item.blurb,
    asin: item.asin,
    productUrl: productAnchor(item.guideUrl, item.asin),
    retailer: 'Amazon',
    reviewGuide: {
      title: item.guideTitle,
      url: item.guideUrl,
      ...(item.guideUpdated ? { updated: item.guideUpdated } : {}),
    },
  };
}

function gearLines(products) {
  return products
    .map((p, i) => [
      `${i + 1}. ${p.name}${p.badge ? `, ${p.badge}` : ''}${p.category ? ` (${p.category})` : ''}`,
      `   See it and buy it (Amazon button on the VoyageHacks guide): ${p.productUrl}`,
      `   Why: ${p.whyThisOne}`,
      `   Full review: ${p.reviewGuide.url}`,
    ].join('\n'))
    .join('\n\n');
}

async function searchTravelGear(context, { query, lang = 'en', limit = 6 } = {}) {
  query = clean(query, LIMITS.shortText);
  if (!query) throw invalidParams('query is required');
  lang = pickLang(lang);
  limit = intArg(limit, 6, 1, 12);

  const catalog = await loadGear(context, lang);
  const tokens = tokenize(query);
  if (!tokens.length) throw invalidParams('query has no searchable terms');

  const scored = [];
  for (const item of catalog.items) {
    let score = 0;
    for (const t of tokens) {
      score += countOccurrences(item.name.toLowerCase(), t) * 5;
      score += countOccurrences((item.badge || '').toLowerCase(), t) * 3;
      score += countOccurrences(item.haystack, t);
    }
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const products = scored.slice(0, limit).map(({ item }) => gearProduct(item));
  if (!products.length) {
    return {
      structured: { query, lang, hub: catalog.hub, productCount: 0, products: [], disclosure: DISCLOSURE },
      text:
        `No product in the VoyageHacks gear catalog matched "${query}". The catalog only covers products ` +
        `picked in published buying guides: ${catalog.hub}\n\n${DISCLOSURE}`,
    };
  }

  return {
    structured: { query, lang, hub: catalog.hub, productCount: products.length, products, disclosure: DISCLOSURE },
    text: [
      `${products.length} product(s) in the VoyageHacks gear catalog for "${query}". Each link opens the product on its VoyageHacks buying guide, which links to Amazon.`,
      'The catalog carries no prices, star ratings or review counts.',
      '',
      gearLines(products),
      '',
      `All buying guides: ${catalog.hub}`,
      DISCLOSURE,
      LINK_NOTE,
    ].join('\n'),
  };
}

/**
 * Trip-context → gear categories. Keys are `translationKey`s from the gear
 * catalog (identical across all 8 languages); triggers are matched against the
 * caller's free-text trip description, so the mapping works whatever language
 * the guides are requested in.
 *
 * One rule = one category = at most ONE item in the returned kit, so the keys
 * inside a rule must be SUBSTITUTES (packing cubes vs compression bags), never
 * complements (a neck pillow and earplugs both belong on a red-eye, so they are
 * separate rules that share triggers).
 */
// Function words carry no signal about which gear category a trip needs, and
// they collide with guide titles constantly ("Best Power Banks FOR iPhone",
// "What TO Pack"). Covers the languages the tools accept; tokenize() already
// drops single characters. Only used for the guide-title overlap score, never
// for the KIT_RULES triggers, which are explicit multi-word phrases.
const TRIP_STOPWORDS = new Set([
  // en
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'they', 'them', 'their', 'there', 'what',
  'when', 'where', 'which', 'will', 'would', 'have', 'has', 'had', 'been', 'being', 'are', 'was',
  'were', 'about', 'into', 'over', 'some', 'any', 'all', 'own', 'out', 'off', 'not', 'but', 'can',
  'get', 'got', 'going', 'go', 'need', 'needs', 'want', 'take', 'taking', 'bring', 'pack', 'packing',
  'travel', 'trip', 'trips', 'holiday', 'vacation', 'best', 'good', 'gear', 'stuff', 'things', 'item',
  'items', 'buy', 'should', 'you', 'your', 'our', 'its', 'his', 'her', 'him', 'she', 'the',
  // de / nl
  'und', 'der', 'die', 'das', 'den', 'dem', 'ein', 'eine', 'mit', 'für', 'von', 'nach', 'reise',
  'een', 'het', 'van', 'voor', 'met', 'naar', 'reis',
  // fr
  'les', 'des', 'une', 'pour', 'avec', 'dans', 'sur', 'est', 'voyage',
  // es / pt
  'los', 'las', 'del', 'una', 'para', 'con', 'por', 'que', 'viaje', 'viagem', 'uma', 'como',
  // it
  'gli', 'dei', 'della', 'per', 'con', 'nel', 'viaggio',
  // pl / cs
  'dla', 'nie', 'jak', 'podróż', 'pro', 'jak', 'cesta', 'cestovni',
]);

const KIT_RULES = [
  // Charging and power
  { keys: ['travel-adapters-2026', 'travel-adapters-by-country'], weight: 6, triggers: ['abroad', 'international', 'overseas', 'europe', 'asia', 'japan', 'thailand', 'uk', 'britain', 'australia', 'usa', 'america', 'plug', 'adapter', 'adaptor', 'socket', 'voltage'] },
  { keys: ['best-travel-power-banks', 'anker-power-bank-comparison', 'anker-ugreen-iniu-power-banks', 'power-banks-for-phones-2026', 'power-bank-rules-by-airline'], weight: 6, triggers: ['long', 'long-haul', 'longhaul', 'flight', 'flights', 'fly', 'flying', 'layover', 'battery', 'charge', 'charging', 'power bank', 'powerbank', 'power', 'phone', 'photo', 'photography', 'camera', 'hiking', 'day trip'] },
  /* Per-airline power bank rule pages: substitutes for one another, and the
     airline name is the only sensible trigger. */
  { keys: ['power-bank-rules-delta', 'power-bank-rules-united', 'power-bank-rules-american-airlines', 'power-bank-rules-southwest', 'power-bank-rules-air-canada', 'power-bank-rules-air-france', 'power-bank-rules-emirates', 'power-bank-rules-qatar-airways', 'power-bank-rules-ryanair', 'power-bank-rules-lufthansa', 'power-bank-rules-air-india', 'power-bank-rules-qantas'], weight: 5, triggers: ['delta', 'united airlines', 'american airlines', 'southwest', 'air canada', 'air france', 'emirates', 'qatar airways', 'ryanair', 'lufthansa', 'air india', 'qantas'] },
  { keys: ['best-gan-wall-chargers-for-travel', 'best-anker-chargers-for-travel', 'travel-power-strips'], weight: 4, triggers: ['laptop', 'work', 'working', 'remote', 'business', 'digital nomad', 'nomad', 'charger', 'charging', 'gadgets', 'devices', 'cruise', 'hotel room', 'outlet', 'outlets'] },
  { keys: ['best-portable-travel-monitors'], weight: 3, triggers: ['laptop', 'work', 'working', 'remote', 'business', 'digital nomad', 'nomad', 'workation', 'second screen', 'monitor', 'coworking', 'conference'] },
  { keys: ['travel-tech-organizers'], weight: 3, triggers: ['cables', 'cords', 'tech', 'gadgets', 'devices', 'laptop', 'nomad', 'organize', 'organise', 'chargers'] },

  // Bags and packing
  { keys: ['best-packing-cubes', 'best-compression-packing-bags'], weight: 6, triggers: ['carry-on', 'carry on', 'cabin', 'hand luggage', 'pack', 'packing', 'organize', 'organise', 'light', 'minimal', 'backpacking', 'weeks', 'month', 'winter', 'bulky', 'jackets'] },
  /* Bag you carry on: backpack, wheeled carry-on or personal item. They are
     substitutes, so one rule yields one bag, never three. */
  { keys: ['best-carry-on-travel-backpacks', 'carry-on-suitcases', 'carry-on-backpacks-women', 'personal-item-bags', 'best-underseat-luggage-with-wheels'], weight: 5, triggers: ['backpack', 'suitcase', 'spinner', 'roller', 'wheeled', 'carry-on', 'carry on', 'cabin', 'hand luggage', 'no checked bag', 'budget airline', 'ryanair', 'wizz', 'easyjet', 'personal item', 'under the seat', 'under-seat', 'backpacking', 'hostel'] },
  { keys: ['best-passport-holders'], weight: 4, triggers: ['passport', 'passports', 'documents', 'visa', 'border', 'immigration', 'pickpocket', 'pickpockets', 'theft', 'family', 'kids', 'children', 'international', 'abroad', 'overseas', 'airtag', 'lost'] },
  { keys: ['luggage-scales-2026'], weight: 3, triggers: ['checked', 'checked bag', 'suitcase', 'weight', 'overweight', 'baggage fee', 'budget airline', 'ryanair', 'wizz', 'easyjet', 'allowance'] },
  { keys: ['luggage-trackers-2026', 'airtag-tile-chipolo-luggage', 'travel-gifts'], weight: 5, triggers: ['checked', 'checked bag', 'suitcase', 'connection', 'connecting', 'lost luggage', 'transfer', 'multi-city', 'multi city', 'family', 'kids', 'airtag', 'tracker', 'gift', 'present'] },

  // Sleeping and comfort on the way
  { keys: ['best-travel-neck-pillows', 'travel-pillows-long-haul', 'long-flight-essentials'], weight: 6, triggers: ['long-haul', 'longhaul', 'red-eye', 'red eye', 'overnight', 'night flight', 'sleep', 'sleeping', 'jet lag', 'jetlag', 'economy', 'hours', 'train', 'bus'] },
  { keys: ['best-earplugs-and-eye-masks-for-flights', 'travel-white-noise-machines'], weight: 6, triggers: ['long-haul', 'longhaul', 'red-eye', 'red eye', 'overnight', 'night flight', 'sleep', 'sleeping', 'jet lag', 'jetlag', 'noise', 'noisy', 'baby', 'hostel', 'ear', 'hours'] },
  { keys: ['airplane-footrests'], weight: 3, triggers: ['long-haul', 'longhaul', 'economy', 'legs', 'swelling', 'tall', 'short', 'hours', 'overnight'] },
  { keys: ['compression-socks-flights'], weight: 4, triggers: ['long-haul', 'longhaul', 'swelling', 'legs', 'circulation', 'dvt', 'pregnant', 'hours', 'overnight', 'ultra-long'] },

  // Toiletries and clothing
  { keys: ['best-hanging-toiletry-bags'], weight: 4, triggers: ['toiletries', 'toiletry', 'liquids', 'tsa', 'shampoo', 'hostel', 'carry-on', 'carry on', 'cabin'] },
  /* Decanted liquids and solid bars solve the same 100 ml problem in opposite
     ways, so they are substitutes: a kit gets one approach, not both. */
  { keys: ['best-travel-size-bottles', 'best-solid-toiletries-for-travel'], weight: 4, triggers: ['toiletries', 'liquids', 'tsa', 'shampoo', 'conditioner', 'soap', 'deodorant', 'solid', 'bar', 'plastic-free', 'skincare', 'carry-on', 'carry on', 'cabin', 'hand luggage'] },
  { keys: ['best-travel-makeup-bags'], weight: 3, triggers: ['makeup', 'make-up', 'cosmetics', 'skincare', 'beauty', 'wedding'] },
  { keys: ['travel-steamers-dual-voltage'], weight: 3, triggers: ['business', 'suit', 'shirt', 'wedding', 'conference', 'formal', 'creases', 'wrinkles', 'iron'] },

  // Connectivity and language
  { keys: ['best-travel-routers', 'travel-router-hotel-wifi'], weight: 4, triggers: ['hotel wifi', 'wifi', 'wi-fi', 'work', 'working', 'remote', 'nomad', 'streaming', 'vpn', 'security', 'airbnb', 'apartment'] },
  { keys: ['best-translation-earbuds'], weight: 3, triggers: ['language', 'translation', 'translate', 'japan', 'china', 'korea', 'vietnam', 'thailand', 'brazil', 'business'] },
  { keys: ['best-travel-gadgets-2026'], weight: 2, triggers: ['gadget', 'gadgets', 'tech', 'electronics'] },

  // Shooting the trip
  { keys: ['best-travel-cameras', 'best-travel-drones-for-vlogging', 'best-point-and-shoot-cameras-for-travel'], weight: 4, triggers: ['camera', 'photo', 'photography', 'photos', 'vlog', 'vlogging', 'filming', 'video', 'content', 'drone', 'creator'] },

  // Cold weather
  { keys: ['christmas-market-packing-list', 'winter-christmas-travel-tips', 'best-heated-vests-and-hand-warmers-for-travel'], weight: 6, triggers: ['christmas market', 'christmas markets', 'weihnachtsmarkt', 'freezing', 'sub-zero', 'cold', 'thermal', 'base layer', 'december', 'january', 'lapland', 'iceland', 'norway', 'finland', 'northern lights'] },
  { keys: ['ski-trip-packing-list', 'ski-gear-to-buy-before-you-rent'], weight: 6, triggers: ['ski', 'skiing', 'snowboard', 'snowboarding', 'slopes', 'piste', 'alps', 'resort', 'chalet', 'apres'] },

  // Outdoors
  { keys: ['hiking-trip-essentials'], weight: 5, triggers: ['hike', 'hiking', 'trek', 'trekking', 'trail', 'trails', 'day hike', 'mountains', 'walking'] },
  { keys: ['camping-trip-packing-list', 'camping-trip-tips-for-beginners'], weight: 6, triggers: ['camp', 'camping', 'campsite', 'tent', 'wild camping', 'outdoors'] },
  { keys: ['campervan-road-trip-tips'], weight: 5, triggers: ['campervan', 'camper van', 'motorhome', 'rv', 'van life', 'vanlife', 'road trip'] },
  { keys: ['hunting-trip-gear-checklist', 'crossbow-hunting-trip-guide'], weight: 6, triggers: ['hunt', 'hunting', 'crossbow', 'archery', 'bow', 'deer', 'elk'] },
  { keys: ['beach-vacation-packing-list'], weight: 5, triggers: ['beach', 'beaches', 'island', 'islands', 'coast', 'seaside', 'snorkel', 'snorkeling', 'swim', 'swimming', 'resort', 'maldives', 'caribbean'] },

  // Cruises
  /* The three cruise guides are substitutes: one cruise kit item, not three.
     Cabin power and storage are the whole reason these pages exist, because the
     lines disagree with each other about what is allowed on board. */
  { keys: ['best-cruise-essentials', 'best-cruise-cabin-organizers', 'what-not-to-pack-on-a-cruise'], weight: 6, triggers: ['cruise', 'cruising', 'cruise ship', 'sailing', 'shore excursion', 'cabin', 'stateroom', 'port day', 'sea day', 'caribbean cruise', 'mediterranean cruise', 'alaska cruise'] },

  // Weather, security and valuables
  { keys: ['best-travel-umbrellas'], weight: 4, triggers: ['rain', 'rainy', 'rainy season', 'monsoon', 'wet season', 'umbrella', 'showers', 'downpour', 'storm', 'windy', 'england', 'scotland', 'ireland', 'vietnam', 'seattle'] },
  { keys: ['best-tsa-luggage-locks'], weight: 3, triggers: ['lock', 'locks', 'padlock', 'tsa lock', 'security', 'theft', 'stolen', 'pilfering', 'hostel', 'dorm', 'checked bag', 'checked luggage'] },
  { keys: ['best-travel-jewelry-cases'], weight: 3, triggers: ['jewelry', 'jewellery', 'rings', 'earrings', 'necklace', 'watch', 'valuables', 'wedding', 'engagement', 'heirloom'] },
  { keys: ['best-anti-theft-travel-backpacks'], weight: 3, triggers: ['pickpocket', 'pickpockets', 'pickpocketing', 'anti theft', 'anti-theft', 'daypack', 'rome', 'barcelona', 'paris', 'crowded', 'city break', 'sightseeing'] },
  { keys: ['best-travel-first-aid-kits'], weight: 3, triggers: ['first aid', 'first-aid', 'medicine', 'medication', 'medications', 'prescription', 'blisters', 'hiking', 'trekking', 'remote', 'backpacking', 'road trip', 'safari'] },

  // Personal care
  { keys: ['best-travel-hair-dryers'], weight: 3, triggers: ['hair dryer', 'hairdryer', 'blow dryer', 'hair', 'dual voltage', 'voltage', '230v', '220v', 'europe', 'uk', 'wedding'] },
  { keys: ['best-kindle-for-travel'], weight: 3, triggers: ['kindle', 'e-reader', 'ereader', 'e-book', 'ebook', 'paperwhite', 'novel', 'novels'] },
  { keys: ['voltage-converter-vs-travel-adapter'], weight: 3, triggers: ['voltage converter', 'converter', 'transformer', '110v', '120v', 'step down', 'step-down', 'cpap', 'curling iron', 'flat iron'] },
  { keys: ['best-noise-cancelling-headphones-for-flying'], weight: 3, triggers: ['headphones', 'noise cancelling', 'noise canceling', 'earbuds', 'airpods', 'bose', 'engine noise', 'long haul', 'long-haul'] },

  // Gifting
  /* Both are gift round-ups, so they are substitutes. The tracker rule above
     also answers 'gift', which is correct: a tracker is the gift most often
     asked for, and KIT_CATEGORY keeps the kit to one item per rule anyway. */
  { keys: ['travel-stocking-stuffers'], weight: 4, triggers: ['stocking', 'stocking stuffer', 'secret santa', 'christmas gift', 'small gift', 'under 25', 'stocking filler', 'advent'] },

  { keys: ['travel-gifts-for-women'], weight: 4, triggers: ['gift for her', 'gifts for her', 'for her', 'wife', 'girlfriend', 'mom', 'mother', 'sister', 'gifts for women'] },
  { keys: ['travel-gifts-for-men'], weight: 4, triggers: ['gift for him', 'gifts for him', 'for him', 'husband', 'boyfriend', 'dad', 'father', 'brother', 'gifts for men', 'frequent traveler', 'frequent flyer'] },
  /* The two shopping-event guides are substitutes: whichever event is nearer. */
  { keys: ['prime-day-travel-deals', 'black-friday-travel-deals'], weight: 3, triggers: ['prime day', 'prime big deal days', 'black friday', 'cyber monday', 'travel tuesday', 'deal', 'deals', 'sale', 'discount'] },

  // Luggage and warmth
  { keys: ['best-luggage-sets'], weight: 4, triggers: ['luggage set', 'suitcase set', 'set of suitcases', 'checked luggage', 'family trip', 'long trip', 'moving abroad', 'two weeks', 'three weeks'] },
  { keys: ['best-weekender-bags'], weight: 4, triggers: ['weekend', 'weekender', 'duffel', 'duffle', 'overnight', 'long weekend', 'short trip', 'two nights', '2 nights'] },
  // Q4c gear wave (2026-10-12)
  { keys: ['best-airplane-bluetooth-transmitters'], weight: 4, triggers: ['airfly', 'bluetooth adapter', 'bluetooth transmitter', 'seatback screen', 'seat-back screen', 'in-flight entertainment', 'wireless headphones on plane', 'airpods on plane'] },
  { keys: ['best-airplane-phone-holders'], weight: 3, triggers: ['phone holder', 'phone mount', 'tablet holder', 'tray table', 'watch movies on plane', 'ipad on plane'] },
  { keys: ['best-packable-travel-blankets'], weight: 3, triggers: ['travel blanket', 'packable blanket', 'puffy blanket', 'cold plane', 'cold flight', 'airplane blanket'] },
  { keys: ['best-luggage-covers'], weight: 3, triggers: ['luggage cover', 'suitcase cover', 'suitcase protector', 'scratches', 'checked luggage damage'] },
  { keys: ['best-foldable-duffel-bags'], weight: 3, triggers: ['foldable duffel', 'packable duffel', 'extra bag', 'souvenirs', 'shopping trip', 'bring gifts home', 'spare bag'] },
  { keys: ['best-kids-luggage'], weight: 4, triggers: ['kids luggage', 'kids suitcase', 'ride-on suitcase', 'trunki', 'children', 'kids', 'family trip', 'toddler'] },
  { keys: ['best-microfiber-travel-towels'], weight: 3, triggers: ['travel towel', 'microfiber towel', 'quick dry towel', 'hostel', 'hostels', 'backpacking', 'beach towel'] },
  { keys: ['best-collapsible-travel-kettles'], weight: 3, triggers: ['travel kettle', 'collapsible kettle', 'tea', 'instant noodles', 'boil water', 'no kettle in room'] },
  { keys: ['best-heated-travel-blankets'], weight: 3, triggers: ['heated blanket', 'blanket', 'cold', 'freezing', 'chilly', 'winter road trip', 'stadium', 'cold hotel', 'overnight train'] },

  { keys: ['best-belt-bags-for-travel'], weight: 3, triggers: ['belt bag', 'fanny pack', 'bum bag', 'hip pack', 'sling', 'crossbody', 'pickpocket', 'city break', 'theme park', 'festival'] },
  { keys: ['best-magsafe-travel-chargers'], weight: 3, triggers: ['magsafe', 'wireless charger', 'qi2', 'apple watch', 'airpods', 'iphone charger', '3 in 1 charger', 'charging stand'] },
  { keys: ['best-garment-bags'], weight: 4, triggers: ['garment bag', 'suit', 'suits', 'wedding', 'wedding guest', 'dress', 'gown', 'tuxedo', 'business trip', 'conference', 'formal'] },
  { keys: ['best-luggage-tags'], weight: 2, triggers: ['luggage tag', 'bag tag', 'name tag', 'lost luggage', 'checked bag', 'identify my bag'] },

  { keys: ['best-travel-pants'], weight: 3, triggers: ['pants', 'trousers', 'what to wear on a plane', 'long flight outfit', 'business trip', 'hiking pants'] },
  { keys: ['best-travel-journals'], weight: 2, triggers: ['journal', 'diary', 'notebook', 'scrapbook', 'sketch', 'honeymoon', 'gap year'] },
  { keys: ['best-travel-water-bottles'], weight: 3, triggers: ['water bottle', 'tap water', 'drinking water', 'filter', 'purifier', 'safe water', 'hiking', 'india', 'mexico', 'peru', 'morocco', 'vietnam'] },
  { keys: ['best-travel-tripods'], weight: 3, triggers: ['tripod', 'photography', 'photos', 'night photography', 'northern lights', 'aurora', 'long exposure', 'vlog', 'timelapse'] },
  { keys: ['best-travel-toothbrushes'], weight: 2, triggers: ['toothbrush', 'electric toothbrush', 'toiletries', 'dental'] },

  // Travelling with others
  { keys: ['best-travel-strollers-and-cribs'], weight: 5, triggers: ['stroller', 'pram', 'pushchair', 'buggy', 'travel crib', 'crib', 'cot', 'pack n play', 'baby', 'infant', 'newborn', 'toddler', 'gate check'] },
  { keys: ['best-kids-travel-headphones'], weight: 4, triggers: ['kids', 'children', 'child', 'family', 'tablet', 'ipad', 'kids headphones', 'school holidays'] },
  { keys: ['best-travel-car-seats'], weight: 4, triggers: ['car seat', 'car seats', 'booster', 'infant seat', 'rental car with kids', 'baby', 'toddler', 'faa approved', 'taxi with kids', 'road trip with kids'] },

  // Winter clothing (Q4 2026 wave). Gloves, jackets, base layers and boots are
  // different layers, not substitutes, so each is its own rule.
  // Q4d wave (2026-10-29): winter warmth, socks, shoe bags, instant cameras
  { keys: ['best-rechargeable-hand-warmers', 'best-heated-socks-for-travel'], weight: 4, triggers: ['hand warmer', 'hand warmers', 'cold hands', 'cold feet', 'heated socks', 'freezing', 'sub-zero', 'lapland', 'northern lights', 'christmas market', 'christmas markets', 'skiing', 'winter'] },
  { keys: ['best-merino-wool-travel-socks'], weight: 3, triggers: ['socks', 'merino', 'hiking', 'walking', 'one bag', 'onebag', 'winter', 'skiing', 'cold feet', 'blisters'] },
  { keys: ['best-travel-shoe-bags'], weight: 2, triggers: ['shoes', 'sneakers', 'boots', 'gym', 'packing', 'pack', 'suitcase', 'heels'] },
  { keys: ['best-instant-cameras-for-travel'], weight: 3, triggers: ['instant camera', 'instax', 'polaroid', 'prints', 'scrapbook', 'journal', 'wedding', 'honeymoon', 'gift', 'present'] },
  { keys: ['best-heated-gloves-for-travel'], weight: 4, triggers: ['gloves', 'heated gloves', 'cold hands', 'raynaud', 'freezing', 'sub-zero', 'lapland', 'northern lights', 'christmas market', 'christmas markets', 'skiing', 'winter'] },
  { keys: ['best-packable-down-jackets'], weight: 4, triggers: ['down jacket', 'puffer', 'packable jacket', 'winter jacket', 'cold', 'freezing', 'iceland', 'norway', 'lapland', 'christmas market', 'winter', 'carry-on winter'] },
  { keys: ['best-thermal-base-layers-for-travel'], weight: 4, triggers: ['base layer', 'base layers', 'thermal', 'thermals', 'merino', 'long johns', 'freezing', 'sub-zero', 'northern lights', 'skiing', 'winter'] },
  { keys: ['best-winter-boots-for-travel'], weight: 4, triggers: ['boots', 'winter boots', 'snow boots', 'snow', 'ice', 'icy', 'slush', 'lapland', 'iceland', 'christmas market', 'winter city break'] },
  { keys: ['best-travel-crossbody-bags'], weight: 3, triggers: ['crossbody', 'cross-body', 'shoulder bag', 'small bag', 'phone bag', 'pickpocket', 'city break', 'sightseeing', 'paris', 'rome', 'barcelona'] },
  { keys: ['flying-with-a-toddler'], weight: 6, triggers: ['toddler', 'baby', 'infant', 'children', 'kids', 'family', 'child'] },
  { keys: ['flying-with-a-dog'], weight: 6, triggers: ['dog', 'puppy', 'pet', 'pets', 'cat', 'animal'] },
];
// key → category id, so only one product per category makes the kit.
const KIT_CATEGORY = new Map();
KIT_RULES.forEach((rule, i) => rule.keys.forEach((key) => { if (!KIT_CATEGORY.has(key)) KIT_CATEGORY.set(key, i); }));
// Always-useful fallbacks when the trip text matches nothing specific.
const KIT_DEFAULTS = ['best-packing-cubes', 'best-travel-power-banks', 'travel-adapters-2026', 'luggage-trackers-2026', 'best-travel-neck-pillows', 'best-carry-on-travel-backpacks'];

/**
 * Structured trip hints are folded into the same free-text matching the
 * `trip` string goes through: KIT_RULES triggers are plain substrings, so a
 * hint only has to be expressed in words the rules already know. Nothing here
 * invents a capability the catalog does not have (there are no prices, so
 * `budget` is recorded and reported, never used to filter).
 */
const LUGGAGE_TEXT = {
  carry_on_only: 'carry-on only cabin hand luggage pack light',
  personal_item_only: 'personal item only carry on cabin minimal pack light budget airline',
  checked_bag: 'checked bag suitcase',
  backpack: 'backpack backpacking hostel',
};
const TRAVELER_TEXT = {
  solo: 'solo',
  couple: 'couple',
  family: 'family kids',
  business: 'business work laptop',
  backpacker: 'backpacking hostel backpack budget',
  digital_nomad: 'digital nomad remote work working laptop wifi',
};
const SEASON_TEXT = {
  spring: 'spring',
  summer: 'summer heat',
  autumn: 'autumn',
  winter: 'winter cold bulky jackets',
  rainy: 'rainy monsoon wet',
  dry: 'dry',
};

function tripCriteria(args) {
  const criteria = {};
  const destination = clean(args.destination);
  const season = clean(args.season, 20).toLowerCase();
  const luggage = clean(args.luggage, 30).toLowerCase();
  const travelerType = clean(args.traveler_type, 30).toLowerCase();
  const budget = clean(args.budget, 20).toLowerCase();
  const activities = stringList(args.activities);
  const days = args.trip_length_days ? intArg(args.trip_length_days, 0, 1, 365) : 0;

  if (destination) criteria.destination = destination;
  if (days) criteria.trip_length_days = days;
  if (SEASON_TEXT[season]) criteria.season = season;
  if (activities.length) criteria.activities = activities;
  if (LUGGAGE_TEXT[luggage]) criteria.luggage = luggage;
  if (TRAVELER_TEXT[travelerType]) criteria.traveler_type = travelerType;
  if (['budget', 'mid_range', 'premium'].includes(budget)) criteria.budget = budget;

  const parts = [
    destination,
    days ? `${days} days${days >= 10 ? ' weeks long trip' : ''}` : '',
    SEASON_TEXT[season] || '',
    activities.join(' '),
    LUGGAGE_TEXT[luggage] || '',
    TRAVELER_TEXT[travelerType] || '',
  ].filter(Boolean);

  return { criteria, hintText: parts.join(' ') };
}

async function recommendTravelGear(context, args = {}) {
  const trip = clean(args.trip, LIMITS.freeText);
  if (!trip) throw invalidParams('trip is required');
  const lang = pickLang(args.lang);
  const limit = intArg(args.limit, 6, 1, 10);
  const { criteria, hintText } = tripCriteria(args);

  const catalog = await loadGear(context, lang);
  const text = `${trip} ${hintText}`.toLowerCase();
  const scores = new Map();
  const bump = (key, n) => scores.set(key, (scores.get(key) || 0) + n);

  for (const rule of KIT_RULES) {
    const hits = rule.triggers.filter((t) => text.includes(t)).length;
    if (hits) for (const key of rule.keys) bump(key, rule.weight + hits);
  }
  // Free-text overlap with each guide's own title/tags/keywords, ignoring
  // function words. "for" appears in 40 of the 51 guide titles, so leaving it
  // in bumped almost the whole catalog by 2 for any trip description
  // containing it, which is most of them: "flying to Spain with my dog"
  // surfaced the ski packing list on the strength of "with".
  const tokens = tokenize(text).filter((t) => !TRIP_STOPWORDS.has(t));
  for (const guide of catalog.guides) {
    const hay = `${guide.title} ${(guide.tags || []).join(' ')} ${(guide.keywords || []).join(' ')}`.toLowerCase();
    let n = 0;
    for (const t of tokens) if (hay.includes(t)) n++;
    if (n) bump(guide.translationKey, n * 2);
  }
  for (const key of KIT_DEFAULTS) bump(key, 1);

  const ranked = [...scores.entries()]
    .filter(([key]) => catalog.guides.some((g) => g.translationKey === key))
    .sort((a, b) => b[1] - a[1]);

  // One pick per category (no packing cubes AND compression bags in one kit);
  // the guide's first product is its headline pick.
  //
  // The ASIN guard is the backstop. Several guides legitimately share a
  // headline pick (the AirTag 4-pack leads three of them, one Anker power bank
  // leads three more), so category grouping alone stops being enough the moment
  // a new guide is published before KIT_RULES learns about it. Without this a
  // kit could list the same product twice.
  const products = [];
  const usedCategories = new Set();
  const usedAsins = new Set();
  for (const [key] of ranked) {
    if (products.length >= limit) break;
    const category = KIT_CATEGORY.has(key) ? KIT_CATEGORY.get(key) : `guide:${key}`;
    if (usedCategories.has(category)) continue;
    const item = catalog.items.find((i) => i.guideKey === key && !usedAsins.has(i.asin));
    if (!item) continue;
    usedCategories.add(category);
    usedAsins.add(item.asin);
    products.push(gearProduct(item));
  }

  const criteriaLine = Object.entries(criteria)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join(' | ');

  return {
    structured: { trip, lang, hub: catalog.hub, criteria, kit: products, disclosure: DISCLOSURE },
    text: [
      `Gear kit for: ${trip}`,
      criteriaLine ? `Applied: ${criteriaLine}` : '',
      '',
      gearLines(products),
      '',
      `Each pick is the headline choice from its buying guide, which lists the runners-up. All guides: ${catalog.hub}`,
      'The catalog carries no prices, star ratings or review counts.',
      DISCLOSURE,
      LINK_NOTE,
    ].filter((s) => s !== '').join('\n'),
  };
}

// ── Vertical booking tools ─────────────────────────────────────────────────
async function getFlightLinks(context, args = {}) {
  const lang = pickLang(args.lang);
  const origin = iata(args.origin);
  const dest = iata(args.destination);
  const depart = isoDate(args.depart_date);
  const ret = isoDate(args.return_date);
  const pax = intArg(args.passengers, 1, 1, 9);
  const region = resolveRegion(context, args.country, lang);

  const search = cjLink(region, 'deeplink', bookingFlightsUrl({ origin, dest, depart, ret, pax }), 'mcp-flights');
  const vueling = cjPartnerLink('vueling', 'https://www.vueling.com/en', 'mcp-flights');
  // Route-matched airline direct links (2026-08-12 CJ programs): Air Serbia
  // for Belgrade/Niš routes, Air India for routes touching its main gateways.
  const INDIA_GATEWAYS = ['DEL', 'BOM', 'BLR', 'MAA', 'CCU', 'HYD', 'COK', 'AMD', 'GOI'];
  const touches = (codes) => codes.includes(origin) || codes.includes(dest);
  const airSerbia = touches(['BEG', 'INI']) ? cjPartnerLink('airserbia', 'https://www.airserbia.com/en', 'mcp-flights') : null;
  const airIndia = touches(INDIA_GATEWAYS) ? cjPartnerClickLink('airindia', 'mcp-flights') : null;
  // Virgin Atlantic (2026-10-01 CJ program, UK-targeted): routes from its UK bases.
  const virginAtlantic = touches(['LON', 'LHR', 'LGW', 'MAN']) ? cjPartnerLink('virginatlantic', 'https://www.virginatlantic.com/en-GB', 'mcp-flights') : null;
  const query = [clean(args.destination), clean(args.origin)].filter(Boolean).join(' ');
  const guides = await findGuides(context, lang, ['flights', 'airlines', 'destinations'], query, 4);

  const route = origin && dest ? `${origin} → ${dest}` : 'anywhere';
  const structured = {
    disclosure: DISCLOSURE,
    region,
    route: { origin: origin || null, destination: dest || null, depart: depart || null, return: ret || null, passengers: pax },
    flightSearch: search,
    flightCompensation: TP.airhelp,
    vueling,
    ...(airSerbia ? { airSerbia } : {}),
    ...(airIndia ? { airIndia } : {}),
    ...(virginAtlantic ? { virginAtlantic } : {}),
    guides,
  };

  return {
    structured,
    text: bookingResponse({
      heading: `Flight search (${route}${depart ? `, ${depart}${ret ? ` to ${ret}` : ''}` : ''}):`,
      links: [
        { label: 'Compare fares (Booking.com Flights)', url: search },
        ...(airSerbia ? [{ label: 'Book direct with Air Serbia (Belgrade hub)', url: airSerbia }] : []),
        ...(airIndia ? [{ label: 'Book direct with Air India', url: airIndia }] : []),
        ...(virginAtlantic ? [{ label: 'Book direct with Virgin Atlantic (London/Manchester)', url: virginAtlantic }] : []),
        { label: 'Budget fares within Europe (Vueling)', url: vueling },
        { label: 'Delayed or cancelled flight compensation (AirHelp)', url: TP.airhelp },
      ],
      guides,
      extra: origin && dest ? '' : '\nTip: pass origin and destination IATA codes (e.g. origin="LON", destination="HKT") for a pre-filled route search.',
    }),
  };
}

async function getHotelLinks(context, args = {}) {
  const lang = pickLang(args.lang);
  const city = clean(args.city);
  const checkin = isoDate(args.checkin);
  const checkout = isoDate(args.checkout);
  const adults = intArg(args.adults, 2, 1, 30);
  const children = args.children === undefined ? 0 : intArg(args.children, 0, 0, 10);
  const rooms = intArg(args.rooms, 1, 1, 10);
  const region = resolveRegion(context, args.country, lang);

  const target = bookingSearchUrl({ city, checkin, checkout, adults, children, rooms });
  const url = cjLink(region, 'deeplink', target, 'mcp-hotels');
  const ihgTarget = city ? `https://www.ihg.com/hotels/us/en/find-hotels/hotel-search?qDest=${encodeURIComponent(city)}` : 'https://www.ihg.com/';
  const ihg = cjPartnerLink('ihg', ihgTarget, 'mcp-hotels');
  const guides = await findGuides(context, lang, ['hotels', 'destinations'], city, 4);
  // Other booking sites for the same search, through Stay22. Only with a city:
  // Allez needs an address to search.
  const stay = { address: city, checkin, checkout, adults, children };
  const moreStays = city ? [
    { label: 'Compare the same dates on Expedia', url: stay22Link('expedia', stay, 'mcp_hotels') },
    { label: 'Apartments and holiday homes (Vrbo)', url: stay22Link('vrbo', stay, 'mcp_hotels') },
    { label: 'Hotels on Agoda (strongest in Asia)', url: stay22Link('agoda', stay, 'mcp_hotels') },
  ] : [];

  return {
    structured: { disclosure: DISCLOSURE, region, city: city || null, checkin: checkin || null, checkout: checkout || null, adults, children, rooms, hotelSearch: url, ihg, moreStays, guides },
    text: bookingResponse({
      heading: `Hotel search on Booking.com${city ? `: ${city}` : ''}${checkin && checkout ? `, ${checkin} to ${checkout}` : ''} (${adults} adult(s)${children ? `, ${children} child(ren)` : ''}, ${rooms} room(s)):`,
      links: [
        { label: 'Search stays (Booking.com, free cancellation on most rooms)', url },
        ...moreStays,
        { label: 'IHG hotel brands: Holiday Inn, InterContinental, Crowne Plaza', url: ihg },
      ],
      guides,
    }),
  };
}

async function getCarRentalLinks(context, args = {}) {
  const lang = pickLang(args.lang);
  const where = clean(args.destination);
  const region = resolveRegion(context, args.country, lang);
  const guides = await findGuides(context, lang, ['car-rental', 'destinations'], where, 4);

  const links = [
    { label: 'Compare rental prices worldwide (EconomyBookings)', url: carRentalLink(where) },
    { label: 'Compare rental prices worldwide (QEEQ)', url: TP.qeeq },
    { label: 'Local suppliers, lower deposits, S. Europe, Balkans, Georgia, Asia (Localrent)', url: TP.localrent },
    { label: 'Local suppliers with delivery to your hotel (GetRentacar)', url: TP.getrentacar },
    { label: 'Scooters and motorbikes (BikesBooking)', url: TP.bikesbooking },
  ];
  const bookingCars = cjRegionLink(region, 'cars', 'mcp-cars');

  return {
    structured: {
      disclosure: DISCLOSURE,
      region,
      destination: where || null,
      pickup: isoDate(args.pickup_date) || null,
      dropoff: isoDate(args.dropoff_date) || null,
      providers: links.map((l) => ({ label: l.label, url: l.url })),
      bookingCars,
      guides,
    },
    text: bookingResponse({
      heading: `Car rental${where ? ` in ${where}` : ''}: enter dates and pickup point on the provider's site:`,
      links: [...links, { label: 'Also compare cars on Booking.com', url: bookingCars }],
      guides,
      extra: '\nDates and the pickup point are entered on the provider site; these are comparison landing pages. The insurance excess and the fuel policy are the two terms that most often differ between suppliers, and the guides above cover them.',
    }),
  };
}

async function getAirportTransferLinks(context, args = {}) {
  const lang = pickLang(args.lang);
  const city = clean(args.city);
  const airport = clean(args.airport);
  const region = resolveRegion(context, args.country, lang);
  const taxis = cjLink(region, 'taxis', 'https://www.booking.com/taxi/index.html', 'mcp-taxi');
  const guides = await findGuides(context, lang, ['transfers', 'destinations'], `${airport} ${city}`.trim(), 4);

  const links = [
    { label: 'Fixed-price airport taxi, 100+ countries (Booking.com Taxis)', url: taxis },
    { label: 'Pre-booked private transfer (Kiwitaxi)', url: TP.kiwitaxi },
    { label: 'Local drivers, meet and greet (Welcome Pickups)', url: TP.welcomepickups },
    { label: 'Transfers with price offers from drivers (GetTransfer)', url: TP.gettransfer },
  ];

  return {
    structured: { disclosure: DISCLOSURE, region, airport: airport || null, city: city || null, providers: links, guides },
    text: bookingResponse({
      heading: `Airport transfer${airport ? ` from ${airport}` : ''}${city ? ` to ${city}` : ''}, pre-booked, fixed price:`,
      links,
      guides,
    }),
  };
}

async function getEsimLinks(context, args = {}) {
  const lang = pickLang(args.lang);
  const where = clean(args.destination);
  const guides = await findGuides(context, lang, ['esim'], where, 4);

  const links = [
    { label: 'Airalo: 200+ countries, the default pick', url: TP.airalo },
    { label: 'Yesim, pay-as-you-go and unlimited regional plans', url: TP.yesim },
    { label: 'Saily: from the NordVPN team, simple flat plans', url: TP.saily },
    { label: 'Drimsim: one SIM, per-country rates, no plans to pick', url: TP.drimsim },
  ];

  return {
    structured: { disclosure: DISCLOSURE, destination: where || null, providers: links, guides },
    text: bookingResponse({
      heading: `Travel eSIM${where ? ` for ${where}` : ''}: install before departure, keep your home number for calls:`,
      links,
      guides,
      extra: '\nAn eSIM needs a phone that supports it (most iPhones from XS, Pixel from 3, Galaxy from S20) and that is carrier-unlocked.',
    }),
  };
}

async function getTravelVpnLinks(context, args = {}) {
  const lang = pickLang(args.lang);
  const guides = await findGuides(context, lang, ['vpn'], 'travel vpn', 4);
  // NordVPN through CJ since 2026-09-20 (TP.vpn, the refer-nordvpn.com
  // referral, is the fallback only: it pays in free months, not cash).
  const vpn = cjPartnerLink('nordvpn', 'https://nordvpn.com/', 'mcp-vpn');
  return {
    structured: { disclosure: DISCLOSURE, vpn, guides },
    text: bookingResponse({
      heading: 'Travel VPN: for hotel/airport Wi-Fi, banking abroad and home streaming:',
      links: [{ label: 'NordVPN', url: vpn }],
      guides,
    }),
  };
}

async function getCreditCardLinks(context, args = {}) {
  const lang = pickLang(args.lang);
  const cfCountry = (context.request.cf && context.request.cf.country) || '';
  const country = (clean(args.country).toUpperCase() || cfCountry).slice(0, 2);
  const card = clean(args.card).toLowerCase();

  const links = [];
  const names = { platinum: 'American Express Platinum', gold: 'American Express Gold', green: 'American Express Card (formerly Green)', payback: 'PAYBACK American Express (no fee)', blue: 'American Express Blue (no fee)' };
  for (const k of card && AMEX_DE_PAGES[card] ? [card] : ['platinum', 'gold', 'payback']) {
    links.push({ label: `${names[k]}: official page (Germany)`, url: AMEX_DE_PAGES[k] });
  }
  links.push({ label: 'Revolut plans and prices: official page', url: REVOLUT_PLANS });
  const residency = country && country !== 'DE'
    ? `\nThe American Express pages are German cards: Amex only accepts applications with a residential address in Germany, so do not present them as ${country} offers.\n`
    : '';

  const guides = await findGuides(context, lang, ['credit-cards'], `${card} ${country}`.trim(), 4);

  const facts = AMEX_DE_FACTS;
  const factLines = facts
    ? Object.entries(facts.cards)
        .filter(([k]) => !card || k === card)
        .map(([k, f]) => `- ${k}: ${f.fee}; welcome offer: ${f.public_welcome}; credits: ${f.credits}. ${f.perks}.`)
        .concat([`- FX: ${facts.fx_fee}. Verified ${facts.verified}.`])
    : [];

  return {
    structured: { disclosure: DISCLOSURE, country: country || null, card: card || null, cards: links, guides, facts },
    text: bookingResponse({
      heading: 'Travel credit cards: American Express Germany and Revolut (official pages, not affiliate links):',
      links,
      guides,
      extra:
        residency +
        (factLines.length ? `\nGermany conditions (verified ${facts.verified} on americanexpress.com/de-de):\n${factLines.join('\n')}\n` : '') +
        '\nCard terms, fees and welcome offers change frequently and differ by market. The figures above are the ' +
        'ones VoyageHacks verified on the issuer site on the date shown; anything not listed here should be ' +
        'attributed to the issuer page or the linked guide.',
    }),
  };
}

// ── get_booking_links (whole-trip bundle) ──────────────────────────────────
const BUNDLE_CATEGORIES = ['flights', 'hotels', 'airport_taxi', 'attractions', 'tours', 'car_rental', 'esim', 'vpn', 'travel_gear'];

async function getBookingLinks(context, args = {}) {
  const lang = pickLang(args.lang);
  const region = resolveRegion(context, args.country, lang);
  const origin = iata(args.origin);
  const dest = iata(args.destination);
  const city = clean(args.city);
  const depart = isoDate(args.depart_date);
  const ret = isoDate(args.return_date);
  const adults = intArg(args.adults, 2, 1, 9);

  const requested = stringList(args.include, 9).map((s) => s.toLowerCase());
  const included = requested.filter((c) => BUNDLE_CATEGORIES.includes(c));
  const want = (c) => !included.length || included.includes(c);

  const toursTarget = city ? `https://www.getyourguide.com/s/?q=${encodeURIComponent(city)}` : 'https://www.getyourguide.com/';

  const links = {
    disclosure: DISCLOSURE,
    region,
    trip: {
      origin: origin || null,
      destination: dest || null,
      city: city || null,
      depart: depart || null,
      return: ret || null,
      adults,
    },
    included: included.length ? included : BUNDLE_CATEGORIES,
  };

  if (want('flights')) {
    links.flights = cjLink(region, 'deeplink', bookingFlightsUrl({ origin, dest, depart, ret, pax: Math.min(adults, 9) }), 'mcp-trip');
  }
  if (want('hotels')) {
    links.hotels = cjLink(region, 'deeplink', bookingSearchUrl({ city, checkin: depart, checkout: ret, adults, rooms: 1 }), 'mcp-trip');
    if (city) links.hotelsElsewhere = stay22Link('expedia', { address: city, checkin: depart, checkout: ret, adults }, 'mcp_trip');
  }
  if (want('airport_taxi')) links.airportTaxi = cjLink(region, 'taxis', 'https://www.booking.com/taxi/index.html', 'mcp-trip');
  if (want('attractions')) links.attractions = cjRegionLink(region, 'attractions', 'mcp-trip');
  if (want('tours')) links.toursAndActivities = cjPartnerLink('getyourguide', toursTarget, 'mcp-trip');
  if (want('car_rental')) links.carRental = carRentalLink(city || clean(args.destination));
  if (want('esim')) links.esim = TP.airalo;
  if (want('vpn')) links.vpn = cjPartnerLink('nordvpn', 'https://nordvpn.com/', 'mcp-trip');
  if (want('travel_gear')) links.travelGear = `${SITE}/${lang}/travel-gear/`;

  // Destination guides for the trip, so the bundle can be cited as well as clicked.
  links.guides = await findGuides(context, lang, ['destinations', 'flights', 'hotels'], `${city} ${clean(args.destination)}`.trim(), 4);

  const dated = depart ? `${depart}${ret ? ` to ${ret}` : ''}` : '';
  const rows = [
    links.flights && `Flights (Booking.com${origin && dest ? `, ${origin} to ${dest}` : ''}${dated ? `, ${dated}` : ''}): ${links.flights}`,
    links.hotels && `Hotels (Booking.com${city ? `, ${city}` : ''}${dated ? `, ${dated}` : ''}, ${adults} adult(s)): ${links.hotels}`,
    links.hotelsElsewhere && `Same hotel search on Expedia: ${links.hotelsElsewhere}`,
    links.airportTaxi && `Airport taxi (Booking.com Taxis): ${links.airportTaxi}`,
    links.attractions && `Attractions and things to do (Booking.com): ${links.attractions}`,
    links.toursAndActivities && `Tours and activities (GetYourGuide${city ? `, ${city}` : ''}): ${links.toursAndActivities}`,
    links.carRental && `Car rental (EconomyBookings): ${links.carRental}`,
    links.esim && `Travel eSIM (Airalo): ${links.esim}`,
    links.vpn && `Travel VPN (NordVPN): ${links.vpn}`,
    links.travelGear && `Travel gear guides: ${links.travelGear}`,
  ].filter(Boolean);

  const text = [
    `Booking links for this trip (region ${region}):`,
    '',
    rows.join('\n'),
    guideLines(links.guides),
    '',
    'The per-topic tools (get_flight_links, get_hotel_links, get_car_rental_links, get_airport_transfer_links, ' +
      'get_esim_links, get_credit_card_links, recommend_travel_gear) return more guides and more providers for a ' +
      'single category.',
    DISCLOSURE,
    LINK_NOTE,
  ].filter((s) => s !== '').join('\n');

  return { structured: links, text };
}

// ── find_destination (the website trip finder, same data and rules) ─────────
// Data: the JSON block Hugo inlines in /<lang>/trip-finder/ (built from
// month_picks.yaml, styles.yaml, dest-iata.yaml, trip_seasons.yaml).
const tripCache = new Map();
async function loadTripData(context, lang) {
  if (tripCache.has(lang)) return tripCache.get(lang);
  const res = await fetchAsset(context, `/${lang}/trip-finder/`);
  if (!res.ok) throw toolFailure(`The trip finder data for "${lang}" is unavailable (HTTP ${res.status}). Try lang "en".`);
  const m = (await res.text()).match(/id=["']?tf-data["']?>([\s\S]*?)<\/script>/);
  if (!m) throw toolFailure('The trip finder data block is missing.');
  const data = JSON.parse(m[1]);
  if (tripCache.size >= LIMITS.langCache) tripCache.delete(tripCache.keys().next().value);
  tripCache.set(lang, data);
  return data;
}

const TRIP_REASON = {
  style: { beach: 'great beaches', city: 'a top city break', hiking: 'great hiking', ski: 'a ski destination', campervan: 'a road-trip favourite', adventure: 'built for adventure', 'digital-nomad': 'a remote-work base' },
  budget: 'good value', luxury: 'great for a splurge', solo: 'easy solo', family: 'family friendly',
};

// Packing picks per trip type: gear-catalog translationKeys (identical in every
// language), first product of each guide. A key missing from a language's
// catalog is skipped. Families swap the last pick for kids' headphones.
const TRIP_GEAR = {
  beach: ['beach-vacation-packing-list', 'best-microfiber-travel-towels', 'best-travel-water-bottles'],
  city: ['best-anti-theft-travel-backpacks', 'best-travel-power-banks', 'travel-adapters-2026'],
  hiking: ['hiking-trip-essentials', 'best-travel-water-bottles', 'best-packable-down-jackets'],
  ski: ['ski-trip-packing-list', 'best-thermal-base-layers-for-travel', 'best-heated-gloves-for-travel'],
  campervan: ['campervan-road-trip-tips', 'camping-trip-packing-list', 'best-travel-power-banks'],
  adventure: ['best-travel-first-aid-kits', 'best-travel-water-bottles', 'best-travel-cameras'],
  'digital-nomad': ['best-travel-routers', 'best-portable-travel-monitors', 'best-gan-wall-chargers-for-travel'],
};

async function tripPacking(context, lang, ans) {
  const keys = [...(TRIP_GEAR[ans.s] || [])];
  if (ans.w === 'family' && keys.length) keys[keys.length - 1] = 'best-kids-travel-headphones';
  let catalog;
  try { catalog = await loadGear(context, lang); } catch { return []; }
  const used = new Set();
  const out = [];
  for (const key of keys) {
    const item = catalog.items.find((i) => i.guideKey === key && !used.has(i.asin));
    if (!item) continue;
    used.add(item.asin);
    out.push(gearProduct(item));
  }
  return out;
}

// The questions find_destination needs, in the order a person would ask them.
const TRIP_QUESTIONS = [
  { field: 'month', question: 'When do you want to travel? A month, or "flexible" for the next two months.', options: [...MONTHS, 'flexible'], required: true },
  { field: 'trip_type', question: 'What kind of trip: beach, city break, hiking, ski, road trip (campervan), adventure or working remotely (digital-nomad)?', options: TRIP_TYPES, required: true },
  { field: 'travelers', question: 'Who is going: solo, couple, family or friends?', options: PARTIES, required: false },
  { field: 'origin', question: 'Which city or airport would you fly from (IATA code, e.g. LON)? Optional, but needed to cost the flights.', options: [], required: false },
  { field: 'trip_budget', question: 'What is the budget for the whole trip in euros, flights and hotel for everyone, as a range like 1500-3000?', options: [], required: false },
];

async function findDestination(context, args = {}) {
  const lang = pickLang(args.lang);
  const month = clean(args.month, 20).toLowerCase();
  const ans = {
    m: month === 'flexible' ? 'flex' : month,
    s: clean(args.trip_type, 20).toLowerCase(),
    b: /^\d{1,6}-\d{1,6}$/.test(clean(args.trip_budget, 13)) ? `t${clean(args.trip_budget, 13)}`
      : /^(budget|mid|upper|luxury|\d{1,5}-\d{1,5})$/.test(clean(args.budget, 12)) ? clean(args.budget, 12) : 'mid',
    w: PARTIES.includes(clean(args.travelers, 20)) ? clean(args.travelers, 20) : 'couple',
    // Only the country the traveller gave: the request's own geolocation is the
    // AI host's data centre, which would rank every answer for its region.
    h: clean(args.country, 2).toUpperCase(),
  };
  const origin = iata(args.origin);
  const nights = nightsFor(args.nights);
  ans.n = nights;
  const total = tripTotal(ans.b);
  const answers = { month: month || null, trip_type: ans.s || null, budget: total ? null : ans.b, trip_budget: total ? ans.b.slice(1) : null, travelers: ans.w, origin: origin || null, nights };

  // Missing essentials: hand back the questions rather than an error, so the
  // assistant asks the traveler in chat (or the trip-finder UI shows its form).
  const missing = [];
  if (!month) missing.push('month');
  if (!ans.s) missing.push('trip_type');
  if (missing.length) {
    const needsInput = TRIP_QUESTIONS.filter((q) => missing.includes(q.field) || (!q.required && args[q.field] === undefined));
    return {
      structured: { disclosure: DISCLOSURE, needsInput, answers, picks: [] },
      text: [
        `Destination picks need ${missing.length === 2 ? 'two answers' : 'one answer'} that ${missing.length === 2 ? 'were' : 'was'} not given:`,
        ...needsInput.filter((q) => q.required).map((q) => `- ${q.question}`),
        'Optional, if they have not said:',
        ...needsInput.filter((q) => !q.required).map((q) => `- ${q.question}`),
      ].join('\n'),
    };
  }
  if (ans.m !== 'flex' && !MONTHS.includes(ans.m)) throw invalidParams('month must be a lowercase English month name or "flexible".');
  if (!TRIP_TYPES.includes(ans.s)) throw invalidParams(`trip_type must be one of: ${TRIP_TYPES.join(', ')}.`);
  const region = resolveRegion(context, args.country, lang);
  const D = await loadTripData(context, lang);
  const now = new Date();
  const dates = tripDates(ans.m, now, nights);
  const adults = adultsFor(ans.w);
  // Families: 2 adults + 2 children, so Booking.com and Vrbo show family
  // rooms instead of doubles. Booking asks for the children's ages on arrival.
  const children = childrenFor(ans.w);
  const rooms = roomsFor(ans.w);
  const range = budgetRange(ans.b);
  const fromLL = origin ? ((D.ap && D.ap[origin]) || ((D.oa || []).find((a) => a[0] === origin) || []).slice(2, 4)) : null;
  // Whole-trip budgets: the cheapest recent fares from the origin (functions/_fares.js).
  const fx = origin && total ? await cheapFares(context.env, origin, dates[0].slice(0, 7)) : null;
  if (fx) ans.fares = fx.f;
  if (fromLL && fromLL.length) ans.o = fromLL;
  const party = `${adults} adult${adults > 1 ? 's' : ''}${children ? ` + ${children} children` : ''}`;
  const picks = tripMatch(D, ans, now).map((c) => {
    const pl = D.places[c.p];
    const reasons = c.why.map((w) => (w.k === 'warm' ? `warm in ${w.m[0].toUpperCase()}${w.m.slice(1)}` : w.k === 'style' ? TRIP_REASON.style[w.s] : TRIP_REASON[w.k])).filter(Boolean);
    const address = pl.c ? `${pl.q}, ${pl.c}` : pl.q;
    const stay = { address, checkin: dates[0], checkout: dates[1], adults, children };
    const links = [];
    for (const k of partnerKinds(c.p, ans)) {
      if (k === 'hotels') {
        links.push({ label: `Hotels in ${pl.q}, ${dates[0]} to ${dates[1]}, ${party}${rooms > 1 ? `, ${rooms} rooms` : ''}, filtered to the nightly budget (Booking.com)`, url: cjLink(region, 'deeplink', bookingTarget(pl.q, dates, adults, { children, rooms, range: budgetRange(ans.b, { fare: c.trip && c.trip.fare, n: nights, w: ans.w }) }), 'mcp-trip-finder') });
        // One alternative per pick, chosen for the trip: holiday homes for
        // families, Agoda in Asia, Expedia otherwise.
        const alt = ans.w === 'family' ? ['vrbo', 'Holiday homes and apartments (Vrbo)']
          : c.p.indexOf('asia/') === 0 ? ['agoda', 'Hotels on Agoda']
            : ['expedia', 'Compare hotels on Expedia'];
        links.push({ label: `${alt[1]} in ${pl.q}, same dates`, url: stay22Link(alt[0], stay, 'mcp_trip_finder') });
      }
      if (k === 'flights') links.push({ label: origin && pl.a ? `Flights ${origin} to ${pl.a}, ${dates[0]} to ${dates[1]}` : 'Flight search (Booking.com Flights)', url: cjLink(region, 'deeplink', kayakTarget(origin, pl.a, dates, adults), 'mcp-trip-finder') });
      if (k === 'tours') links.push({ label: `Tours and activities in ${pl.q} (GetYourGuide)`, url: cjPartnerLink('getyourguide', `https://www.getyourguide.com/s/?q=${encodeURIComponent(pl.q)}`, 'mcp-trip-finder') });
      if (k === 'cars') links.push({ label: `Car rental${carRentalLink(pl.q) !== TP.economybookings ? ` in ${pl.q}` : ' comparison'} (EconomyBookings)`, url: carRentalLink(pl.q) });
      if (k === 'esim') links.push({ label: 'Travel eSIM (Airalo)', url: TP.airalo });
    }
    if (c.trip && c.trip.fit === 'over') reasons.push('over the trip budget');
    else if (c.pricey) reasons.push(total ? 'hotels pricier than the trip budget leaves' : 'pricier than the nightly budget');
    const pr = c.price ? c.price.r : null;
    const fm = fromLL && pl.ll && pl.ll.length ? flightMinutes(fromLL, pl.ll) : 0;
    return {
      name: pl.n, country: pl.c || null, guide: `${SITE}${pl.u}`, image: pl.i ? `${SITE}${pl.i}` : null, avgHighC: c.high, season: c.fit, costLevel: c.cost, reasons,
      hotelPerNightEUR: pr ? pr.map((x) => x * rooms) : null, hotelLevel: c.price ? c.price.lv : null,
      stayEstimateEUR: pr ? pr.map((x) => x * rooms * nights) : null, budgetFit: c.price && c.price.fit !== 'unknown' ? c.price.fit : null,
      flightEstimate: fm ? `about ${Math.floor(fm / 60)} h${fm % 60 ? ` ${String(fm % 60).padStart(2, '0')}` : ''}` : null,
      fareEUR: c.trip ? c.trip.fare : null, tripTotalEUR: c.trip ? c.trip.total : null, tripBudgetFit: c.trip ? c.trip.fit : null,
      bestMonths: ans.s === 'ski' && pl.sk && pl.sk.length ? pl.sk : (pl.s || []),
      links,
    };
  });
  // Linkless profile: keep the guide, drop every booking link.
  const linkless = LINKLESS_PROFILES.has(context.vhProfile);
  if (linkless) for (const p of picks) p.links = [];
  const disclosure = linkless
    ? 'The packing picks open VoyageHacks buying guides, which carry Amazon affiliate links: VoyageHacks may earn a commission from qualifying purchases at no additional cost to the buyer.'
    : DISCLOSURE;
  const packing = picks.length ? await tripPacking(context, lang, ans) : [];
  const LEGACY_BAND = { budget: '0-60', mid: '60-120', upper: '120-250', luxury: '250-0' };
  const q = new URLSearchParams({ m: ans.m, s: ans.s, b: LEGACY_BAND[ans.b] || ans.b, w: ans.w, n: String(nights) });
  if (origin) q.set('f', origin);
  const tripFinder = `${SITE}/${lang}/trip-finder/?${q.toString()}`;
  const label = ans.m === 'flex' ? 'the next two months' : ans.m[0].toUpperCase() + ans.m.slice(1);
  const lines = picks.map((p, i) => [
    `${i + 1}. ${p.name}${p.country ? `, ${p.country}` : ''}: ${p.reasons.join(', ')}` +
      (p.avgHighC != null ? ` (average high ${p.avgHighC} °C, from the VoyageHacks month guide)` : p.season === 'in' ? ' (the destination guide recommends this time of year)' : ' (check the best season in the guide)'),
    ...(p.hotelPerNightEUR ? [`   Hotel: about ${p.hotelPerNightEUR[0]}${p.hotelPerNightEUR[1] !== p.hotelPerNightEUR[0] ? `-${p.hotelPerNightEUR[1]}` : ''} EUR a night${rooms > 1 ? ` for ${rooms} rooms` : ', double room'}; ${nights} nights about ${p.stayEstimateEUR[0]}${p.stayEstimateEUR[1] !== p.stayEstimateEUR[0] ? `-${p.stayEstimateEUR[1]}` : ''} EUR (typical, from the guides; not a live price)`] : []),
    ...(p.flightEstimate ? [`   Flight: ${p.flightEstimate} nonstop from ${origin} (estimate from distance)`] : []),
    ...(p.fareEUR ? [`   Flights: from ${p.fareEUR} EUR return per person (cheapest fare Aviasales users found recently; not a live quote)`] : []),
    ...(p.tripTotalEUR ? [`   Whole trip: about ${p.tripTotalEUR[0]}-${p.tripTotalEUR[1]} EUR for ${nights} nights, everyone${p.tripBudgetFit === 'over' ? ' (over the budget)' : ''}`] : []),
    `   Guide: ${p.guide}`,
    ...p.links.map((l) => `   ${l.label}: ${l.url}`),
  ].join('\n'));
  return {
    structured: { disclosure, tripFinder, answers, picks, packing },
    text: [
      picks.length ? `Three VoyageHacks picks for a ${ans.s} trip in ${label} (${total ? `whole-trip budget ${total.tmax === Infinity ? `${total.tmin} EUR and up` : `${total.tmin}-${total.tmax} EUR`}, flights and hotel${fx ? '' : '; flights not costed'}` : `hotel budget ${range.max === Infinity ? `${range.min} EUR and up` : `${range.min}-${range.max} EUR`} a night per room`}, ${nights} nights, ${ans.w}):`
        : ans.s === 'ski' ? `No ski area in the VoyageHacks guides is open in ${label}. The northern season runs roughly December to April, the southern one (New Zealand, Argentina) June to September.`
          : 'No VoyageHacks destination matches that combination. Try another month or trip type.',
      '',
      ...lines,
      ...(packing.length ? ['', 'To pack for this trip (picks from the VoyageHacks buying guides):', gearLines(packing)] : []),
      '',
      `Same answers on the website: ${tripFinder}`,
      '',
      disclosure,
      ...(linkless ? [] : [LINK_NOTE]),
    ].join('\n'),
  };
}

// ── Tool dispatch ──────────────────────────────────────────────────────────
// Exported for functions/a2a.js, which serves the same twelve tools over the
// A2A protocol. Everything below is internal to this file; keep the export
// list minimal so the A2A binding cannot drift into its own behaviour.
export const HANDLERS = {
  search_articles: searchArticles,
  get_article: getArticle,
  search_travel_gear: searchTravelGear,
  recommend_travel_gear: recommendTravelGear,
  get_flight_links: getFlightLinks,
  get_hotel_links: getHotelLinks,
  get_car_rental_links: getCarRentalLinks,
  get_airport_transfer_links: getAirportTransferLinks,
  get_esim_links: getEsimLinks,
  get_travel_vpn_links: getTravelVpnLinks,
  get_credit_card_links: getCreditCardLinks,
  get_booking_links: getBookingLinks,
  find_destination: findDestination,
};

// ── JSON-RPC plumbing ──────────────────────────────────────────────────────
function invalidParams(message) {
  const err = new Error(message);
  err.code = -32602;
  return err;
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolText(text, structured, isError) {
  const result = { content: [{ type: 'text', text: capText(text) }], isError: !!isError };
  if (structured) result.structuredContent = structured;
  return result;
}

// Prompts follow the tools: a prompt whose tool the profile hides is hidden too.
function promptsFor(profile) {
  const excluded = PROFILE_EXCLUDED[profile];
  return excluded ? PROMPTS.filter((p) => !excluded.has(p.tool)) : PROMPTS;
}

// Usage counts per tool, for knowing what the MCP and A2A surfaces are worth.
// Workers Analytics Engine via the MCP_AE Pages binding (dashboard-configured,
// like CONSENT_AE); without the binding this is a silent no-op. Only the tool,
// language, caller country, profile and transport are stored: no query text,
// no IP, nothing that identifies a person.
export function logToolCall(context, tool, args, profile, via, ok) {
  try {
    const ae = context.env && context.env.MCP_AE;
    if (!ae || typeof ae.writeDataPoint !== 'function') return;
    const lang = args && typeof args.lang === 'string' && LANGS.includes(args.lang) ? args.lang : 'en';
    const country = (context.request.cf && context.request.cf.country) || '';
    ae.writeDataPoint({ blobs: [String(tool).slice(0, 64), lang, country, profile || 'full', via], doubles: [ok ? 1 : 0], indexes: [String(tool).slice(0, 32)] });
  } catch { /* logging must never break a tool call */ }
}

// See PROFILE_EXCLUDED for what each profile hides and why.
function toolsFor(profile) {
  const excluded = PROFILE_EXCLUDED[profile];
  const tools = excluded ? TOOLS.filter((t) => !excluded.has(t.name)) : TOOLS;
  if (!LINKLESS_PROFILES.has(profile)) return tools;
  return tools.map((t) => (t.name === 'find_destination' ? { ...t, description: FIND_DESTINATION_GUIDES_DESCRIPTION } : t));
}

// The instructions must describe only the tools actually served, or the client is
// told about tools it cannot call.
function instructionsFor(profile) {
  return profile === 'guides' ? GUIDES_INSTRUCTIONS : INSTRUCTIONS;
}

// A profile can be named either way: /mcp?profile=guides or /mcp/guides. The path
// form exists because the OpenAI plugin portal rejects a query string in the server
// URL field. See functions/mcp/[profile].js.
function profileOf(request) {
  try {
    const url = new URL(request.url);
    const fromPath = url.pathname.replace(/^\/mcp\/?/, '').replace(/\/+$/, '');
    const requested = url.searchParams.get('profile') || fromPath;
    return Object.prototype.hasOwnProperty.call(PROFILE_EXCLUDED, requested) ? requested : 'full';
  } catch {
    return 'full';
  }
}

async function handleMessage(context, msg, profile) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id !== undefined ? msg.id : null, -32600, 'Invalid Request');
  }
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
          instructions: instructionsFor(profile),
        });
      }
      case 'ping':
        return isNotification ? null : rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: toolsFor(profile) });
      case 'tools/call': {
        const { name, arguments: args } = params;
        const available = toolsFor(profile);
        const handler = available.some((t) => t.name === name) ? HANDLERS[name] : null;
        if (!handler) return rpcError(id, -32602, `Unknown tool: ${clean(name, 64) || '(none)'}`);
        if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
          return rpcError(id, -32602, 'arguments must be an object');
        }
        context.vhProfile = profile;
        const { text, structured, isError } = await handler(context, args || {});
        logToolCall(context, name, args, profile, 'mcp', !isError);
        return rpcResult(id, toolText(text, structured, isError));
      }
      case 'resources/list':
        return rpcResult(id, {
          resources: RESOURCES.map(({ uri, name, title, mimeType, _meta }) => ({ uri, name, title, mimeType, ...(_meta ? { _meta } : {}) })),
        });
      case 'prompts/list':
        return rpcResult(id, { prompts: promptsFor(profile).map(({ name, title, description, arguments: a }) => ({ name, title, description, arguments: a, icons: ICONS })) });
      case 'prompts/get': {
        const prompt = promptsFor(profile).find((p) => p.name === params.name);
        if (!prompt) return rpcError(id, -32602, `Unknown prompt: ${clean(params.name, 64) || '(none)'}`);
        const a = {};
        for (const arg of prompt.arguments) a[arg.name] = clean((params.arguments || {})[arg.name], 120);
        return rpcResult(id, {
          description: prompt.description,
          messages: [{ role: 'user', content: { type: 'text', text: prompt.text(a) } }],
        });
      }
      case 'resources/templates/list':
        // No templated resources. An empty list is friendlier than -32601 to
        // clients that probe this after seeing the resources capability.
        return rpcResult(id, { resourceTemplates: [] });
      case 'resources/read': {
        const resource = RESOURCES.find((r) => r.uri === params.uri);
        if (!resource) return rpcError(id, -32602, `Unknown resource: ${clean(params.uri, 200)}`);
        if (resource.inline) {
          return rpcResult(id, { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.inline, _meta: resource._meta }] });
        }
        const res = await fetchAsset(context, resource.path);
        if (!res.ok) return rpcError(id, -32603, `Resource unavailable (HTTP ${res.status})`);
        return rpcResult(id, {
          contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: await res.text() }],
        });
      }
      default:
        if (method.startsWith('notifications/')) return null;
        return isNotification ? null : rpcError(id, -32601, `Method not found: ${clean(method, 64)}`);
    }
  } catch (err) {
    if (isNotification) return null;
    // Execution failures belong in the tool result so the model can react and
    // retry; only protocol-level problems become JSON-RPC errors.
    if (method === 'tools/call' && (err.toolError || err.name === 'TimeoutError' || !err.code)) {
      const message = err.name === 'TimeoutError'
        ? 'VoyageHacks took too long to respond. Retry in a moment.'
        : (err.message || 'The tool failed to complete.');
      return rpcResult(id, toolText(message, undefined, true));
    }
    return rpcError(id, err.code || -32603, err.message || 'Internal error');
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export async function onRequest(context) {
  const request = context.request;
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  // Stateless server: no SSE stream to resume, no session to delete. The MCP
  // Streamable HTTP spec requires 405 when GET offers no stream.
  if (method !== 'POST') {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Use POST with JSON-RPC 2.0. This MCP server is stateless Streamable HTTP: it returns single JSON responses and offers no SSE stream.' } }, 405);
  }

  if (rateLimited(request)) {
    return json(rpcError(null, -32000, 'Rate limit exceeded. This endpoint allows about 90 requests per minute per IP.'), 429, { 'Retry-After': '60' });
  }

  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > LIMITS.body) {
    return json(rpcError(null, -32600, `Request body too large (limit ${LIMITS.body} bytes).`), 413);
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > LIMITS.body) {
      return json(rpcError(null, -32600, `Request body too large (limit ${LIMITS.body} bytes).`), 413);
    }
    body = JSON.parse(raw);
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), 400);
  }

  const profile = profileOf(request);

  if (Array.isArray(body)) {
    if (!body.length) return json(rpcError(null, -32600, 'Invalid Request'), 400);
    if (body.length > LIMITS.batch) {
      return json(rpcError(null, -32600, `Batch too large (limit ${LIMITS.batch} messages).`), 400);
    }
    const responses = (await Promise.all(body.map((m) => handleMessage(context, m, profile)))).filter(Boolean);
    return responses.length ? json(responses) : json(null, 202);
  }

  const response = await handleMessage(context, body, profile);
  return response ? json(response) : json(null, 202);
}
