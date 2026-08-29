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
 * (params.cj.partners: getyourguide, vueling, budgetair, ihg, airserbia,
 * airindia, carla, hotelscom, undercovertourist) and the Amex links are
 * mirrored from hugo.yaml
 * (params.travelpayouts / params.cj.booking / params.cj.partners / params.amazon /
 * params.amex). This file is deployed as-is, not built by Hugo, so KEEP THEM
 * IN SYNC when hugo.yaml changes. The travel-gear product catalog is NOT
 * mirrored: it is read live from /<lang>/gear.json, which Hugo generates from
 * the articles' `products:` front matter (layouts/_default/index.gearjson.json).
 * search_articles reads Hugo's per-language search index (/<lang>/index.json).
 *
 * Content ships in 11 languages: en, de, fr, es, it, pl, cs, ja, nl, pt, zh
 * (LANGS below is the single source of truth, and feeds every tool's `lang`
 * enum). Keep it in sync with hugo.yaml, functions/index.js LANGS and
 * static/.well-known/mcp/server-card.json.
 */

import { htmlToMarkdown } from './html-to-markdown.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LANGS = ['en', 'de', 'fr', 'es', 'it', 'pl', 'cs', 'ja', 'nl', 'pt', 'zh'];
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
  // DACH's Attractions text link was retired (gone from the 2026-08-12
  // links.csv re-export): the slot is omitted br-style, cjLink falls back to NA.
  dach:    { deeplink: '14082404', taxis: '17322522', cars: '17122733' },
  cee:     { deeplink: '14312907', taxis: '17322543', cars: '17122732', attractions: '17254616' },
  benelux: { deeplink: '13397436', taxis: '17322536', cars: '17122731', attractions: '17254615' },
  uk:      { deeplink: '15734754', taxis: '17322563', cars: '17122730', attractions: '17254657' },
  espt:    { deeplink: '15734352', taxis: '17322554', cars: '17122734', attractions: '17254651' },
  mea:     { deeplink: '15734197', taxis: '17322550', cars: '17122729', attractions: '17254656' },
  apac:    { deeplink: '17293139', taxis: '17322570', cars: '17289008', attractions: '17289009' },
  au:      { deeplink: '17293136', taxis: '17322577', cars: '17304773', attractions: '17289014' },
  // Brazil's CJ program ships no Attractions link.
  br:      { deeplink: '17293138', taxis: '17322581', cars: '17288987' },
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
  getyourguide: '15735609', vueling: '15733900', budgetair: '17289819', ihg: '15734302',
  // Outdoor/adventure stores (Aug 2026): Kings Camo hunting + camping apparel,
  // Velocity Outdoor = Ravin / CenterPoint crossbows and archery.
  kingscamo: '15784057', velocityoutdoor: '15734445',
  // 2026-08-12 links.csv re-export: Air Serbia (Evergreen, deep-link enabled,
  // browser-verified), Carla Car Rental (Evergreen), Undercover Tourist
  // (Evergreen, discounted US theme-park tickets).
  airserbia: '15735227', carla: '17094338', undercovertourist: '15733832',
};
// Plain click-through TEXT links (NOT deep-link enabled: never append &url=,
// a non-deep-link ad would drop the target). airindia = "Air India: Homepage";
// hotelscom = "Hotels.com DACH Deeplink" (DE/AT/CH-targeted program).
const CJ_CLICK_PARTNERS = { airindia: '17102071', hotelscom: '17140575' };
function cjPartnerClickLink(partner, sid) {
  return `${CJ_CLICK_BASE}${CJ_CLICK_PARTNERS[partner]}?sid=${sid || 'mcp'}`;
}

// The site-wide Amazon tracking ID (owner decision 2026-08-03:
// 'voyagehacks-20' everywhere, matching hugo.yaml's params.amazon.tag; the
// old 'wajdikhattel-20' default is retired). Per-guide amazon_tag overrides
// from gear.json still win per product. Matches the public mirror at
// github.com/voyagehacks-com/mcp-server.
const AMAZON_TAG = 'voyagehacks-20';
const AMAZON_STOREFRONT = 'https://www.amazon.com/shop/divinediscoveriesforyou';

// params.amex: only de/en have per-product entries; everything else falls back
// to the language's generic link, exactly like layouts/_partials/amex-url.html.
const AMEX = {
  de: {
    platinum: 'https://americanexpress.com/de-de/referral/platinum?ref=wAJDIKaNdP&XLINK=MYCP',
    gold: 'https://americanexpress.com/de-de/referral/gold?ref=wAJDIKaNdP&XLINK=MYCP',
    // The Green Card was retired in Germany (2026); its successor "American
    // Express Card" is not in the referral programme (the old /referral/green
    // link renders an error page, verified 2026-08-18): plain product page.
    green: 'https://www.americanexpress.com/de-de/kreditkarte/american-express-card/',
    payback: 'https://americanexpress.com/de-de/referral/payback?ref=wAJDIKhChH',
    blue: 'https://www.americanexpress.com/de-de/angebot-blue/s',
    generic: 'https://www.americanexpress.com/de-de/kreditkarten/?ref=wAJDIKhChH',
  },
  en: { generic: 'https://www.americanexpress.com/' },
};
// German Amex conditions, verified on americanexpress.com/de-de on 2026-08-18
// (docs/amex-revolut-de-facts-2026-08.md is the source of truth). Returned by
// get_credit_card_links for Germany so agents quote current numbers instead of
// stale training data (Gold went from 144 EUR to 240 EUR/year, Green Card gone).
const AMEX_DE_FACTS = {
  verified: '2026-08-18',
  currency: 'EUR',
  fx_fee: '2% on non-EUR transactions (all cards); ATM cash 4%, min 5 EUR',
  cards: {
    platinum: { fee: '60 EUR/month = 720 EUR/year', public_welcome: 'up to 340 EUR statement credit (160 EUR after 6,000 EUR spend in 6 months + 180 EUR after a further 4,000 EUR)', referral_welcome: 'up to 85,000 Membership Rewards points (40,000 + 45,000, same spend thresholds)', credits: '650 EUR/year: 200 EUR travel (Amex Travel), 150 EUR dining, 200 EUR SIXT ride, 100 EUR shopping', perks: '1,550+ lounges (Priority Pass incl. one guest), hotel status upgrades, full travel insurance, up to 7 cards' },
    gold: { fee: '20 EUR/month = 240 EUR/year (was 144 EUR until 2025; no free first year any more)', public_welcome: 'up to 200 EUR statement credit (80 EUR after 3,000 EUR + 120 EUR after a further 2,000 EUR in 6 months)', referral_welcome: 'up to 50,000 Membership Rewards points (20,000 + 30,000)', credits: 'up to ~370 EUR/year: up to 20 EUR/month SIXT+, 2x25 EUR SIXT rent, 5 EUR/month FREENOW, 2x40 EUR Lodenfrey', perks: 'metal card (Gold or Rose), travel insurance incl. family, GHA Discovery Gold, no lounge access' },
    green: { fee: 'American Express Card (successor of the retired Green Card): 5 EUR/month = 60 EUR/year, waived from year 2 with 9,000 EUR annual spend', public_welcome: '40 EUR statement credit after 2,000 EUR spend in 6 months', referral_welcome: 'none (not in the referral programme)', credits: 'none', perks: 'Membership Rewards included, 1 point per EUR, one supplementary card' },
    blue: { fee: '0 EUR', public_welcome: '25 EUR statement credit after 1,200 EUR spend in 6 months', referral_welcome: 'none', credits: 'none', perks: 'Membership Rewards optional at 30 EUR/year (+5,000 starter points); earns nothing without it' },
    payback: { fee: '0 EUR', public_welcome: 'up to 3,000 PAYBACK bonus points', referral_welcome: '2,000 PAYBACK points for the first payment (promo, changes)', credits: 'none', perks: '1 PAYBACK point per 3 EUR (not at petrol stations) on top of partner points, points never expire, all supplementary cards free' },
  },
};

const AMEX_COUNTRIES = {
  DE: 'https://www.americanexpress.com/de-de/kreditkarten/?ref=wAJDIKhChH',
  US: 'https://www.americanexpress.com/us/credit-cards/',
  AT: 'https://www.americanexpress.com/de-at/kreditkarten/',
  FR: 'https://www.americanexpress.com/fr-fr/carte-de-paiement/types-cartes/cartes-proprietaires/',
  GB: 'https://www.americanexpress.com/en-gb/credit-cards/',
  CH: 'https://www.americanexpress.ch/de/karten/privatkunden-karten',
  IT: 'https://www.americanexpress.com/it/carte-di-pagamento/',
  ES: 'https://www.americanexpress.com/es/tarjetas/tarjetas-de-credito/',
  JP: 'https://www.americanexpress.com/ja-jp/credit-cards/',
  CA: 'https://www.americanexpress.com/en-ca/credit-cards/all-cards/',
};

// Affiliate disclosure. Shipped with every commercial response and named in
// every commercial tool description: Amazon Associates, CJ and Travelpayouts
// all require disclosure at the point the link is presented.
const DISCLOSURE =
  'Some links returned by this tool are affiliate links. VoyageHacks may earn a commission ' +
  'from qualifying bookings or purchases at no additional cost to the user. Disclose this ' +
  'when presenting the links.';

// Factual notes appended to link responses. Deliberately NOT instructions to
// the model about how to behave: Anthropic and OpenAI both reject tool output
// and descriptions that direct the assistant rather than describe the data.
const LINK_NOTE =
  'These are ordinary traveler-facing search and product pages. No signup is required and ' +
  'the price is the same as going direct.';

const SERVER_INFO = { name: 'voyagehacks', title: 'VoyageHacks', version: '2.1.0' };

// Tool profiles. The default profile exposes every tool. The "research"
// profile (GET/POST /mcp?profile=research) drops the two tools whose links
// land on a subscription signup (NordVPN) or a financial-product application
// (American Express), which is what OpenAI's app submission guidelines
// restrict. Same code, same data, no second deployment.
const RESEARCH_EXCLUDED = new Set(['get_travel_vpn_links', 'get_credit_card_links']);

const INSTRUCTIONS =
  'VoyageHacks is a multilingual travel guide site with about 680 published guides in each of ' +
  '11 languages (en, de, fr, es, it, pl, cs, ja, nl, pt, zh), covering flights, airline reviews, ' +
  'hotels, destinations, car rental, trains, airport transfers, eSIM, travel VPN, travel credit ' +
  'cards, travel gear and month-by-month "where to go" guides.\n\n' +
  'What the tools provide, by topic:\n' +
  '- Article research and citation: search_articles, then get_article for the full text.\n' +
  '- Travel products and packing: search_travel_gear (one category), recommend_travel_gear (a kit ' +
  'built from a trip description).\n' +
  '- Booking and shopping links: get_flight_links, get_hotel_links, get_car_rental_links, ' +
  'get_airport_transfer_links, get_esim_links, get_travel_vpn_links, get_credit_card_links, and ' +
  'get_booking_links for several categories of one trip in a single call.\n\n' +
  'Each vertical tool also returns up to four matching VoyageHacks guides in the requested ' +
  'language, with canonical URLs that can be cited as sources.\n\n' +
  'Scope and limits: the tools return published editorial content and search links. They do not ' +
  'return live prices, live availability or star ratings, and they cannot make a booking or ' +
  'complete a purchase. Many of the returned links are affiliate links: VoyageHacks may earn a ' +
  'commission at no additional cost to the user, which should be disclosed when the links are ' +
  'presented. No authentication is required.';

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
    buyUrl: { type: 'string', description: 'Amazon product page, carrying the VoyageHacks Associates tag.' },
    source: { type: 'string', description: 'Always "amazon".' },
    affiliate: { type: 'boolean', description: 'True: the buy link is an affiliate link.' },
    reviewGuide: {
      type: 'object',
      properties: { title: { type: 'string' }, url: { type: 'string' }, updated: { type: 'string' } },
      required: ['title', 'url'],
    },
  },
  required: ['name', 'asin', 'buyUrl', 'source', 'affiliate', 'reviewGuide'],
};

const LINKS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { label: { type: 'string' }, url: { type: 'string' } },
    required: ['label', 'url'],
  },
};

const TOOLS = [
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
      'step-by-step detail that can be attributed to a source URL, and as the first step before ' +
      'get_article. It searches VoyageHacks content only: not the wider web, not live fares or hotel ' +
      'availability, and it returns no booking or product links (the get_..._links tools do that).',
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
      'page itself. Useful after search_articles when the full text is needed to quote figures ' +
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
      'category, the published reason it was picked, the guide that reviews it, its Amazon ASIN and a ' +
      "link to the Amazon product page. Useful when a user asks which travel product to buy, or what " +
      'to pack for a trip and names a category or a destination. For a whole kit built from a trip ' +
      'description rather than one category, recommend_travel_gear is the matching tool. ' +
      'This is the VoyageHacks editorial catalog, not a search of all of Amazon: products outside the ' +
      'published guides are not findable here, and prices, star ratings, review counts and stock are ' +
      'not available and are never returned. The Amazon links are affiliate links: VoyageHacks may ' +
      'earn a commission from qualifying purchases at no additional cost to the buyer, which should ' +
      'be disclosed when the links are presented.',
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
      'ASIN, a link to the Amazon product page and the guide that reviews it. Takes a plain-language ' +
      'trip summary ("10 days in Japan in October, carry-on only, long-haul red-eye, working ' +
      'remotely") plus optional structured hints (destination, trip length in days, season, ' +
      'activities, luggage constraint, traveler type, budget), all of which are used to weight which ' +
      'categories make the kit. Answers questions of the form "what should I pack for X", "what gear ' +
      'do I need for Y" and "I only have carry-on, what should I bring". It draws on the VoyageHacks ' +
      'editorial catalog, not a search of all of Amazon, and returns published picks only: prices, ' +
      'star ratings, review counts and stock are not available and are never returned, and it ' +
      'produces no clothing sizes and no itinerary. For one named product category, ' +
      'search_travel_gear is narrower. The Amazon links ' +
      'are affiliate links: VoyageHacks may earn a commission from qualifying purchases at no ' +
      'additional cost to the buyer, which should be disclosed when the links are presented.',
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
      'compare fares. It returns search links only: no live fares, seat availability or schedules, no ' +
      'booking, and no airport transfer (get_airport_transfer_links covers that). Affiliate links: ' +
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
      'dates, guest count and room count, plus an IHG brand search link (Holiday Inn, ' +
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
      "Return American Express application links for the traveler's country (Platinum, Gold, American " +
      'Express Card, Payback and Blue where available), the current German fee and welcome-offer ' +
      'figures verified against americanexpress.com, and up to four VoyageHacks guides on points ' +
      'value, lounge access, foreign-transaction fees, Amex compared with Revolut and ' +
      'country-by-country availability. Useful when a user asks about travel rewards, points, miles, ' +
      'lounge access, which card to pay with abroad or foreign-transaction fees. It covers American ' +
      'Express only: it is not a comparison of all issuers, gives no eligibility or approval decision, ' +
      'no credit-score check and no application. Card terms change frequently and vary by market, so ' +
      'figures should be attributed to the issuer page or the linked guide. Referral links: ' +
      'VoyageHacks may earn a commission at no additional cost to the applicant, which should be ' +
      'disclosed when the links are presented.',
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
      'a user is planning a trip end to end and wants every option in one place. Each per-topic tool ' +
      '(get_flight_links, get_hotel_links, get_esim_links and the rest) returns richer detail and more ' +
      'guides for a single category. It returns search links only: no live prices, no availability and ' +
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
];

const RESOURCES = [
  { uri: `${SITE}/llms.txt`, name: 'llms.txt', title: 'Site overview for LLMs', mimeType: 'text/plain', path: '/llms.txt' },
  { uri: `${SITE}/auth.md`, name: 'auth.md', title: 'Authentication policy (none required)', mimeType: 'text/markdown', path: '/auth.md' },
  { uri: `${SITE}/.well-known/agent-skills/index.json`, name: 'agent-skills', title: 'Agent skills index (content + booking actions)', mimeType: 'application/json', path: '/.well-known/agent-skills/index.json' },
  { uri: `${SITE}/.well-known/api-catalog`, name: 'api-catalog', title: 'API catalog (RFC 9727 linkset)', mimeType: 'application/linkset+json', path: '/.well-known/api-catalog' },
  { uri: `${SITE}/en/gear.json`, name: 'gear-catalog', title: 'Travel gear catalog (products + ASINs)', mimeType: 'application/json', path: '/en/gear.json' },
  { uri: `${SITE}/sitemap.xml`, name: 'sitemap', title: 'XML sitemap', mimeType: 'application/xml', path: '/sitemap.xml' },
];

// ── Limits ─────────────────────────────────────────────────────────────────
// The endpoint is public and unauthenticated, so every input is bounded and
// nothing unbounded is ever echoed back. Without these a 400 KB `query` used
// to come back as a 243 KB response, and get_article on /ja/index.json
// returned 1.35 MB: both are amplification vectors, not just untidy output.
const LIMITS = {
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

function rateLimited(request) {
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

function amazonUrl(asin, tag) {
  // tag = the guide's per-category Associates tracking ID from gear.json
  // (amazon_tag front matter), so Amazon earnings map to a product category.
  return `https://www.amazon.com/dp/${asin}/?tag=${tag || AMAZON_TAG}`;
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
  // Only fields the catalog actually carries. Amazon's Product Advertising
  // API is not enabled for this account (params.amazon.paapi = false), so
  // price, star rating, review count and stock do not exist here and are
  // never invented: see the note in layouts/_default/index.gearjson.json.
  return {
    name: item.name,
    category: item.category || undefined,
    badge: item.badge || undefined,
    whyThisOne: item.blurb,
    asin: item.asin,
    buyUrl: amazonUrl(item.asin, item.tag),
    source: 'amazon',
    affiliate: true,
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
      `   Buy: ${p.buyUrl}`,
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
        `picked in published buying guides: ${catalog.hub}\nVoyageHacks Amazon storefront: ` +
        `${AMAZON_STOREFRONT}?tag=${AMAZON_TAG}\n\n${DISCLOSURE}`,
    };
  }

  return {
    structured: { query, lang, hub: catalog.hub, productCount: products.length, products, disclosure: DISCLOSURE },
    text: [
      `${products.length} product(s) in the VoyageHacks gear catalog for "${query}". Each link is an Amazon product page.`,
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
  { keys: ['best-gan-wall-chargers-for-travel', 'best-anker-chargers-for-travel', 'travel-power-strips'], weight: 4, triggers: ['laptop', 'work', 'working', 'remote', 'business', 'digital nomad', 'nomad', 'charger', 'charging', 'gadgets', 'devices', 'cruise', 'hotel room', 'outlet', 'outlets'] },
  { keys: ['travel-tech-organizers'], weight: 3, triggers: ['cables', 'cords', 'tech', 'gadgets', 'devices', 'laptop', 'nomad', 'organize', 'organise', 'chargers'] },

  // Bags and packing
  { keys: ['best-packing-cubes', 'best-compression-packing-bags'], weight: 6, triggers: ['carry-on', 'carry on', 'cabin', 'hand luggage', 'pack', 'packing', 'organize', 'organise', 'light', 'minimal', 'backpacking', 'weeks', 'month', 'winter', 'bulky', 'jackets'] },
  { keys: ['best-carry-on-travel-backpacks', 'carry-on-backpacks-women', 'personal-item-bags'], weight: 5, triggers: ['backpack', 'carry-on', 'carry on', 'cabin', 'hand luggage', 'no checked bag', 'budget airline', 'ryanair', 'wizz', 'easyjet', 'personal item', 'under the seat', 'under-seat', 'backpacking', 'hostel'] },
  { keys: ['luggage-scales-2026'], weight: 3, triggers: ['checked', 'checked bag', 'suitcase', 'weight', 'overweight', 'baggage fee', 'budget airline', 'ryanair', 'wizz', 'easyjet', 'allowance'] },
  { keys: ['luggage-trackers-2026', 'airtag-tile-chipolo-luggage', 'travel-gifts'], weight: 5, triggers: ['checked', 'checked bag', 'suitcase', 'connection', 'connecting', 'lost luggage', 'transfer', 'multi-city', 'multi city', 'family', 'kids', 'airtag', 'tracker', 'gift', 'present'] },

  // Sleeping and comfort on the way
  { keys: ['best-travel-neck-pillows', 'travel-pillows-long-haul', 'long-flight-essentials'], weight: 6, triggers: ['long-haul', 'longhaul', 'red-eye', 'red eye', 'overnight', 'night flight', 'sleep', 'sleeping', 'jet lag', 'jetlag', 'economy', 'hours', 'train', 'bus'] },
  { keys: ['best-earplugs-and-eye-masks-for-flights', 'travel-white-noise-machines'], weight: 6, triggers: ['long-haul', 'longhaul', 'red-eye', 'red eye', 'overnight', 'night flight', 'sleep', 'sleeping', 'jet lag', 'jetlag', 'noise', 'noisy', 'baby', 'hostel', 'ear', 'hours'] },
  { keys: ['airplane-footrests'], weight: 3, triggers: ['long-haul', 'longhaul', 'economy', 'legs', 'swelling', 'tall', 'short', 'hours', 'overnight'] },
  { keys: ['compression-socks-flights'], weight: 4, triggers: ['long-haul', 'longhaul', 'swelling', 'legs', 'circulation', 'dvt', 'pregnant', 'hours', 'overnight', 'ultra-long'] },

  // Toiletries and clothing
  { keys: ['best-hanging-toiletry-bags'], weight: 4, triggers: ['toiletries', 'toiletry', 'liquids', 'tsa', 'shampoo', 'hostel', 'carry-on', 'carry on', 'cabin'] },
  { keys: ['best-travel-size-bottles'], weight: 4, triggers: ['toiletries', 'liquids', 'tsa', 'shampoo', 'skincare', 'carry-on', 'carry on', 'cabin', 'hand luggage'] },
  { keys: ['best-travel-makeup-bags'], weight: 3, triggers: ['makeup', 'make-up', 'cosmetics', 'skincare', 'beauty', 'wedding'] },
  { keys: ['travel-steamers-dual-voltage'], weight: 3, triggers: ['business', 'suit', 'shirt', 'wedding', 'conference', 'formal', 'creases', 'wrinkles', 'iron'] },

  // Connectivity and language
  { keys: ['best-travel-routers', 'travel-router-hotel-wifi'], weight: 4, triggers: ['hotel wifi', 'wifi', 'wi-fi', 'work', 'working', 'remote', 'nomad', 'streaming', 'vpn', 'security', 'airbnb', 'apartment'] },
  { keys: ['best-translation-earbuds'], weight: 3, triggers: ['language', 'translation', 'translate', 'japan', 'china', 'korea', 'vietnam', 'thailand', 'brazil', 'business'] },
  { keys: ['best-travel-gadgets-2026'], weight: 2, triggers: ['gadget', 'gadgets', 'tech', 'electronics'] },

  // Shooting the trip
  { keys: ['best-travel-cameras', 'best-travel-drones-for-vlogging'], weight: 4, triggers: ['camera', 'photo', 'photography', 'photos', 'vlog', 'vlogging', 'filming', 'video', 'content', 'drone', 'creator'] },

  // Cold weather
  { keys: ['christmas-market-packing-list', 'winter-christmas-travel-tips', 'best-heated-vests-and-hand-warmers-for-travel'], weight: 6, triggers: ['christmas market', 'christmas markets', 'weihnachtsmarkt', 'freezing', 'sub-zero', 'cold', 'thermal', 'base layer', 'december', 'january', 'lapland', 'iceland', 'norway', 'finland', 'northern lights'] },
  { keys: ['ski-trip-packing-list', 'ski-gear-to-buy-before-you-rent'], weight: 6, triggers: ['ski', 'skiing', 'snowboard', 'snowboarding', 'slopes', 'piste', 'alps', 'resort', 'chalet', 'apres'] },

  // Outdoors
  { keys: ['hiking-trip-essentials'], weight: 5, triggers: ['hike', 'hiking', 'trek', 'trekking', 'trail', 'trails', 'day hike', 'mountains', 'walking'] },
  { keys: ['camping-trip-packing-list', 'camping-trip-tips-for-beginners'], weight: 6, triggers: ['camp', 'camping', 'campsite', 'tent', 'wild camping', 'outdoors'] },
  { keys: ['campervan-road-trip-tips'], weight: 5, triggers: ['campervan', 'camper van', 'motorhome', 'rv', 'van life', 'vanlife', 'road trip'] },
  { keys: ['hunting-trip-gear-checklist', 'crossbow-hunting-trip-guide'], weight: 6, triggers: ['hunt', 'hunting', 'crossbow', 'archery', 'bow', 'deer', 'elk'] },
  { keys: ['beach-vacation-packing-list'], weight: 5, triggers: ['beach', 'beaches', 'island', 'islands', 'coast', 'seaside', 'snorkel', 'snorkeling', 'swim', 'swimming', 'resort', 'maldives', 'caribbean'] },

  // Travelling with others
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

  return {
    structured: { disclosure: DISCLOSURE, region, city: city || null, checkin: checkin || null, checkout: checkout || null, adults, children, rooms, hotelSearch: url, ihg, guides },
    text: bookingResponse({
      heading: `Hotel search on Booking.com${city ? `: ${city}` : ''}${checkin && checkout ? `, ${checkin} to ${checkout}` : ''} (${adults} adult(s)${children ? `, ${children} child(ren)` : ''}, ${rooms} room(s)):`,
      links: [
        { label: 'Search stays (Booking.com, free cancellation on most rooms)', url },
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
    { label: 'Compare rental prices worldwide (EconomyBookings)', url: TP.economybookings },
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
  return {
    structured: { disclosure: DISCLOSURE, vpn: TP.vpn, guides },
    text: bookingResponse({
      heading: 'Travel VPN: for hotel/airport Wi-Fi, banking abroad and home streaming:',
      links: [{ label: 'NordVPN', url: TP.vpn }],
      guides,
    }),
  };
}

async function getCreditCardLinks(context, args = {}) {
  const lang = pickLang(args.lang);
  const cfCountry = (context.request.cf && context.request.cf.country) || '';
  const country = (clean(args.country).toUpperCase() || cfCountry).slice(0, 2);
  const card = clean(args.card).toLowerCase();

  const byLang = AMEX[lang] || AMEX.en;
  const countryUrl = AMEX_COUNTRIES[country] || '';
  const generic = countryUrl || byLang.generic || AMEX.en.generic;

  const links = [];
  if (card && byLang[card]) {
    links.push({ label: `American Express ${card[0].toUpperCase()}${card.slice(1)}`, url: byLang[card] });
  } else if (byLang.platinum) {
    links.push({ label: 'American Express Platinum', url: byLang.platinum });
    links.push({ label: 'American Express Gold', url: byLang.gold });
    links.push({ label: 'American Express Card (formerly Green Card)', url: byLang.green });
    if (byLang.payback) links.push({ label: 'American Express Payback', url: byLang.payback });
    if (byLang.blue) links.push({ label: 'American Express Blue', url: byLang.blue });
  }
  links.push({ label: `All American Express cards${country ? ` (${country})` : ''}`, url: generic });

  const guides = await findGuides(context, lang, ['credit-cards'], `${card} ${country}`.trim(), 4);

  const facts = (country === 'DE' || (!country && lang === 'de')) ? AMEX_DE_FACTS : null;
  const factLines = facts
    ? Object.entries(facts.cards)
        .filter(([k]) => !card || k === card)
        .map(([k, f]) => `- ${k}: ${f.fee}; welcome: ${f.public_welcome}; via referral: ${f.referral_welcome}; credits: ${f.credits}. ${f.perks}.`)
        .concat([`- FX: ${facts.fx_fee}. Verified ${facts.verified}.`])
    : [];

  return {
    structured: { disclosure: DISCLOSURE, country: country || null, card: card || null, cards: links, guides, facts },
    text: bookingResponse({
      heading: `Travel credit cards${country ? ` available in ${country}` : ''}:`,
      links,
      guides,
      extra:
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
  }
  if (want('airport_taxi')) links.airportTaxi = cjLink(region, 'taxis', 'https://www.booking.com/taxi/index.html', 'mcp-trip');
  if (want('attractions')) links.attractions = cjRegionLink(region, 'attractions', 'mcp-trip');
  if (want('tours')) links.toursAndActivities = cjPartnerLink('getyourguide', toursTarget, 'mcp-trip');
  if (want('car_rental')) links.carRental = TP.economybookings;
  if (want('esim')) links.esim = TP.airalo;
  if (want('vpn')) links.vpn = TP.vpn;
  if (want('travel_gear')) links.travelGear = `${SITE}/${lang}/travel-gear/`;

  // Destination guides for the trip, so the bundle can be cited as well as clicked.
  links.guides = await findGuides(context, lang, ['destinations', 'flights', 'hotels'], `${city} ${clean(args.destination)}`.trim(), 4);

  const dated = depart ? `${depart}${ret ? ` to ${ret}` : ''}` : '';
  const rows = [
    links.flights && `Flights (Booking.com${origin && dest ? `, ${origin} to ${dest}` : ''}${dated ? `, ${dated}` : ''}): ${links.flights}`,
    links.hotels && `Hotels (Booking.com${city ? `, ${city}` : ''}${dated ? `, ${dated}` : ''}, ${adults} adult(s)): ${links.hotels}`,
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

// ── Tool dispatch ──────────────────────────────────────────────────────────
const HANDLERS = {
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

// The "research" profile hides the two tools whose links land on a
// subscription signup or a financial-product application. See RESEARCH_EXCLUDED.
function toolsFor(profile) {
  return profile === 'research' ? TOOLS.filter((t) => !RESEARCH_EXCLUDED.has(t.name)) : TOOLS;
}

function profileOf(request) {
  try {
    return new URL(request.url).searchParams.get('profile') === 'research' ? 'research' : 'full';
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
          },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
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
        const { text, structured, isError } = await handler(context, args || {});
        return rpcResult(id, toolText(text, structured, isError));
      }
      case 'resources/list':
        return rpcResult(id, {
          resources: RESOURCES.map(({ uri, name, title, mimeType }) => ({ uri, name, title, mimeType })),
        });
      case 'resources/templates/list':
        // No templated resources. An empty list is friendlier than -32601 to
        // clients that probe this after seeing the resources capability.
        return rpcResult(id, { resourceTemplates: [] });
      case 'resources/read': {
        const resource = RESOURCES.find((r) => r.uri === params.uri);
        if (!resource) return rpcError(id, -32602, `Unknown resource: ${clean(params.uri, 200)}`);
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
