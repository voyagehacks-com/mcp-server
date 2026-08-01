# VoyageHacks MCP Server

The official [Model Context Protocol](https://modelcontextprotocol.io) server for
[VoyageHacks.com](https://voyagehacks.com), a multilingual (10 languages) travel site
covering flights, hotels, destinations, eSIMs, travel VPNs, credit cards and travel gear.

**Live endpoint:** `https://voyagehacks.com/mcp`

Stateless Streamable HTTP transport (JSON-RPC 2.0 over POST), no authentication, no
sessions. Any MCP client can connect and start calling tools immediately.

## Connect

**Claude Code**

```bash
claude mcp add --transport http voyagehacks https://voyagehacks.com/mcp
```

**Claude.ai / Claude Desktop:** Settings → Connectors → Add custom connector →
`https://voyagehacks.com/mcp`

**ChatGPT:** Settings → Connectors → Advanced → Developer mode, then add
`https://voyagehacks.com/mcp` as an MCP connector (no auth).

**MCP Inspector**

```bash
npx @modelcontextprotocol/inspector https://voyagehacks.com/mcp
```

## Tools

| Tool | What it does |
| --- | --- |
| `search_articles` | Full-text search over all articles in a given language |
| `get_article` | Fetch one article as clean Markdown |
| `search_travel_gear` | Search the travel gear catalog (products from every gear guide) |
| `recommend_travel_gear` | Map a free-text trip description to a packing kit |
| `get_flight_links` | Flight search links for a route or destination |
| `get_hotel_links` | Hotel search links for a city |
| `get_car_rental_links` | Car rental links |
| `get_airport_transfer_links` | Airport taxi / transfer links |
| `get_esim_links` | Travel eSIM links for a destination |
| `get_travel_vpn_links` | Travel VPN links |
| `get_credit_card_links` | Travel credit card referral links |
| `get_booking_links` | Everything for one trip in a single call |

Every vertical tool also returns up to 4 matching VoyageHacks guides in the requested
language, so agents can cite full articles alongside the links.

## Markdown for agents

The whole site is agent-readable, not just this server:

- `get_article` returns any page as Markdown.
- Any page on voyagehacks.com returns Markdown directly when requested with an
  `Accept: text/markdown` header (edge middleware, browsers are unaffected).
- Discovery files: [`/.well-known/mcp/server-card.json`](https://voyagehacks.com/.well-known/mcp/server-card.json),
  [`/llms.txt`](https://voyagehacks.com/llms.txt),
  [`/.well-known/agent-skills/`](https://voyagehacks.com/.well-known/agent-skills/index.json).

## Transparency

VoyageHacks is an affiliate-funded site. Booking and shopping links returned by these
tools are tracked affiliate links (Travelpayouts, CJ Affiliate / Booking.com, Amazon
Associates, American Express referrals). Every tool response ships a `DISCLOSURE`
field stating this, and tool descriptions say it plainly. Article content itself is
free to read, with no paywall and no auth.

## Self-hosting

This is a Cloudflare Pages Function (`functions/mcp.js`). To run your own instance:

1. Deploy the `functions/` directory with a Cloudflare Pages project.
2. The server reads its content live from the site it fronts: a Hugo build that emits
   `/<lang>/index.json` (search index) and `/<lang>/gear.json` (gear catalog). Point
   the `SITE` constant at your deployment.
3. Replace the affiliate constants near the top of `mcp.js` (marker, CJ ids, Amazon
   tag) with your own program ids.

This repository mirrors the production function. Keep the affiliate constants in sync
with your own site config if you fork it.

## License

[MIT](LICENSE)
