import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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

test("Shiki: dual-theme pre, language class, no language-mermaid leak", async () => {
  const p = writeReport("code.md", `# T\n\n## A\n\n## B\n\n## C\n\n\`\`\`python\nx = 1\n\`\`\`\n`);
  const r = await render(p);
  assert.ok(r.html.includes('class="shiki'), "shiki pre rendered");
  assert.ok(r.html.includes("--shiki-dark"), "dark vars present");
  assert.ok(r.html.includes("--shiki-light"), "light vars present");
  assert.ok(!r.html.includes("language-mermaid"), "mermaid not highlighted");
});

test("Mermaid block -> data-src div, not highlighted code", async () => {
  const p = writeReport("mm.md", `# T\n\n## A\n\n## B\n\n## C\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n`);
  const r = await render(p);
  assert.ok(r.html.includes('class="diagram mermaid"'), "mermaid div");
  assert.ok(r.html.includes("data-src="), "data-src present");
  assert.ok(!/<pre[^>]*>flowchart/.test(r.html), "mermaid source not left as <pre>");
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

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
