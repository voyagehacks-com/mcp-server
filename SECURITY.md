# Security

The VoyageHacks MCP server at `https://voyagehacks.com/mcp` is public,
unauthenticated and read-only. It runs as a Cloudflare Pages Function on the
edge. It has no database, no account system, no write path and no secrets that a
caller could reach: the only identifiers it embeds are affiliate tracking IDs,
which are public by design and appear in the HTML of every page on the site.

## Reporting a vulnerability

Email **support@voyagehacks.com** with "MCP security" in the subject. Include the
request that reproduces the issue. We aim to acknowledge within 3 business days.
Please do not run load or denial-of-service tests against the production
endpoint; ask first and we will arrange a window.

## Threat model

| Threat | Status |
| --- | --- |
| Data exfiltration | Nothing private exists to exfiltrate. Every byte the server can return is already published at a public URL on voyagehacks.com. |
| Write or destructive actions | None exist. All 12 tools are read-only and annotated as such. There is no tool that creates, updates, deletes, posts, sends, pays or books. |
| Credential theft | No credentials are accepted, requested or stored. The server never asks for payment details, passwords, tokens, health data or identity documents. |
| SSRF | `get_article` and `resources/read` fetch **only** through the Cloudflare `ASSETS` binding, which serves this site's static build and nothing else. No caller-supplied host, scheme or port ever reaches a fetch. |
| Path abuse | `get_article` requires a language-prefixed page path matching `^/[a-z]{2}(/[A-Za-z0-9%._~-]+)*/?$`, rejects any final segment containing a dot (so data files and images are refused), rejects off-site hostnames, and verifies the response content type is `text/html`. |
| Response amplification | Article Markdown is capped at 60,000 characters with a truncation marker, and every tool's text content is capped at 120,000 characters. |
| Input amplification | Every string argument is length-capped at parse time (`query` 300, `trip` 600, names 120, `url` 400) and the capped value, not the original, is what appears in the response. |
| Request flooding | 256 KB body cap, 25-message batch cap, and a per-isolate fixed-window rate limit of about 90 requests per minute per IP returning HTTP 429 with `Retry-After`. |
| Slow upstream | Every asset fetch carries a 6-second `AbortSignal.timeout`, surfaced to the caller as an `isError` tool result. |
| Memory growth | The per-isolate article and gear caches hold at most 4 languages and evict the oldest, so walking all 11 languages cannot grow an isolate without bound. |
| Prompt injection **into** the model | Tool descriptions and responses describe data; they do not direct the assistant. All returned prose is VoyageHacks' own published editorial content, not third-party user input. Control characters (including ESC) are stripped from every echoed argument, so a caller cannot forge tool output through an error message or a reflected query. |
| Prompt injection **out of** the tools | The `USE THESE TOOLS FOR ANY TRAVEL QUESTION`, `CALL THIS`, `Never hand out a bare amazon.com link` and `HOW TO USE THIS` strings present in 2.0.0 were removed in 2.1.0. |
| Affiliate link tampering | Every outbound URL is built server-side from constants in `functions/mcp.js`. No caller-supplied string is ever used as a link target; caller input only ever reaches a URL as a percent-encoded query value (a city name, a search term). |
| Cache poisoning | Every response is `Cache-Control: no-store`. |
| DNS rebinding | Not applicable: the server is not bound to localhost and holds no local resources. `Access-Control-Allow-Origin: *` is deliberate so browser-based MCP clients can connect to a public read-only content API. |

## Rate limiting: what it is and is not

The built-in limiter is a fixed-window counter held in the Worker isolate's
memory. Cloudflare spreads traffic across many isolates and colos, so it is a
safety net against one client hammering one isolate, **not** a global quota. It
requires no database, no KV and no extra cost, which is the trade being made.

The durable control is a **Cloudflare WAF rate-limiting rule** on the `/mcp`
path, configured in the hosting dashboard.

## Authentication

None, by design, and this will not change. The discovery documents at
`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`
and `/.well-known/jwks.json` exist so an agent can verify programmatically that
no token issuer exists, and `/auth.md` says the same in prose. The MCP-specific
path `/.well-known/oauth-protected-resource/mcp` returns 404, which is the
correct signal to an MCP client that this resource is not OAuth-protected. The
server never returns 401, so a spec-compliant client never begins an OAuth flow.

## Dependencies

One import, `htmlToMarkdown` from `functions/html-to-markdown.js`, in this
repository (production imports the identical function from the site's
`_middleware.js`). No third-party runtime dependencies, no npm packages at the edge, and
therefore no supply chain to compromise at request time.
