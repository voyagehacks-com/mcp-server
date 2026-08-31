// Path-addressed profiles: /mcp/guides is identical to /mcp?profile=guides.
//
// This exists because the OpenAI plugin submission portal rejects a query string
// in the MCP Server URL field: with "?profile=guides" the draft save fails with
// "MCP details save failed" and the Scan Tools button never issues a request,
// while the same URL without the query string scans instantly. Verified in the
// portal on 2026-08-31.
//
// The single-segment [profile] route matches /mcp/<something> and deliberately
// does NOT match /mcp itself, which functions/mcp.js keeps serving. A catch-all
// ([[path]]) would match both and collide with it.
//
// profileOf() in ../mcp.js reads the profile from either form, so the request is
// forwarded untouched. That matters: rebuilding it would drop `request.cf`, which
// the regional Booking.com ad ids depend on.
export { onRequest } from '../mcp.js';
