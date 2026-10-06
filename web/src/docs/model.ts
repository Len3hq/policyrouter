// The docs site's content model. The pages are the GitBook-format markdown files in /docs (a
// SUMMARY.md plus pages), rendered here, so the same files can also be published to GitBook.
//
// Everything in this file is pure: it takes the files as an argument, so tests can feed it fixtures
// or the real docs.

import { marked } from "marked";

export interface NavPage {
  title: string;
  /** Path relative to /docs, e.g. "guide/quickstart.md" */
  path: string;
  /** URL path segment after /docs, "" for the home page */
  slug: string;
}
export interface NavGroup {
  title?: string;
  pages: NavPage[];
}
export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}
export interface RenderedPage {
  html: string;
  title: string;
  toc: TocItem[];
  /** Plain text, for search */
  text: string;
}
export interface SearchHit {
  page: NavPage;
  /** Page title matched */
  inTitle: boolean;
  snippet: string;
  score: number;
}

export const GITHUB_BLOB = "https://github.com/Len3hq/policyrouter/blob/main/";

/** "guide/quickstart.md" → "guide/quickstart"; "README.md" → ""; "guide/README.md" → "guide". */
export function slugOf(path: string): string {
  const noExt = path.replace(/\.md$/i, "");
  if (noExt === "README") return "";
  return noExt.replace(/\/README$/, "");
}

/** GitBook's SUMMARY.md: `## Group` headings, then `* [Title](file.md)` lines (nesting is flattened). */
export function parseSummary(text: string): NavGroup[] {
  const groups: NavGroup[] = [{ pages: [] }];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const heading = /^#{2,}\s+(.+)$/.exec(line);
    if (heading) {
      groups.push({ title: heading[1]!.trim(), pages: [] });
      continue;
    }
    const item = /^\s*[*-]\s+\[([^\]]+)\]\(([^)\s]+)\)/.exec(line);
    if (item) {
      const path = item[2]!;
      groups[groups.length - 1]!.pages.push({ title: item[1]!, path, slug: slugOf(path) });
    }
  }
  return groups.filter((g) => g.pages.length > 0);
}

export const flatten = (groups: NavGroup[]): NavPage[] => groups.flatMap((g) => g.pages);

/** GitHub-style heading ids: lowercase, punctuation dropped, spaces to hyphens. */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Resolves `href` as written in the page at `fromPath` against the docs folder. Returns a docs-relative path, or undefined if it leaves /docs. */
export function resolveRelative(fromPath: string, href: string): { path: string; outside: boolean } {
  const parts = fromPath.split("/").slice(0, -1);
  let outside = false;
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) outside = true;
      else parts.pop();
    } else parts.push(seg);
  }
  return { path: parts.join("/"), outside };
}

export interface LinkTarget {
  href: string;
  external: boolean;
  /** Set when the link points at a docs page that doesn't exist */
  broken?: boolean;
}

/** Where a link written in markdown on page `fromPath` should go on the site. */
export function rewriteLink(fromPath: string, href: string, known: ReadonlySet<string>): LinkTarget {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return { href, external: true };
  if (href.startsWith("#")) return { href, external: false };
  if (href.startsWith("/")) return { href, external: false }; // site route, e.g. /verify or /docs/guide/quickstart

  const [pathPart, hash] = splitHash(href);
  const { path, outside } = resolveRelative(fromPath, pathPart);
  if (outside) {
    // outside /docs: a file in the repository
    const repoPath = repoPathFrom(fromPath, pathPart);
    return { href: GITHUB_BLOB + repoPath + (hash ? `#${hash}` : ""), external: true };
  }
  if (/\.md$/i.test(path)) {
    if (!known.has(path)) return { href: `/docs/${slugOf(path)}`, external: false, broken: true };
    const slug = slugOf(path);
    return { href: `/docs${slug ? `/${slug}` : ""}${hash ? `#${hash}` : ""}`, external: false };
  }
  // a non-markdown file inside /docs
  return { href: `${GITHUB_BLOB}docs/${path}${hash ? `#${hash}` : ""}`, external: true };
}

function splitHash(href: string): [string, string | undefined] {
  const i = href.indexOf("#");
  return i < 0 ? [href, undefined] : [href.slice(0, i), href.slice(i + 1)];
}

/** `../contracts/src/X.sol` written in docs/foo.md → "contracts/src/X.sol" (repo root relative). */
function repoPathFrom(fromPath: string, href: string): string {
  const parts = ["docs", ...fromPath.split("/").slice(0, -1)];
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** Markdown → HTML for one page, with heading ids, rewritten links, wrapped tables and a table of contents. */
export function renderPage(path: string, markdown: string, known: ReadonlySet<string>): RenderedPage {
  const raw = marked.parse(markdown, { async: false, gfm: true }) as string;
  const doc = new DOMParser().parseFromString(`<body>${raw}</body>`, "text/html");
  const used = new Map<string, number>();
  const toc: TocItem[] = [];
  let title = "";

  for (const h of Array.from(doc.querySelectorAll("h1,h2,h3,h4"))) {
    const text = h.textContent ?? "";
    const base = headingId(text) || "section";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const id = n === 0 ? base : `${base}-${n}`;
    h.id = id;
    if (h.tagName === "H1" && !title) title = text;
    if (h.tagName === "H2" || h.tagName === "H3") toc.push({ id, text, level: h.tagName === "H2" ? 2 : 3 });
  }

  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const t = rewriteLink(path, a.getAttribute("href")!, known);
    a.setAttribute("href", t.href);
    if (t.external) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noreferrer");
    }
    if (t.broken) a.setAttribute("data-broken", "true");
  }

  for (const table of Array.from(doc.querySelectorAll("table"))) {
    const wrap = doc.createElement("div");
    wrap.className = "table-wrap";
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }

  for (const pre of Array.from(doc.querySelectorAll("pre > code"))) {
    const lang = /language-([\w-]+)/.exec(pre.className)?.[1];
    if (lang) pre.parentElement!.setAttribute("data-lang", lang);
  }

  return { html: doc.body.innerHTML, title, toc, text: (doc.body.textContent ?? "").replace(/\s+/g, " ").trim() };
}

export interface DocsSite {
  groups: NavGroup[];
  pages: NavPage[];
  known: ReadonlySet<string>;
  render(slug: string): (RenderedPage & { page: NavPage; prev?: NavPage; next?: NavPage }) | undefined;
  search(query: string, limit?: number): SearchHit[];
}

/** Builds the site from `files`, a map of docs-relative path → markdown (must include SUMMARY.md). */
export function buildSite(files: Record<string, string>): DocsSite {
  const groups = parseSummary(files["SUMMARY.md"] ?? "");
  const pages = flatten(groups);
  const known = new Set(Object.keys(files));
  const cache = new Map<string, RenderedPage>();
  const rendered = (p: NavPage) => {
    let r = cache.get(p.path);
    if (!r) {
      r = renderPage(p.path, files[p.path] ?? "", known);
      cache.set(p.path, r);
    }
    return r;
  };

  return {
    groups,
    pages,
    known,
    render(slug) {
      const i = pages.findIndex((p) => p.slug === slug);
      if (i < 0 || files[pages[i]!.path] === undefined) return undefined;
      return { ...rendered(pages[i]!), page: pages[i]!, prev: pages[i - 1], next: pages[i + 1] };
    },
    search(query, limit = 8) {
      const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      if (terms.length === 0) return [];
      const hits: SearchHit[] = [];
      for (const page of pages) {
        const r = rendered(page);
        const title = `${page.title} ${r.title}`.toLowerCase();
        const text = r.text.toLowerCase();
        if (!terms.every((t) => title.includes(t) || text.includes(t))) continue;
        const inTitle = terms.every((t) => title.includes(t));
        const count = terms.reduce((n, t) => n + (text.split(t).length - 1), 0);
        const at = text.indexOf(terms[0]!);
        const start = Math.max(0, at - 50);
        const snippet = `${start > 0 ? "…" : ""}${r.text.slice(start, start + 140).trim()}${start + 140 < r.text.length ? "…" : ""}`;
        hits.push({ page, inTitle, snippet, score: (inTitle ? 1000 : 0) + count });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },
  };
}
