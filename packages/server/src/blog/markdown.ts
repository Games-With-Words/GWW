/**
 * A markdown subset, rendered without a dependency.
 *
 * The blog's body arrives as text written by a language model, and it is served
 * as HTML to crawlers. That makes this file a SANITIZER first and a renderer
 * second: every character of input is escaped before any markup is added back,
 * so the only tags in the output are the ones this file produces. A model that
 * decides to emit `<script>` gets `&lt;script&gt;` and nothing else happens.
 *
 * The supported subset is deliberately tiny — the shapes an article actually
 * needs, and no more. Anything else degrades to a paragraph, which is the right
 * failure: a post that renders plainly still ranks; a post that renders someone
 * else's markup is a security incident.
 */

/** HTML-escape. Runs on EVERYTHING before any tag is introduced. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Inline spans: bold, italic, code, and links.
 *
 * Applied to ALREADY-ESCAPED text, which is why the patterns match `&quot;`-safe
 * characters only. Link targets are restricted to a relative path or an
 * https URL — a `javascript:` href cannot survive that test, and a model has no
 * business linking off-site from our own blog anyway.
 */
function inline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((\/[A-Za-z0-9\-._/#?=]*|https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)\)/g,
      (_m, text: string, href: string) =>
        href.startsWith("/")
          ? `<a href="${href}">${text}</a>`
          : `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`);
}

/** Render the subset to HTML. Block-level, line-driven, no lookahead tricks. */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];

  const flushPara = (): void => {
    if (para.length === 0) return;
    out.push(`<p>${inline(esc(para.join(" ").trim()))}</p>`);
    para = [];
  };
  const flushList = (): void => {
    if (list.length === 0) return;
    out.push(`<ul>${list.map((li) => `<li>${inline(esc(li))}</li>`).join("")}</ul>`);
    list = [];
  };
  const flush = (): void => { flushPara(); flushList(); };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) { flush(); continue; }

    const heading = /^(#{2,4})\s+(.*)$/.exec(line.trim());
    if (heading !== null) {
      flush();
      // H1 is the post title, printed by the page template — a body that tries
      // to own the H1 gets demoted rather than competing with it.
      const level = Math.min(4, heading[1]!.length);
      out.push(`<h${level}>${inline(esc(heading[2]!.trim()))}</h${level}>`);
      continue;
    }

    // A single leading `#` would be an H1: demote to H2 rather than drop it.
    const h1 = /^#\s+(.*)$/.exec(line.trim());
    if (h1 !== null) { flush(); out.push(`<h2>${inline(esc(h1[1]!.trim()))}</h2>`); continue; }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) { flushPara(); list.push(bullet[1]!.trim()); continue; }

    const quote = /^>\s?(.*)$/.exec(line.trim());
    if (quote !== null) { flush(); out.push(`<blockquote>${inline(esc(quote[1]!))}</blockquote>`); continue; }

    if (/^(---+|\*\*\*+)$/.test(line.trim())) { flush(); out.push("<hr />"); continue; }

    // Fences carry no meaning in an article body and their contents are prose.
    if (/^```/.test(line.trim())) { flush(); continue; }

    flushList();
    para.push(line.trim());
  }
  flush();
  return out.join("\n");
}

/** Words in the body, for the reading time and the quality gate. */
export function wordCount(src: string): number {
  return src.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w)).length;
}

/** Plain text, for meta descriptions and duplicate detection. */
export function toPlainText(src: string): string {
  return src
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*`_]/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
