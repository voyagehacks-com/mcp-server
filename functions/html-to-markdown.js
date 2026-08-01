/**
 * Minimal HTML to Markdown converter running in the Workers edge runtime.
 * No DOM available: uses regex over serialized HTML.
 * Used by the MCP server's get_article tool. In production the same helper
 * also powers "Accept: text/markdown" responses for any page on the site.
 */

const BLOCK_TAGS = ['script', 'style', 'noscript', 'nav', 'footer', 'aside', 'header', 'form', 'button', 'iframe'];

export function htmlToMarkdown(html) {
  // Extract <title>
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Extract <main> or <article> or <body> content
  let body = '';
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  body = (mainMatch || articleMatch || [null, html])[1];

  // Remove blocked tags and their content
  for (const tag of BLOCK_TAGS) {
    body = body.replace(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
  }

  // Headings
  body = body.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `# ${strip(t)}\n\n`);
  body = body.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `## ${strip(t)}\n\n`);
  body = body.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `### ${strip(t)}\n\n`);
  body = body.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_, t) => `#### ${strip(t)}\n\n`);

  // Paragraphs
  body = body.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => `${strip(t)}\n\n`);

  // Lists
  body = body.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `- ${strip(t)}\n`);
  body = body.replace(/<\/?[uo]l[^>]*>/gi, '\n');

  // Links
  body = body.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const t = strip(text);
    if (!t) return '';
    return href.startsWith('http') ? `[${t}](${href})` : t;
  });

  // Bold / italic
  body = body.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_, t) => `**${strip(t)}**`);
  body = body.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, (_, t) => `**${strip(t)}**`);
  body = body.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (_, t) => `_${strip(t)}_`);
  body = body.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, (_, t) => `_${strip(t)}_`);

  // Line breaks
  body = body.replace(/<br\s*\/?>/gi, '\n');
  body = body.replace(/<hr\s*\/?>/gi, '\n---\n');

  // Strip remaining tags
  body = body.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  body = body
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, ', ')
    .replace(/&ndash;/g, '–');

  // Collapse whitespace
  body = body.replace(/\t/g, ' ').replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  return title ? `# ${title}\n\n${body}` : body;
}

function strip(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
