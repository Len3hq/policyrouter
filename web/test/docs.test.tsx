import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildSite, headingId, parseSummary, resolveRelative, rewriteLink, slugOf } from "../src/docs/model.ts";
import { docsFiles, site } from "../src/docs/content.ts";
import { DocsPage } from "../src/components/DocsPage.tsx";

const fixture = {
  "SUMMARY.md": "# Summary\n\n* [Intro](README.md)\n\n## Guide\n\n* [One](guide/one.md)\n  * [Nested](guide/nested.md)\n* [Two](two.md)\n",
  "README.md": "# Intro\n\nHello [one](guide/one.md#second-part) and [repo](../contracts/src/X.sol) and [web](https://example.com) and [verify](/verify).\n",
  "guide/one.md": "# One\n\n## First part\n\ntext about **gates**\n\n## Second part\n\n### Detail\n\n```bash\nls -la\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n## Second part\n",
  "guide/nested.md": "# Nested\n\n[up](../two.md) [missing](nope.md)\n",
  "two.md": "# Two\n\nthe kill switch stops requests\n",
};

describe("model", () => {
  it("parses GitBook's SUMMARY.md: groups, titles, paths, nesting flattened", () => {
    const groups = parseSummary(fixture["SUMMARY.md"]);
    expect(groups.map((g) => g.title)).toEqual([undefined, "Guide"]);
    expect(groups[1]!.pages.map((p) => [p.title, p.slug])).toEqual([["One", "guide/one"], ["Nested", "guide/nested"], ["Two", "two"]]);
    expect(groups[0]!.pages[0]).toMatchObject({ path: "README.md", slug: "" });
  });

  it("maps files to slugs", () => {
    expect(slugOf("README.md")).toBe("");
    expect(slugOf("guide/quickstart.md")).toBe("guide/quickstart");
    expect(slugOf("guide/README.md")).toBe("guide");
  });

  it("makes GitHub-style heading ids", () => {
    expect(headingId("What is in a receipt")).toBe("what-is-in-a-receipt");
    expect(headingId("Immutability, precisely")).toBe("immutability-precisely");
    expect(headingId("Claude Code")).toBe("claude-code");
    expect(headingId("The cap is enforced at settlement")).toBe("the-cap-is-enforced-at-settlement");
  });

  it("resolves relative links and rewrites them for the site", () => {
    const known = new Set(Object.keys(fixture));
    expect(resolveRelative("guide/one.md", "../two.md")).toEqual({ path: "two.md", outside: false });
    expect(resolveRelative("two.md", "../x")).toEqual({ path: "x", outside: true });
    expect(rewriteLink("README.md", "guide/one.md#second-part", known)).toEqual({ href: "/docs/guide/one#second-part", external: false });
    expect(rewriteLink("guide/nested.md", "../two.md", known).href).toBe("/docs/two");
    expect(rewriteLink("README.md", "README.md", known).href).toBe("/docs");
    expect(rewriteLink("README.md", "https://example.com", known)).toMatchObject({ external: true });
    expect(rewriteLink("README.md", "/verify", known)).toEqual({ href: "/verify", external: false });
    expect(rewriteLink("guide/nested.md", "nope.md", known).broken).toBe(true);
    // a file in the repository outside /docs goes to GitHub
    expect(rewriteLink("two.md", "../contracts/src/X.sol", known)).toEqual({
      href: "https://github.com/Len3hq/policyrouter/blob/main/contracts/src/X.sol",
      external: true,
    });
    expect(rewriteLink("guide/one.md", "../../packages/policy/README.md", known).href).toBe(
      "https://github.com/Len3hq/policyrouter/blob/main/packages/policy/README.md",
    );
  });

  it("renders a page: heading ids (duplicates numbered), toc, tables, code language, links", () => {
    const s = buildSite(fixture);
    const p = s.render("guide/one")!;
    expect(p.title).toBe("One");
    expect(p.toc).toEqual([
      { id: "first-part", text: "First part", level: 2 },
      { id: "second-part", text: "Second part", level: 2 },
      { id: "detail", text: "Detail", level: 3 },
      { id: "second-part-1", text: "Second part", level: 2 },
    ]);
    expect(p.html).toContain('class="table-wrap"');
    expect(p.html).toContain('data-lang="bash"');
    expect(p.prev?.title).toBe("Intro");
    expect(p.next?.title).toBe("Nested");

    const home = s.render("")!;
    expect(home.html).toContain('href="/docs/guide/one#second-part"');
    expect(home.html).toMatch(/href="https:\/\/github.com\/Len3hq\/policyrouter\/blob\/main\/contracts\/src\/X.sol"[^>]*target="_blank"/);
    expect(home.html).toContain('href="/verify"');
    expect(s.render("nope")).toBeUndefined();
  });

  it("searches titles and text, ranking title matches first", () => {
    const s = buildSite(fixture);
    expect(s.search("kill switch")[0]!.page.title).toBe("Two");
    expect(s.search("two")[0]!.inTitle).toBe(true);
    expect(s.search("gates")[0]!.snippet).toContain("gates");
    expect(s.search("zzzzz")).toEqual([]);
    expect(s.search("a")).toEqual([]); // single letters are ignored
  });
});

// --- the real docs ---

function mdFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? mdFiles(p) : p.endsWith(".md") ? [relative(join(__dirname, "../../docs"), p)] : [];
  });
}

describe("the real docs", () => {
  it("every markdown file in /docs is in the navigation, and every navigation entry exists", () => {
    const onDisk = mdFiles(join(__dirname, "../../docs")).filter((f) => f !== "SUMMARY.md").sort();
    const inSummary = site.pages.map((p) => p.path).sort();
    expect(inSummary).toEqual(onDisk);
  });

  it("every code fence is closed, so no section is swallowed into a code block", () => {
    for (const [path, text] of Object.entries(docsFiles)) {
      const fences = text.split("\n").filter((l) => /^\s*```/.test(l));
      expect(fences.length % 2, path).toBe(0);
      // a closing fence is bare: text after ``` means it opens a new block
      fences.forEach((f, i) => {
        if (i % 2 === 1) expect(f.trim(), `${path}: closing fence`).toBe("```");
      });
    }
  });

  it("every page has exactly one h1 and a title", () => {
    for (const p of site.pages) {
      const r = site.render(p.slug)!;
      expect(r.title, p.path).not.toBe("");
      expect((r.html.match(/<h1 /g) ?? []).length, p.path).toBe(1);
    }
  });

  it("has no broken internal links or anchors", () => {
    const problems: string[] = [];
    for (const p of site.pages) {
      const html = site.render(p.slug)!.html;
      const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
      for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
        const href = a.getAttribute("href")!;
        if (a.hasAttribute("data-broken")) problems.push(`${p.path}: link to a missing page: ${href}`);
        if (!href.startsWith("/docs") && !href.startsWith("#")) continue;
        const [path, hash] = href.split("#");
        const target = path ? site.render(path.replace(/^\/docs\/?/, "")) : site.render(p.slug);
        if (!target) {
          problems.push(`${p.path}: ${href} has no page`);
          continue;
        }
        if (hash && !target.toc.some((t) => t.id === hash) && !target.html.includes(`id="${hash}"`)) {
          problems.push(`${p.path}: ${href} has no heading "${hash}"`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("searches the real docs", () => {
    expect(site.search("kill switch").length).toBeGreaterThan(2);
    expect(site.search("rotate key").map((h) => h.page.slug)).toContain("guide/owner-app");
    expect(site.search("claude code")[0]!.page.title).toBeTruthy();
  });

  it("states addresses that match the deployment record", () => {
    const text = Object.values(docsFiles).join("\n");
    for (const a of ["0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99", "0x7F05d6c389F973EA3Fb10A3Eb27e338f8eB42D0a", "0xCc2dd59C8042e42253D1C14d5c34F976226b7F7A"]) {
      expect(text).toContain(a);
    }
  });
});

describe("DocsPage", () => {
  function open(path: string) {
    history.replaceState(null, "", path);
    return render(<DocsPage />);
  }

  it("shows the introduction at /docs with the grouped navigation", () => {
    open("/docs");
    expect(screen.getByRole("heading", { level: 1, name: "PolicyRouter" })).toBeInTheDocument();
    const nav = within(screen.getByRole("complementary", { name: "Documentation" }));
    expect(nav.getByRole("link", { name: "Quickstart" })).toHaveAttribute("href", "/docs/guide/quickstart");
    expect(nav.getByText("Getting started")).toBeInTheDocument();
    expect(nav.getByRole("link", { name: "Introduction" })).toHaveAttribute("aria-current", "page");
  });

  it("navigates without a reload, updates the URL, and offers previous and next", async () => {
    open("/docs");
    await userEvent.click(within(screen.getByRole("complementary", { name: "Documentation" })).getByRole("link", { name: "Quickstart" }));
    expect(location.pathname).toBe("/docs/guide/quickstart");
    expect(screen.getByRole("heading", { level: 1, name: "Quickstart" })).toBeInTheDocument();
    expect(screen.getByTestId("docs-prev")).toHaveTextContent("Introduction");
    expect(screen.getByTestId("docs-next")).toHaveTextContent("The owner app");
    expect(document.title).toBe("Quickstart · PolicyRouter docs");
    await userEvent.click(screen.getByTestId("docs-next"));
    expect(screen.getByRole("heading", { level: 1, name: "The owner app" })).toBeInTheDocument();
  });

  it("searches and opens a result", async () => {
    open("/docs");
    await userEvent.type(screen.getByTestId("docs-search"), "rotate key");
    const results = screen.getByTestId("docs-results");
    expect(results).toHaveTextContent("The owner app");
    const ownerApp = Array.from(results.querySelectorAll("a")).find((a) => a.getAttribute("href") === "/docs/guide/owner-app")!;
    await userEvent.click(ownerApp);
    expect(location.pathname).toBe("/docs/guide/owner-app");
    expect(screen.queryByTestId("docs-results")).not.toBeInTheDocument();
  });

  it("says so for a page that doesn't exist", () => {
    open("/docs/nope");
    expect(screen.getByTestId("docs-notfound")).toHaveTextContent("Page not found");
  });

  it("adds copy buttons to code blocks", () => {
    open("/docs/guide/quickstart");
    expect(document.querySelectorAll(".docs-article pre .copy-code").length).toBeGreaterThan(3);
  });
});
