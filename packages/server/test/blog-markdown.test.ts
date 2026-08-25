/**
 * The markdown subset — and mostly, the escaping.
 *
 * This renderer's input is written by a language model and its output is served
 * as HTML on our own domain. That makes injection the failure that matters, so
 * that is what most of this file is about.
 */

import { describe, expect, it } from "vitest";
import { renderMarkdown, esc, wordCount, toPlainText } from "../src/blog/markdown.js";

describe("escaping", () => {
  it("neutralizes a script tag rather than rendering it", () => {
    const html = renderMarkdown(`A paragraph.\n\n<script>alert(1)</script>`);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes attributes an author could use to break out of a tag", () => {
    expect(esc(`" onload="x`)).toBe("&quot; onload=&quot;x");
    expect(esc("a & b")).toBe("a &amp; b");
  });

  it("refuses a javascript: link — no anchor is made at all", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    // The text survives as inert prose, which is fine and is what a reader
    // sees; what must NOT exist is an anchor or an href carrying that scheme.
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
  });

  it("allows a relative link and an https link, and marks the outbound one", () => {
    expect(renderMarkdown("[play](/)")).toContain('<a href="/">play</a>');
    const out = renderMarkdown("[docs](https://example.com/x)");
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });
});

describe("blocks", () => {
  it("renders headings, paragraphs, bullets and quotes", () => {
    const html = renderMarkdown(`## Heading\n\nA line\nand its continuation.\n\n- one\n- two\n\n> quoted`);
    expect(html).toContain("<h2>Heading</h2>");
    expect(html).toContain("<p>A line and its continuation.</p>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<blockquote>quoted</blockquote>");
  });

  it("demotes an H1 — the page template owns the title", () => {
    expect(renderMarkdown("# Body title")).toBe("<h2>Body title</h2>");
  });

  it("renders inline emphasis and code", () => {
    const html = renderMarkdown("A **bold** and *italic* and `code` line here.");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
  });

  it("produces no stray tags for an empty body", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("\n\n  \n")).toBe("");
  });

  it("closes every tag it opens", () => {
    const html = renderMarkdown(`## A\n\ntext\n\n- x\n\n> q\n\n### B\n\nmore`);
    for (const tag of ["h2", "h3", "p", "ul", "li", "blockquote"]) {
      const open = (html.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;
      const close = (html.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
      expect(open, `<${tag}> balance`).toBe(close);
    }
  });
});

describe("measuring", () => {
  it("counts words, ignoring punctuation-only tokens", () => {
    expect(wordCount("one two three — four")).toBe(4);
  });

  it("flattens markdown to plain text for descriptions", () => {
    expect(toPlainText("## Title\n\nA **bold** [link](/x) here.")).toBe("Title A bold link here.");
  });
});
