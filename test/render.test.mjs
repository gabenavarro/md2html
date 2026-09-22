import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { render } from "../lib/render.mjs";

const dir = mkdtempSync(join(tmpdir(), "md2html-test-"));

function writeReport(name, content) {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

test("frontmatter -> title/meta chips/date", async () => {
  const p = writeReport("fm.md", `---
title: T
description: D
date: 2026-01-02
meta:
  project: p
---
# T

## A

## B

## C
`);
  const r = await render(p);
  assert.equal(r.meta.title, "T");
  assert.equal(r.meta.date, "2026-01-02");
  assert.ok(r.html.includes("project"), "meta chip rendered");
  assert.ok(r.html.includes("2026-01-02"), "date in footer");
});

test("TOC built from 3+ headings, slugs match", async () => {
  const p = writeReport("toc.md", `# T\n\n## Alpha Section\n\n## Beta\n\n## Gamma\n`);
  const r = await render(p);
  assert.equal(r.toc.length, 3);
  assert.ok(r.toc[0].slug === "alpha-section", "slug generated: " + r.toc[0].slug);
  assert.ok(r.html.includes(`href="#alpha-section"`), "toc anchor present");
});

test("TOC ignores headings inside fenced code blocks", async () => {
  const p = writeReport("toc-fence.md", `# T

## Alpha

\`\`\`bash
## not a real heading
### also fake
\`\`\`

## Beta

~~~
## tilde-fenced fake
~~~

## Gamma
`);
  const r = await render(p);
  assert.deepEqual(r.toc.map((t) => t.text), ["Alpha", "Beta", "Gamma"]);
  assert.ok(!r.html.includes("not-a-real-heading"), "no dead link from bash fence");
  assert.ok(!r.html.includes("tilde-fenced-fake"), "no dead link from tilde fence");
});

test("TOC anchors resolve: every href has a matching heading id", async () => {
  const p = writeReport("toc-anchors.md", `# T

## TL;DR

## TL;DR

## Results
`);
  const r = await render(p);
  const ids = new Set([...r.html.matchAll(/<h[23] id="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...r.html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 3, "TOC rendered");
  const dead = refs.filter((ref) => !ids.has(ref));
  assert.deepEqual(dead, [], "no dead TOC links (duplicate headings dedupe identically)");
});

test("TOC handles longer outer fences (4-backtick wrapping 3-backtick)", async () => {
  const p = writeReport("toc-longfence.md", `# T

## Real A

\`\`\`\`markdown
\`\`\`python
## fake inside
\`\`\`
\`\`\`\`

## Real B

## Real C
`);
  const r = await render(p);
  assert.deepEqual(r.toc.map((t) => t.text), ["Real A", "Real B", "Real C"]);
});

test("Shiki: dual-theme pre, language class, no language-mermaid leak", async () => {
  const p = writeReport("code.md", `# T\n\n## A\n\n## B\n\n## C\n\n\`\`\`python\nx = 1\n\`\`\`\n`);
  const r = await render(p);
  assert.ok(r.html.includes('class="shiki'), "shiki pre rendered");
  assert.ok(r.html.includes("--shiki-dark"), "dark vars present");
  assert.ok(r.html.includes("--shiki-light"), "light vars present");
  assert.ok(!r.html.includes("language-mermaid"), "mermaid not highlighted");
});

test("unregistered fence language -> plaintext fallback, no crash", async () => {
  const p = writeReport("make.md", `# T\n\n## A\n\n## B\n\n## C\n\n\`\`\`make\nall: build\n\techo hi\n\`\`\`\n`);
  const r = await render(p);
  assert.ok(r.html.includes('class="shiki'), "make fence highlighted via Shiki");
  assert.ok(r.html.includes("all: build"), "make source present");
});

test("Mermaid block -> data-src div, not highlighted code", async () => {
  const p = writeReport("mm.md", `# T\n\n## A\n\n## B\n\n## C\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n`);
  const r = await render(p);
  assert.ok(r.html.includes('class="diagram mermaid"'), "mermaid div");
  assert.ok(r.html.includes("data-src="), "data-src present");
  assert.ok(!/<pre[^>]*>flowchart/.test(r.html), "mermaid source not left as <pre>");
});
test("Mermaid v12 contract: template seeds innerHTML from data-src before run()", async () => {
  const { JSDOM } = await import("jsdom");
  const p = writeReport("mm-seed.md", `# T\n\n## A\n\n## B\n\n## C\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n`);
  const r = await render(p);
  // Stub mermaid: record what run() observes — exactly as v12 does,
  // reading innerHTML then entity-decoding it.
  const stub = `<script>window.mermaid = {
    initialize: function () {},
    run: function (q) {
      window.__ran = Array.from(document.querySelectorAll(q.querySelector)).map(function (e) {
        return e.innerHTML.trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
      });
      return Promise.resolve();
    },
    parse: function () { return Promise.resolve(); },
  };</script>`;
  const html = r.html.replace(
    /<script id="md2html-mermaid-bundle">[\s\S]*?<\/script>/,
    stub,
  );
  const dom = new JSDOM(html, { runScripts: "dangerously" });
  await new Promise((res) => setTimeout(res, 100));
  const seen = dom.window.__ran;
  assert.ok(Array.isArray(seen) && seen.length === 1, "run() saw one diagram element");
  assert.equal(
    seen[0],
    "flowchart LR\n  A --> B",
    "source present in innerHTML at run() time (v12 reads innerHTML, not data-src)",
  );
});
test("Mermaid gate: broken block fails the render with the parser error", async () => {
  const p = writeReport("mm-bad.md", `# T\n\n## A\n\n## B\n\n## C\n\n\`\`\`mermaid\nflowchart LR\n  A -->\n\`\`\`\n`);
  await assert.rejects(
    () => render(p),
    (e) => /mermaid block 1 fails to parse/.test(e.message) && /A -->/.test(e.message),
    "gate rejects with line-precise detail",
  );
});

test("Mermaid gate: --no-check bypass ships anyway", async () => {
  const p = writeReport("mm-bad2.md", `# T\n\n## A\n\n## B\n\n## C\n\n\`\`\`mermaid\nflowchart LR\n  A -->\n\`\`\`\n`);
  const r = await render(p, { noCheck: true });
  assert.ok(r.html.includes('class="diagram mermaid"'), "diagram div still emitted");
});

test("GFM alert -> .alert.alert-note with bold label", async () => {
  const p = writeReport("al.md", `# T\n\n## A\n\n## B\n\n## C\n\n> [!NOTE]\n> hello\n`);
  const r = await render(p);
  assert.ok(r.html.includes('class="alert alert-note"'), "alert note");
  assert.ok(r.html.includes("<strong>Note</strong>"), "bold label");
});

test("KaTeX block math rendered", async () => {
  const p = writeReport("math.md", `# T\n\n## A\n\n## B\n\n## C\n\n$$\n\\int_0^1 x\\,dx\n$$\n`);
  const r = await render(p);
  assert.ok(r.html.includes("katex"), "katex output");
  assert.ok(r.html.includes("data:font/"), "katex fonts inlined");
});

test("GFM table rendered with zebra rows", async () => {
  const p = writeReport("tab.md", `# T\n\n## A\n\n## B\n\n## C\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`);
  const r = await render(p);
  assert.ok(r.html.includes("<table>"), "table");
  assert.ok(r.html.includes("<th>a</th>"), "th");
});

test("XY: extracts source, renders light+dark, iframe srcs present", async () => {
  const p = writeReport("xy.md", `# T\n\n## A\n\n## B\n\n## C\n\n\`\`\`xy\nimport xy\nchart = xy.line_chart(xy.line([1,2,3], [1,4,9]))\n\`\`\`\n`);
  const r = await render(p);
  assert.equal(r.xy.length, 1);
  const { light, dark } = r.xy[0];
  assert.ok(readFileSync(light, "utf8").includes("<html"), "light file");
  assert.ok(readFileSync(dark, "utf8").includes("class=\"dark\""), "dark file flagged");
  assert.ok(r.html.includes('src="' + new URL(light, "http://x").pathname.replace(/^\//, "") + '"') ||
            r.html.includes("xy-iframe"), "iframe present");
  assert.ok(r.html.includes('data-dark="'), "data-dark attr");
  assert.ok(r.html.includes('data-light="'), "data-light attr");
});

test("idempotent: same source -> same hash across renders", async () => {
  const src = `\`\`\`xy\nimport xy\nchart = xy.line_chart(xy.line([1,2], [3,4]))\n\`\`\`\n`;
  const p1 = writeReport("x1.md", `# T\n\n## A\n\n## B\n\n## C\n\n` + src);
  const p2 = writeReport("x2.md", `# T\n\n## A\n\n## B\n\n## C\n\n` + src);
  const r1 = await render(p1);
  const r2 = await render(p2);
  assert.equal(r1.xy[0].name, r2.xy[0].name, "stable hash");
});

test("no XY: no xy-out dir noise in html", async () => {
  const p = writeReport("noxy.md", `# T\n\n## A\n\n## B\n\n## C\n\nplain text\n`);
  const r = await render(p);
  assert.equal(r.xy.length, 0);
  assert.ok(!r.html.includes('<iframe class="xy-iframe"'), "no iframe in body");
});
test("offline/file-safe: no module scripts, mermaid bundle inlined", async () => {
  const p = writeReport("off.md", `# T\n\n## A\n\n## B\n\n## C\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n`);
  const r = await render(p);
  assert.ok(!r.html.includes('<script type="module"'), "no module scripts (breaks on file://)");
  assert.ok(r.html.includes('md2html-mermaid-bundle'), "mermaid bundle inlined");
  assert.ok(r.html.includes("globalThis[\"mermaid\"]"), "bundle assigns global");
  assert.ok(!r.html.includes("cdn.jsdelivr.net"), "zero external references");
});

test("Images: local inlined as data URI, remote untouched, missing kept", async () => {
  // minimal valid 1x1 PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  writeFileSync(join(dir, "dot.png"), png);
  const p = writeReport("img.md", `# T\n\n## A\n\n## B\n\n## C\n\n![local](dot.png)\n\n![remote](https://example.com/x.png)\n\n![missing](nope.png)\n`);
  const r = await render(p);
  assert.ok(/src="data:image\/png;base64,/.test(r.html), "local image inlined");
  assert.ok(r.html.includes('src="https://example.com/x.png"'), "remote untouched");
  assert.ok(r.html.includes('src="nope.png"'), "missing image keeps relative ref");
});

test("Forced theme honored over system preference", async () => {
  const { JSDOM } = await import("jsdom");
  const p = writeReport("theme.md", `# T\n\n## A\n\n## B\n\n## C\n\ntext\n`);
  const light = (await render(p, { theme: "light" })).html;
  const auto = (await render(p, { theme: "auto" })).html;
  const mk = (html, stored) => {
    const dom = new JSDOM(html, {
      url: "http://localhost/",
      runScripts: "dangerously",
      beforeParse(window) {
        window.matchMedia = () => ({ matches: true }); // system = dark
        if (stored) window.localStorage.setItem("md2html-theme", stored);
        window.mermaid = { initialize() {}, run: () => Promise.resolve(), parse: () => Promise.resolve() };
      },
    });
    return new Promise((res) => setTimeout(() => res(dom.window.document.documentElement.className), 50));
  };
  assert.equal(await mk(light, null), "light", "forced light beats dark system pref");
  assert.equal(await mk(auto, null), "dark", "auto follows dark system pref");
  assert.equal(await mk(auto, "light"), "light", "stored user choice wins over system");
});

test("XY failure: named chart + traceback tail, not raw command", async () => {
  const p = writeReport("xy-fail.md", `# T\n\n## A\n\n## B\n\n## C\n\n\`\`\`xy\nimport xy\nchart = xy.does_not_exist()\n\`\`\`\n`);
  await assert.rejects(
    () => render(p),
    (e) =>
      /XY chart render failed \(xy-src\/[A-Za-z0-9-]+\.py\)/.test(e.message) &&
      /render_one|does_not_exist|AttributeError/.test(e.message) &&
      !/--manifest/.test(e.message),
    "surfaces chart name + traceback, hides subprocess plumbing",
  );
});

test("no date in frontmatter -> no wall-clock stamp, deterministic output", async () => {
  const p = writeReport("nodate.md", `# T\n\n## A\n\n## B\n\n## C\n\nplain\n`);
  const r1 = await render(p);
  const r2 = await render(p);
  assert.equal(r1.html, r2.html, "identical across renders");
  assert.ok(!/footer-date/.test(r1.html), "no footer date span");
  assert.ok(!/20\d\d-\d\d-\d\d/.test(r1.html), "no date string anywhere");
});

test("frontmatter date still rendered in footer", async () => {
  const p = writeReport("date2.md", `---\ndate: 2026-01-02\n---\n# T\n\n## A\n\n## B\n\n## C\n`);
  const r = await render(p);
  assert.ok(r.html.includes('class="footer-date">2026-01-02'), "explicit date kept");
});

test("CLI: --help exits 0, --version prints version, dir mode skips README.md", () => {
  const bin = join(import.meta.dirname, "..", "bin", "md2html.mjs");
  const help = execFileSync("node", [bin, "--help"], { encoding: "utf8" });
  assert.ok(help.includes("Usage:"), "help text");
  const ver = execFileSync("node", [bin, "--version"], { encoding: "utf8" });
  assert.match(ver.trim(), /^md2html \d+\.\d+\.\d+$/, "version line");
  const d = mkdtempSync(join(tmpdir(), "md2html-dir-"));
  writeFileSync(join(d, "README.md"), "# R\n\n## A\n\n## B\n\n## C\n");
  writeFileSync(join(d, "report.md"), "# R\n\n## A\n\n## B\n\n## C\n");
  const out = execFileSync("node", [bin, d], { encoding: "utf8" });
  assert.ok(out.includes("report.md"), "report rendered");
  assert.ok(!out.includes("README.md"), "README skipped");
  assert.ok(!existsSync(join(d, "README.html")), "no README.html");
  assert.ok(existsSync(join(d, "report.html")), "report.html exists");
  rmSync(d, { recursive: true, force: true });
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
