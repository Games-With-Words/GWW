/**
 * The blog's pages, rendered on the SERVER.
 *
 * This is the whole SEO argument in one file. The arcade is a single-page app,
 * and an SPA can be indexed — but it is indexed on the crawler's terms, after a
 * render pass it may or may not spend on a new domain. An article has one job:
 * be the answer to a question somebody typed. So each post is a complete HTML
 * document with its own title, description, canonical, OG card and Article
 * JSON-LD, and the prose is IN THE RESPONSE BODY. No hydration, no fetch, no
 * framework — `curl` sees exactly what Google sees, which is the only version of
 * this that is testable.
 *
 * Styling is inlined for the same reason: an article that renders unstyled while
 * a stylesheet round-trips looks broken on a phone, and the CSS is 2KB.
 */

import { renderMarkdown, esc } from "./markdown.js";
import { readingMinutes, type Post } from "./store.js";

export const SITE = "https://games-with-words.com";
export const BLOG_TITLE = "The Games With Words Blog";
export const BLOG_DESCRIPTION =
  "Party game writing from the people building Games With Words: how to run a game night on your TV, what makes a word game funny, and the rules worth arguing about.";

/**
 * JSON-LD, safe to place inside a <script> element.
 *
 * JSON.stringify does NOT escape "<", and a `</script>` inside any string field
 * — a post title, a keyword — would close the element early and drop the rest
 * of the JSON into the document as markup. Found by the render test asserting a
 * `<b>` in a title never reaches the page. Escaping the three characters that
 * can start an element or a comment is the standard fix and keeps the JSON valid.
 */
export function ldJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/** ISO date, the only format a crawler and a human both read without ambiguity. */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** "25 August 2026" — a date a person reads, in the byline. */
function human(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * The shared shell.
 *
 * Every page gets the same head discipline: one canonical, one description, one
 * OG image, and the fonts the arcade already serves. `jsonLd` is a string rather
 * than an object so each page can express its own @graph without this function
 * needing to know what a BlogPosting is.
 */
function page(opts: {
  title: string;
  description: string;
  canonical: string;
  jsonLd: string;
  body: string;
  ogType?: string;
  publishedTime?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}" />
<link rel="canonical" href="${esc(opts.canonical)}" />
<meta property="og:type" content="${esc(opts.ogType ?? "website")}" />
<meta property="og:title" content="${esc(opts.title)}" />
<meta property="og:description" content="${esc(opts.description)}" />
<meta property="og:url" content="${esc(opts.canonical)}" />
<meta property="og:image" content="${SITE}/og.jpg" />
<meta property="og:site_name" content="Games With Words" />
${opts.publishedTime !== undefined ? `<meta property="article:published_time" content="${esc(opts.publishedTime)}" />` : ""}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(opts.title)}" />
<meta name="twitter:description" content="${esc(opts.description)}" />
<meta name="twitter:image" content="${SITE}/og.jpg" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="alternate" type="application/rss+xml" title="${esc(BLOG_TITLE)}" href="${SITE}/feed.xml" />
<script type="application/ld+json">${opts.jsonLd}</script>
<style>
@font-face{font-family:"Archivo";src:url("/fonts/archivo-var.woff2") format("woff2-variations");font-weight:100 900;font-display:swap}
@font-face{font-family:"Martian Mono";src:url("/fonts/martianmono-var.woff2") format("woff2-variations");font-weight:100 800;font-display:swap}
:root{--bg:#0b0b0b;--card:#181818;--ink:#fff;--dim:#b3b3b3;--accent:#e50914;--hot:#ff4b55;--line:#2a2a2a}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink)}
body{font-family:"Archivo",system-ui,sans-serif;font-size:18px;line-height:1.65;-webkit-font-smoothing:antialiased}
a{color:var(--hot)}
.wrap{max-width:720px;margin:0 auto;padding:28px 22px 96px}
header.site{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:34px}
header.site a.brand{font-weight:900;letter-spacing:-.02em;text-transform:uppercase;color:var(--ink);text-decoration:none;font-size:20px}
header.site .nav{margin-left:auto;display:flex;gap:18px;font-size:15px}
header.site .nav a{color:var(--dim);text-decoration:none}
header.site .nav a:hover{color:var(--ink)}
h1{font-size:clamp(30px,6vw,46px);line-height:1.08;font-weight:900;letter-spacing:-.03em;margin:0 0 14px;text-wrap:balance}
h2{font-size:clamp(22px,3.6vw,28px);line-height:1.2;font-weight:800;letter-spacing:-.02em;margin:44px 0 12px;text-wrap:balance}
h3{font-size:20px;font-weight:700;margin:30px 0 8px}
p{margin:0 0 20px}
ul{margin:0 0 22px;padding-left:22px}
li{margin:0 0 8px}
blockquote{margin:0 0 22px;padding:2px 0 2px 18px;border-left:3px solid var(--accent);color:var(--dim)}
code{font-family:"Martian Mono",ui-monospace,monospace;font-size:.86em;background:#ffffff12;padding:1px 5px;border-radius:5px}
hr{border:0;border-top:1px solid var(--line);margin:36px 0}
.byline{font-family:"Martian Mono",ui-monospace,monospace;font-size:12.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin:0 0 34px}
.lede{font-size:21px;color:var(--dim);margin:0 0 34px;text-wrap:pretty}
.postlist{list-style:none;margin:0;padding:0}
.postlist li{border-bottom:1px solid var(--line);padding:22px 0;margin:0}
.postlist h2{margin:0 0 6px;font-size:23px}
.postlist a{color:var(--ink);text-decoration:none}
.postlist a:hover{color:var(--hot)}
.postlist p{color:var(--dim);margin:0 0 6px;font-size:16.5px}
.postlist .meta{font-family:"Martian Mono",ui-monospace,monospace;font-size:11.5px;color:#8a8a8a;text-transform:uppercase;letter-spacing:.06em}
.cta{display:block;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:14px;padding:22px;margin:44px 0 0;text-decoration:none;color:var(--ink)}
.cta b{display:block;font-size:20px;font-weight:900;letter-spacing:-.01em;margin-bottom:4px}
.cta span{color:var(--dim);font-size:16px}
footer.site{border-top:1px solid var(--line);margin-top:56px;padding-top:20px;color:#8a8a8a;font-size:14.5px}
footer.site a{color:var(--dim)}
.empty{color:var(--dim)}
</style>
</head>
<body>
<div class="wrap">
<header class="site">
  <a class="brand" href="/">Games&nbsp;With&nbsp;Words</a>
  <nav class="nav"><a href="/">Play</a><a href="/blog">Blog</a></nav>
</header>
${opts.body}
<footer class="site">
  <p>Games With Words is a free party game you play in one room, on your TV, with the phones already in everyone's pockets. No app, no accounts.
  <a href="/">Start a game</a> · <a href="/blog">More writing</a> · <a href="/feed.xml">RSS</a></p>
</footer>
</div>
</body>
</html>`;
}

/**
 * The internal link every post earns.
 *
 * A blog that never links to the product is a blog that ranks for nothing that
 * matters. One link, in the same place on every post, pointing at the thing the
 * article is about.
 */
const CTA = `<a class="cta" href="/"><b>Play Games With Words →</b><span>Open it on the TV, everyone joins with a code. Free, no app, no accounts.</span></a>`;

/** The blog index: every published post, newest first. */
export function renderIndex(posts: Post[]): string {
  const jsonLd = ldJson({
    "@context": "https://schema.org",
    "@type": "Blog",
    "@id": `${SITE}/blog#blog`,
    name: BLOG_TITLE,
    description: BLOG_DESCRIPTION,
    url: `${SITE}/blog`,
    publisher: { "@type": "Organization", name: "Games With Words", url: SITE },
    blogPost: posts.slice(0, 20).map((p) => ({
      "@type": "BlogPosting",
      headline: p.title,
      url: `${SITE}/blog/${p.slug}`,
      datePublished: iso(p.publishedAt ?? p.createdAt),
    })),
  });

  const list = posts.length === 0
    ? `<p class="empty">No posts yet. The first one is being written.</p>`
    : `<ul class="postlist">${posts.map((p) => `<li>
        <h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2>
        <p>${esc(p.description)}</p>
        <div class="meta"><time datetime="${iso(p.publishedAt ?? p.createdAt)}">${human(p.publishedAt ?? p.createdAt)}</time> · ${readingMinutes(p.body)} min read</div>
      </li>`).join("")}</ul>`;

  return page({
    title: `${BLOG_TITLE} — party games, word games, game night`,
    description: BLOG_DESCRIPTION,
    canonical: `${SITE}/blog`,
    jsonLd,
    body: `<h1>The Blog</h1>
<p class="lede">${esc(BLOG_DESCRIPTION)}</p>
${list}
${CTA}`,
  });
}

/**
 * A single post.
 *
 * `BlogPosting` inside a `@graph` with `BreadcrumbList`: the breadcrumb is what
 * earns the "Games With Words › Blog" trail in a result, and the trail is a
 * brand impression whether or not anyone clicks.
 */
export function renderPost(post: Post, related: Post[]): string {
  const url = `${SITE}/blog/${post.slug}`;
  const published = iso(post.publishedAt ?? post.createdAt);
  const jsonLd = ldJson({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        "@id": `${url}#post`,
        headline: post.title,
        description: post.description,
        url,
        mainEntityOfPage: { "@type": "WebPage", "@id": url },
        datePublished: published,
        dateModified: published,
        wordCount: post.body.split(/\s+/).filter(Boolean).length,
        keywords: post.keywords.join(", "),
        inLanguage: "en",
        image: `${SITE}/og.jpg`,
        author: { "@type": "Organization", name: "Games With Words", url: SITE },
        publisher: {
          "@type": "Organization",
          name: "Games With Words",
          url: SITE,
          logo: { "@type": "ImageObject", url: `${SITE}/icon-512.png` },
        },
        isPartOf: { "@type": "Blog", "@id": `${SITE}/blog#blog`, name: BLOG_TITLE },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Games With Words", item: SITE },
          { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE}/blog` },
          { "@type": "ListItem", position: 3, name: post.title, item: url },
        ],
      },
    ],
  });

  const more = related.length === 0 ? "" : `<hr />
<h2>Keep reading</h2>
<ul class="postlist">${related.map((p) => `<li>
  <h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2>
  <p>${esc(p.description)}</p>
</li>`).join("")}</ul>`;

  return page({
    title: `${post.title} — Games With Words`,
    description: post.description,
    canonical: url,
    ogType: "article",
    publishedTime: published,
    jsonLd,
    body: `<article>
<h1>${esc(post.title)}</h1>
<div class="byline"><time datetime="${published}">${human(post.publishedAt ?? post.createdAt)}</time> · ${readingMinutes(post.body)} min read</div>
<p class="lede">${esc(post.description)}</p>
${renderMarkdown(post.body)}
</article>
${CTA}
${more}`,
  });
}

/**
 * sitemap.xml, generated rather than filed.
 *
 * The static file it replaces listed one URL, honestly, because there was one
 * page. Now the set of URLs changes every few hours, and a sitemap that has to
 * be edited by hand is a sitemap that goes stale the first time nobody
 * remembers to edit it.
 */
export function renderSitemap(posts: Post[]): string {
  const entry = (loc: string, lastmod: string | undefined, freq: string, priority: string): string =>
    `  <url>\n    <loc>${loc}</loc>\n${lastmod !== undefined ? `    <lastmod>${lastmod}</lastmod>\n` : ""}    <changefreq>${freq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;

  const newest = posts[0]?.publishedAt;
  const urls = [
    entry(`${SITE}/`, undefined, "weekly", "1.0"),
    entry(`${SITE}/blog`, newest !== undefined ? iso(newest).slice(0, 10) : undefined, "daily", "0.8"),
    ...posts.map((p) => entry(`${SITE}/blog/${p.slug}`, iso(p.publishedAt ?? p.createdAt).slice(0, 10), "monthly", "0.6")),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;
}

/** RSS. Cheap to serve, and the only way a human subscribes to anything. */
export function renderFeed(posts: Post[]): string {
  const items = posts.slice(0, 30).map((p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${SITE}/blog/${esc(p.slug)}</link>
      <guid isPermaLink="true">${SITE}/blog/${esc(p.slug)}</guid>
      <pubDate>${new Date(p.publishedAt ?? p.createdAt).toUTCString()}</pubDate>
      <description>${esc(p.description)}</description>
    </item>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(BLOG_TITLE)}</title>
    <link>${SITE}/blog</link>
    <atom:link href="${SITE}/feed.xml" rel="self" type="application/rss+xml" />
    <description>${esc(BLOG_DESCRIPTION)}</description>
    <language>en</language>
    <lastBuildDate>${new Date(posts[0]?.publishedAt ?? Date.now()).toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

/** A 404 that is still a page, not a JSON blob, when the path looked like a post. */
export function renderMissing(): string {
  return page({
    title: "Not found — Games With Words",
    description: "That post does not exist.",
    canonical: `${SITE}/blog`,
    jsonLd: ldJson({ "@context": "https://schema.org", "@type": "WebPage", name: "Not found" }),
    body: `<h1>Nothing here</h1><p class="lede">That post does not exist — it may have been renamed.</p><p><a href="/blog">Back to the blog</a></p>`,
  });
}
