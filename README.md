# VoyageHacks MCP Server

The official [Model Context Protocol](https://modelcontextprotocol.io) server for
[VoyageHacks.com](https://voyagehacks.com), a travel publisher with about 680
fact-checked guides in each of 11 languages, covering flights, airline reviews,
hotels, destinations, car rental, trains, airport transfers, eSIM, travel VPN,
travel credit cards and travel gear.

**Live endpoint:** `https://voyagehacks.com/mcp`
**Version:** 2.1.0
**Docs:** <https://voyagehacks.com/en/mcp-server/>

Stateless Streamable HTTP transport (JSON-RPC 2.0 over POST, single JSON
responses, no SSE, no sessions), no authentication. Any MCP client can connect
and start calling tools immediately. A `GET` returns 405 by design: the server
offers no SSE stream, which is what the Streamable HTTP specification asks for
in that case.

Listed on the [official MCP Registry](https://registry.modelcontextprotocol.io)
as `com.voyagehacks/travel`.

## Connect

**Claude Code**

```bash
claude mcp add --transport http voyagehacks https://voyagehacks.com/mcp
```

**Claude.ai / Claude Desktop:** Settings, Connectors, Add custom connector,
`https://voyagehacks.com/mcp`, authentication "No authentication".

**ChatGPT:** Settings, Connectors, add `https://voyagehacks.com/mcp`, no auth.

**Perplexity** (Pro, Max, Enterprise): Settings, Connectors, Custom connector,
Remote, `https://voyagehacks.com/mcp`, authentication "None".

**Gemini Enterprise:** create a custom MCP server data store with the HTTPS
endpoint and "No Authentication". The transport is StreamableHTTP, which is what
Gemini Enterprise requires.

**MCP Inspector**

```bash
npx @modelcontextprotocol/inspector
```

## Tools

All twelve are read-only, annotated `readOnlyHint: true` and
`destructiveHint: false`, and have no side effect outside their response. Each
declares an `outputSchema` and returns `structuredContent` alongside readable text.

| Tool | What it does |
| --- | --- |
| `search_articles` | Full-text search over the guides in one language, with an optional section filter |
| `get_article` | One page as Markdown, plus its title, language, section, publication date and last-updated date read from the page itself |
| `search_travel_gear` | Search the VoyageHacks travel gear catalog, about 320 products picked across roughly 50 published buying guides |
| `recommend_travel_gear` | Turn a trip description into a packing kit, one product per category, with optional structured hints |
| `get_flight_links` | Flight search links for a route and dates |
| `get_hotel_links` | Hotel search links for a city, dates, guests and rooms |
| `get_car_rental_links` | Car and scooter rental comparison links |
| `get_airport_transfer_links` | Airport taxi and pre-booked transfer links |
| `get_esim_links` | Travel eSIM store links for a destination |
| `get_travel_vpn_links` | Travel VPN links |
| `get_credit_card_links` | American Express links for a country, plus verified German fee figures |
| `get_booking_links` | Several categories of one trip in a single call, filtered by `include` |

Every vertical tool also returns up to 4 matching VoyageHacks guides in the
requested language, so agents can cite full articles alongside the links.

**Languages:** `en`, `de`, `fr`, `es`, `it`, `pl`, `cs`, `ja`, `nl`, `pt`, `zh`.
Every tool takes a `lang` parameter, defaulting to `en`. Each language is an
independently written version of the guide, not a machine translation.

## Profiles

| Profile | Endpoint | Tools |
| --- | --- | --- |
| full (default) | `https://voyagehacks.com/mcp` | 12 |
| research | `https://voyagehacks.com/mcp?profile=research` | 10 |
| guides | `https://voyagehacks.com/mcp?profile=guides` | 4 |

The research profile omits `get_travel_vpn_links` and `get_credit_card_links`,
whose links land on a subscription signup and a financial-product application.
It exists for app directories whose guidelines restrict linking to pages that
initiate a subscription or purchase.

The guides profile goes further and omits every booking tool, leaving
`search_articles`, `get_article`, `search_travel_gear` and
`recommend_travel_gear`. Its only outbound purchases are Amazon product pages for
physical travel gear, so it satisfies directories that allow commerce for physical
goods only. It also serves its own `initialize` instructions, which describe the
four tools it actually has rather than the full twelve.

Each profile is addressable two ways: `/mcp?profile=guides` and `/mcp/guides` are
the same handler. The path form exists because the OpenAI plugin submission portal
rejects a query string in its MCP Server URL field.

An unrecognized profile, in either form, falls back to the full tool set, so a typo
can never silently serve fewer tools than intended.

## What it does not do

The server returns published editorial content and search links. It has no live
fares, no live room rates, no availability check, no star ratings or review
counts, and it cannot make a booking or take a payment.

The travel gear catalog is VoyageHacks' own editorial selection, not a search of
all of Amazon. It carries **no prices, ratings, review counts or stock**: the
Amazon Product Advertising API is not enabled for this account, so any such value
would be invented. The tools never return those fields.

## Limits

About 90 requests per minute per IP, 256 KB per request body, 25 messages per
JSON-RPC batch, articles truncated at 60,000 characters. Over the rate limit the
server returns HTTP 429 with `Retry-After`. See [SECURITY.md](SECURITY.md).

## Markdown for agents

The whole site is agent-readable, not just this server:

- `get_article` returns any page as Markdown.
- Any page on voyagehacks.com returns Markdown directly when requested with an
  `Accept: text/markdown` header (edge middleware, browsers are unaffected).
- Discovery files:
  [`/.well-known/mcp/server-card.json`](https://voyagehacks.com/.well-known/mcp/server-card.json),
  [`/llms.txt`](https://voyagehacks.com/llms.txt),
  [`/.well-known/agent-skills/index.json`](https://voyagehacks.com/.well-known/agent-skills/index.json),
  [`/.well-known/api-catalog`](https://voyagehacks.com/.well-known/api-catalog),
  [`/auth.md`](https://voyagehacks.com/auth.md).

## Transparency

VoyageHacks is an affiliate-funded publisher. Some booking and shopping links
returned by these tools are affiliate links (Booking.com through CJ Affiliate,
Amazon Associates, Travelpayouts, American Express referral). VoyageHacks may
earn a commission from qualifying bookings or purchases at no additional cost to
the user.

Every commercial tool states this in its `description`, and every commercial
response repeats it in both its text content and `structuredContent.disclosure`,
so an assistant can disclose it to the end user. The word "affiliate" is kept out
of tool `name` and `title` values because agents route on those strings and it
measurably suppresses selection; it belongs in the description and the response,
which is where disclosure obligations actually attach.

Article content is free to read, with no paywall and no authentication.

## Self-hosting

This is a Cloudflare Pages Function (`functions/mcp.js`). To run your own instance:

1. Deploy the `functions/` directory with a Cloudflare Pages project.
2. The server reads its content live from the site it fronts: a Hugo build that
   emits `/<lang>/index.json` (search index) and `/<lang>/gear.json` (gear
   catalog). Point the `SITE` constant at your deployment.
3. Replace the affiliate constants near the top of `mcp.js` (Travelpayouts
   marker, CJ ids, Amazon tag, Amex links) with your own program ids.

This repository mirrors the production function. The only intentional difference
is the import on line 37: production imports `htmlToMarkdown` from the site's
`_middleware.js`, this mirror from its own `html-to-markdown.js`. If you fork it,
keep the affiliate constants in sync with your own site config.

## Privacy, terms and support

- Privacy policy: <https://voyagehacks.com/en/privacy/>
- Terms of use: <https://voyagehacks.com/en/terms/>
- Security policy: [SECURITY.md](SECURITY.md)
- Support and security reports: support@voyagehacks.com

## License

[MIT](LICENSE)
