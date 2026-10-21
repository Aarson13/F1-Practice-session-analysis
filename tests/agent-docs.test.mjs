/**
 * Agent-surface tests for F1 Session Analyzer.
 *
 *   node --test tests/agent-docs.test.mjs
 *
 * The router takes `env` as an argument, so a fetch stub exercises the real
 * Markdown negotiation, aliases, clean-URL fallback and 404 contract without
 * Wrangler or the OpenF1 API. The app engine itself is not touched here.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  ABOUT_MARKDOWN,
  CONTACT_MARKDOWN,
  DOCUMENTS,
  HOME_MARKDOWN,
  MARKDOWN_ALIASES,
  PRIVACY_MARKDOWN,
  markdownResponse,
  mergeVary,
  negotiate,
  notFoundMarkdown,
} from "../functions/_agent-docs.js";
import router from "../functions/_router.js";

const ROOT = new URL("../", import.meta.url);

async function read(name) {
  return readFile(new URL(name, ROOT), "utf8");
}

/** Text a crawler sees with scripts, styles and tags removed. */
function visibleText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PAGE = (title) =>
  new Response(`<!doctype html><html lang="en"><body><h1>${title}</h1></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

const env = {
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/" || path === "/index.html") return PAGE("F1 Session Analyzer");
      // Deliberately 404 on the clean URL so the router's .html fallback runs.
      if (path === "/about.html") return PAGE("About");
      if (path === "/contact") return PAGE("Contact");
      if (path === "/privacy.html") return PAGE("Privacy");
      return new Response("<!doctype html><h1>Not found</h1>", {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  },
};

const call = (path, accept, method = "GET") =>
  router.fetch(
    new Request(`https://f1-practice-session-analysis.pages.dev${path}`, {
      method,
      headers: accept ? { Accept: accept } : {},
    }),
    env
  );

test("negotiate: explicit Markdown wins", () => {
  assert.equal(negotiate("text/markdown"), "markdown");
  assert.equal(negotiate("text/markdown, text/html;q=0.9"), "markdown");
  assert.equal(negotiate("text/markdown;q=0.9, text/html;q=0.8"), "markdown");
});

test("negotiate: browsers and wildcards keep HTML", () => {
  assert.equal(negotiate("text/html,application/xhtml+xml,*/*;q=0.8"), "html");
  assert.equal(negotiate("text/html"), "html");
  assert.equal(negotiate("*/*"), "html");
  assert.equal(negotiate(null), "html");
  assert.equal(negotiate(""), "html");
});

test("negotiate: refusing both formats is 406", () => {
  assert.equal(negotiate("application/json"), "not-acceptable");
  assert.equal(negotiate("text/markdown;q=0"), "not-acceptable");
  assert.equal(negotiate("text/markdown;q=0, text/html;q=0"), "not-acceptable");
});

test("negotiate: Markdown with HTML refused is still Markdown", () => {
  assert.equal(negotiate("text/markdown, text/html;q=0"), "markdown");
});

test("documents are substantial and start with one H1", () => {
  for (const [name, body] of Object.entries({
    home: HOME_MARKDOWN,
    about: ABOUT_MARKDOWN,
    contact: CONTACT_MARKDOWN,
    privacy: PRIVACY_MARKDOWN,
  })) {
    assert.ok(body.trim().length > 500, `${name} Markdown is too short`);
    const headings = body.split("\n").filter((line) => /^#{1,6} /.test(line));
    assert.equal(headings.filter((line) => line.startsWith("# ")).length, 1, name);
    assert.ok(headings[0].startsWith("# "), `${name} must start at H1`);
  }
});

test("home Markdown explains the jobs and the calling convention", () => {
  for (const phrase of ["F1 Session Analyzer", "Head-to-Head", "Race Pace", "OpenF1"]) {
    assert.match(HOME_MARKDOWN, new RegExp(phrase, "i"));
  }
  assert.match(HOME_MARKDOWN, /## When to use this/);
  assert.match(HOME_MARKDOWN, /Accept: text\/markdown/);
  assert.match(HOME_MARKDOWN, /#y=2024&m=/);
});

test("404 Markdown explains the miss and links the way back", () => {
  const body = notFoundMarkdown("/__ora-404-probe-zkl33o7j");
  assert.ok(body.length > 20);
  assert.match(body, /__ora-404-probe-zkl33o7j/);
  assert.match(body, /sitemap\.xml/);
  assert.match(body, /llms\.txt/);
});

test("router: homepage negotiates Markdown with Vary", async () => {
  const response = await call("/", "text/markdown");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(response.headers.get("Vary"), "Accept");
  assert.match(await response.text(), /^# F1 Session Analyzer/);
});

test("router: homepage still serves HTML with Link alternates", async () => {
  const response = await call("/", "text/html,application/xhtml+xml,*/*;q=0.8");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /^text\/html/);
  assert.match(response.headers.get("Vary"), /Accept/);
  assert.match(response.headers.get("Link"), /rel="alternate"/);
  assert.match(await response.text(), /<h1>/);
});

test("router: clean trust URLs fall back to their .html assets", async () => {
  const response = await call("/about", "text/html");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Link"), /\/about\.md/);
  assert.match(await response.text(), /About/);
});

test("router: .md aliases always answer Markdown", async () => {
  for (const [path, body] of MARKDOWN_ALIASES) {
    const response = await call(path, "text/html");
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8", path);
    assert.match(await response.text(), new RegExp(`^# ${body.split("\n")[0].slice(2)}`), path);
  }
});

test("router: a missing path is a Markdown 404 when requested", async () => {
  const response = await call("/__ora-404-probe-zkl33o7j", "text/markdown");
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(response.headers.get("Vary"), "Accept");
  const body = await response.text();
  assert.match(body, /__ora-404-probe-zkl33o7j/);
  assert.match(body, /llms\.txt/);
});

test("router: the same missing path keeps the HTML 404", async () => {
  const response = await call("/__ora-404-probe-zkl33o7j", "text/html");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("Content-Type"), /^text\/html/);
  assert.match(response.headers.get("Vary"), /Accept/);
});

test("router: 406 when neither format is acceptable", async () => {
  const response = await call("/", "application/json");
  assert.equal(response.status, 406);
  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
});

test("router: HEAD has no body but keeps the contract", async () => {
  const response = await call("/about.md", null, "HEAD");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(await response.text(), "");
});

test("markdownResponse: HEAD body is empty; mergeVary is append-only", () => {
  assert.equal(markdownResponse("# Hi", 200, "HEAD").headers.get("Vary"), "Accept");
  const headers = new Headers({ Vary: "Accept-Encoding" });
  mergeVary(headers);
  assert.equal(headers.get("Vary"), "Accept-Encoding, Accept");
  mergeVary(headers);
  assert.equal(headers.get("Vary"), "Accept-Encoding, Accept");
});

test("homepage has meaningful content without JavaScript", async () => {
  const html = await read("public/index.html");
  assert.match(html, /<html lang="en"/);
  const text = visibleText(html);
  assert.ok(text.length > 500, `homepage has only ${text.length} chars`);
  assert.match(text, /F1 Session Analyzer/);
  assert.match(text, /Turn-by-turn/);
  assert.match(html, /<h1>F1 Session <em>Analyzer<\/em><\/h1>/);
});

test("homepage metadata and JSON-LD are complete", async () => {
  const html = await read("public/index.html");
  assert.match(html, /<link rel="canonical" href="https:\/\/f1-practice-session-analysis\.pages\.dev\/"/);
  assert.match(html, /<meta property="og:type" content="website"/);
  assert.match(html, /<meta property="og:image" content="https:\/\/f1-practice-session-analysis\.pages\.dev\/og-image\.png"/);
  assert.match(html, /<link rel="alternate" type="text\/markdown" href="\/index\.md"/);

  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1);
  const graph = JSON.parse(blocks[0][1])["@graph"];
  const organization = graph.find((node) => node["@type"] === "Organization");
  const app = graph.find((node) => node["@type"] === "SoftwareApplication");
  const site = graph.find((node) => node["@type"] === "WebSite");
  assert.ok(organization);
  assert.ok(app);
  assert.ok(site);
  assert.equal(organization.contactPoint["@type"], "ContactPoint");
  assert.ok(organization.contactPoint.email);
  assert.equal(organization.address["@type"], "PostalAddress");
  assert.ok(organization.address.addressLocality);
  assert.equal(app.offers.price, "0");
  assert.ok(app.featureList.length >= 3);
});

test("trust pages are real pages with canonical metadata", async () => {
  for (const [file, needles] of [
    ["public/about.html", ["About F1 Session Analyzer", "Where the data comes from", "What it is not"]],
    ["public/contact.html", ["Contact and corrections", "What makes a report actionable", "soni.soni.parth@gmail.com"]],
    ["public/privacy.html", ["Privacy notice", "OpenF1", "Local state and sharing"]],
  ]) {
    const html = await read(file);
    const text = visibleText(html);
    assert.ok(text.length > 500, `${file} has only ${text.length} chars`);
    assert.match(html, /<html lang="en"/);
    assert.match(html, /<link rel="canonical"/);
    for (const needle of needles) assert.match(text, new RegExp(needle));
  }
});

test("sitemap, robots and llms.txt point at the published pages", async () => {
  const sitemap = await read("public/sitemap.xml");
  for (const path of ["/", "/about", "/contact", "/privacy"]) {
    assert.match(sitemap, new RegExp(`<loc>https://f1-practice-session-analysis\\.pages\\.dev${path}</loc>`));
  }
  assert.match(await read("public/robots.txt"), /Sitemap: https:\/\/f1-practice-session-analysis\.pages\.dev\/sitemap\.xml/);
  const llms = await read("public/llms.txt");
  assert.match(llms, /## When to use this/);
  assert.match(llms, /Accept: text\/markdown/);
});

test("every negotiated document maps to an alias and an HTML file", () => {
  for (const [path, doc] of DOCUMENTS) {
    assert.ok(doc.markdown.length > 500, path);
    assert.ok(doc.alternate.endsWith(".md"), path);
    assert.ok(MARKDOWN_ALIASES.has(doc.alternate), path);
    assert.ok(doc.file.endsWith(".html"), path);
  }
});
