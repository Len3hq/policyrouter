import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { site } from "../docs/content.ts";
import type { DocsSite } from "../docs/model.ts";

const docsPath = (slug: string) => `/docs${slug ? `/${slug}` : ""}`;
const slugFromLocation = () => decodeURIComponent(location.pathname.replace(/^\/docs\/?/, "").replace(/\/$/, ""));

/** GitBook-style documentation: sidebar, search, article, "on this page", previous and next. */
export function DocsPage({ source = site }: { source?: DocsSite }) {
  const [slug, setSlug] = useState(slugFromLocation);
  const [hash, setHash] = useState(() => location.hash.slice(1));
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState(false);
  const articleRef = useRef<HTMLElement>(null);

  const page = useMemo(() => source.render(slug), [source, slug]);
  const hits = useMemo(() => (query.trim() ? source.search(query) : []), [source, query]);

  useEffect(() => {
    const onPop = () => {
      setSlug(slugFromLocation());
      setHash(location.hash.slice(1));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((href: string) => {
    const url = new URL(href, location.origin);
    history.pushState(null, "", url.pathname + url.search + url.hash);
    setSlug(slugFromLocation());
    setHash(url.hash.slice(1));
    setMenu(false);
    setQuery("");
  }, []);

  // keep the document title and scroll position right after navigating
  useEffect(() => {
    document.title = page ? `${page.page.title} · PolicyRouter docs` : "Not found · PolicyRouter docs";
    if (hash) document.getElementById(hash)?.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [slug, hash, page]);

  // copy buttons on code blocks
  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    for (const pre of Array.from(root.querySelectorAll("pre"))) {
      if (pre.querySelector(".copy-code")) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "copy-code";
      b.textContent = "Copy";
      b.addEventListener("click", async () => {
        await navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? pre.textContent ?? "");
        b.textContent = "Copied";
        setTimeout(() => (b.textContent = "Copy"), 1500);
      });
      pre.appendChild(b);
    }
  }, [page]);

  // in-site links navigate without a reload
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const href = a.getAttribute("href");
    if (href && href.startsWith("/docs") && !a.target) {
      e.preventDefault();
      go(href);
    }
  };

  return (
    <div className="docs" onClick={onClick}>
      <button type="button" className="btn btn-ghost btn-sm docs-menu-btn" onClick={() => setMenu((m) => !m)} aria-expanded={menu} data-testid="docs-menu">
        {menu ? "Close menu" : "Menu"}
      </button>

      <aside className={`docs-nav ${menu ? "docs-nav-open" : ""}`} aria-label="Documentation">
        <input
          type="search"
          className="docs-search"
          placeholder="Search the docs"
          aria-label="Search the docs"
          data-testid="docs-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query.trim() ? (
          <ul className="docs-results" data-testid="docs-results">
            {hits.length === 0 && <li className="muted small">No results for “{query}”.</li>}
            {hits.map((h) => (
              <li key={h.page.path}>
                <a href={docsPath(h.page.slug)}>
                  <strong>{h.page.title}</strong>
                  <span className="muted small">{h.snippet}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          source.groups.map((g, i) => (
            <div key={g.title ?? i} className="docs-group">
              {g.title && <h4>{g.title}</h4>}
              <ul>
                {g.pages.map((p) => (
                  <li key={p.path}>
                    <a href={docsPath(p.slug)} className={p.slug === slug ? "docs-link-on" : ""} aria-current={p.slug === slug ? "page" : undefined}>
                      {p.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        <div className="docs-group">
          <h4>Tools</h4>
          <ul>
            <li>
              <a href="/verify">Verify a receipt</a>
            </li>
            <li>
              <a href="/app">Owner app</a>
            </li>
          </ul>
        </div>
      </aside>

      {page ? (
        <>
          <article className="docs-article" ref={articleRef} data-testid="docs-article" data-slug={slug}>
            <div dangerouslySetInnerHTML={{ __html: page.html }} />
            <nav className="docs-pager" aria-label="Previous and next">
              {page.prev ? (
                <a href={docsPath(page.prev.slug)} data-testid="docs-prev">
                  <span className="muted small">Previous</span>
                  {page.prev.title}
                </a>
              ) : (
                <span />
              )}
              {page.next && (
                <a href={docsPath(page.next.slug)} className="docs-next" data-testid="docs-next">
                  <span className="muted small">Next</span>
                  {page.next.title}
                </a>
              )}
            </nav>
            <p className="muted small docs-edit">
              <a href={`https://github.com/Len3hq/policyrouter/blob/main/docs/${page.page.path}`} target="_blank" rel="noreferrer">
                Edit this page on GitHub
              </a>
            </p>
          </article>
          <aside className="docs-toc" aria-label="On this page">
            {page.toc.length > 0 && (
              <>
                <h4>On this page</h4>
                <ul>
                  {page.toc.map((t) => (
                    <li key={t.id} className={t.level === 3 ? "toc-sub" : ""}>
                      <a href={`${docsPath(slug)}#${t.id}`}>{t.text}</a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        </>
      ) : (
        <article className="docs-article" data-testid="docs-notfound">
          <h1>Page not found</h1>
          <p>
            There's no page at <code>/docs/{slug}</code>. Try the <a href="/docs">introduction</a> or search the docs.
          </p>
        </article>
      )}
    </div>
  );
}
