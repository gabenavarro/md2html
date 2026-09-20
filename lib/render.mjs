/**
 * md2html core renderer.
 * Markdown in -> self-contained report out (HTML + optional XY siblings).
 *
 * Features:
 *  - YAML frontmatter (title, description, theme, toc, date, author, meta)
 *  - GFM tables, strikethrough, task lists, alerts
 *  - Shiki syntax highlighting with light/dark CSS-variable output
 *  - KaTeX math (block + inline), fonts inlined as data: URIs
 *  - Mermaid diagrams (CDN, theme-aware re-render on toggle)
 *  - XY charts: source extracted to xy-src/, rendered via scripts/xy-export.py
 *    into light+dark standalone HTML in xy-out/; iframe src swaps on toggle
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import GitHubSlugger from "github-slugger";

import { template } from "./template.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KATEX_DIR = join(__dirname, "..", "node_modules", "katex");

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline every KaTeX font referenced by the stylesheet as a data: URI. */
function katexCssInline() {
  let css = readFileSync(join(KATEX_DIR, "dist", "katex.min.css"), "utf8");
  const fontDir = join(KATEX_DIR, "dist", "fonts");
  const files = readdirSync(fontDir);
  for (const f of files) {
    const data = Buffer.from(readFileSync(join(fontDir, f))).toString("base64");
    const mime = f.endsWith(".woff2") ? "font/woff2" : f.endsWith(".woff") ? "font/woff" : "font/ttf";
    css = css.replace(new RegExp(`(url\\()[^)]*${f}\\)`, "g"), `$1data:${mime};base64,${data})`);
  }
  return css;
}

/**
 * Shiki highlighter as a rehype plugin. Replaces each <pre><code> with the
 * Shiki output, which carries --shiki-light/--shiki-dark CSS variables so a
 * single stylesheet can switch themes.
 */
let _shikiPromise;
async function getShiki() {
  if (!_shikiPromise) {
    const { createHighlighter } = await import("shiki");
    _shikiPromise = createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: [
        "js", "ts", "jsx", "tsx", "python", "bash", "json", "jsonc", "yaml",
        "toml", "html", "css", "md", "sql", "diff", "rust", "go", "java", "c",
        "cpp", "ruby", "php", "swift", "kotlin", "r", "dockerfile", "ini",
        "plaintext", "text",
      ],
    });
  }
  return _shikiPromise;
}

async function shikiPlugin() {
  const highlighter = await getShiki();
  return (processor) => (tree) => {
    for (let i = 0; i < tree.children.length; i++) {
      const node = tree.children[i];
      if (node.type !== "element" || node.tagName !== "pre" || node.children.length !== 1) continue;
      const code = node.children[0];
      if (code.type !== "element" || code.tagName !== "code") continue;
      const cls = (code.properties?.className || []).join(" ");
      const m = cls.match(/language-(\w+)/);
      const lang = m ? m[1] : "text";
      if (lang === "mermaid") continue; // rendered later by the mermaid runtime
      if (!highlighter.getLoadedLanguages().includes(lang)) lang = "plaintext";
      const raw = code.children.map((c) => (c.value ?? "")).join("");
      const hast = highlighter.codeToHast(raw, {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
      });
      if (hast) tree.children[i] = hast;
    }
  };
}


/** Stable short hash of chart source so renders of the same code share files. */
function hashCode(code) {
  let h = 5381;
  for (let i = 0; i < code.length; i++) h = ((h << 5) + h + code.charCodeAt(i)) >>> 0;
  return "xy-" + h.toString(16);
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
/**
 * Build-time Mermaid syntax gate. Parses every ```mermaid block with
 * mermaid.parse (under a minimal jsdom DOM) and fails the render with the
 * parser's own line-precise error instead of shipping a report that shows
 * a syntax-error bomb.
 */
let _mermaidCtx;
async function validateMermaidBlocks(body) {
  const blocks = [...body.matchAll(/```mermaid\n([\s\S]*?)```/g)];
  if (blocks.length === 0) return;
  if (!_mermaidCtx) {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "http://localhost/" });
    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    _mermaidCtx = (await import("mermaid")).default;
  }
  for (let i = 0; i < blocks.length; i++) {
    const src = blocks[i][1];
    try {
      await _mermaidCtx.parse(src);
    } catch (e) {
      const detail = String(e.message || e).split("\n").find((l) => l.trim());
      throw new Error(`mermaid block ${i + 1} fails to parse: ${detail}\n  block source:\n${src.split("\n").map((l) => "    " + l).join("\n")}`);
    }
  }
}


export async function render(input, opts = {}) {
  const mdPath = input;
  const md = readFileSync(mdPath, "utf8");
  const fm = matter(md);
  const meta = {
    title: fm.data.title ?? "Report",
    description: fm.data.description ?? "",
    theme: fm.data.theme ?? opts.theme ?? "auto",
    toc: fm.data.toc !== false && fm.data.toc !== "false",
    date: fm.data.date ?? "",
    author: fm.data.author ?? "",
    ...fm.data.meta,
  };
  const body = fm.content;

  // ---- TOC ---------------------------------------------------------------
  if (meta.date instanceof Date) meta.date = meta.date.toISOString().slice(0, 10);
  const slugger = new GitHubSlugger();
  const toc = [];
  const headingRe = /^(#{2,3})\s+(.+)$/;
  for (const line of body.split("\n")) {
    const m = line.match(headingRe);
    if (m) toc.push({ depth: m[1].length, text: m[2].trim(), slug: slugger.slug(m[2].trim()) });
  }
  const showToc = meta.toc && toc.length >= 3;
  const tocHtml = showToc
    ? toc.map((t) => `<a class="toc-${t.depth}" href="#${t.slug}">${esc(t.text)}</a>`).join("\n")
    : "";

  // ---- XY chart extraction (before markdown pass) ------------------------
  const outDir = opts.outPath ? dirname(opts.outPath) : dirname(mdPath);
  const xyDir = opts.xyDir ?? join(outDir, "xy-out");
  const xySrcDir = opts.xySrcDir ?? join(outDir, "xy-src");
  const xyEntries = []; // { name, light, dark }
  mkdirSync(xySrcDir, { recursive: true });
  mkdirSync(xyDir, { recursive: true });

  const extractXy = (body) =>
    body.replace(/```xy\n([\s\S]*?)```/g, (_, src) => {
      const name = hashCode(src.trim());
      const py = join(xySrcDir, name + ".py");
      const light = join(xyDir, name + ".html");
      const dark = join(xyDir, name + ".dark.html");
      writeFileSync(py, src);
      xyEntries.push({ name, light, dark });
      return " ```xy:" + name + "``` ";
    });
  if (!opts.noCheck) await validateMermaidBlocks(body);


  const mdWithXy = extractXy(body);

  // ---- Markdown -> HTML body ---------------------------------------------
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeKatex, { output: "html" })
    .use(await shikiPlugin())
    .use(rehypeStringify, { allowDangerousHtml: true });

  let htmlBody = (await processor.process(mdWithXy)).toString();

  // ---- Post-process: mermaid + xy placeholders ----------------------------
  htmlBody = htmlBody.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_, code) => `<div class="diagram mermaid" data-src="${esc(decodeEntities(code))}"></div>`,
  );
  // GFM alerts: > [!NOTE] / [!WARNING] / [!TIP] / [!IMPORTANT] / [!CAVEAT]
  const ALERTS = {
    note: "Note", warning: "Warning", tip: "Tip",
    important: "Important", caveat: "Caveat",
  };
  for (const [key, label] of Object.entries(ALERTS)) {
    htmlBody = htmlBody.replace(
      new RegExp(
        `<blockquote>\\s*<p>\\[!${key.toUpperCase()}\\](\\s*)`,
      ),
      (_m, ws) =>
        `<blockquote class="alert alert-${key}"><p><strong>${label}</strong>${ws}`,
    );
  }
  htmlBody = htmlBody.replace(/<p><code>xy:(xy-[0-9a-f]+)<\/code><\/p>/g, (_m, name) => {
    const entry = xyEntries.find((e) => e.name === name);
    if (!entry) return "";
    const rel = (p) => encodeURI(relative(outDir, p).split("\\").join("/"));
    return `<div class="xy-frame" data-light="${rel(entry.light)}" data-dark="${rel(entry.dark)}">
  <iframe class="xy-iframe" src="${rel(entry.light)}" title="XY chart: ${esc(name)}" loading="lazy"></iframe>
  <a class="xy-export" href="${rel(entry.light)}" target="_blank" title="Open standalone interactive chart">open</a>
</div>`;
  });

  // ---- Render XY charts (light + dark standalone HTML) --------------------
  if (xyEntries.length > 0) {
    const script = join(__dirname, "..", "scripts", "xy-export.py");
    const python = opts.python ?? findPython();
    const manifest = [
      ...xyEntries.map((e) => ({ py: join(xySrcDir, e.name + ".py"), out: e.light, theme: "light" })),
      ...xyEntries.map((e) => ({ py: join(xySrcDir, e.name + ".py"), out: e.dark, theme: "dark" })),
    ];
    execFileSync(python, [script, "--manifest", JSON.stringify(manifest)], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  }
  const SKIP = new Set(["title", "description", "theme", "toc", "date"]);
  const metaLines = Object.entries(meta)
    .filter(([k, v]) => !SKIP.has(k) && v !== "" && v !== undefined)
    .map(([k, v]) => `<span class="meta-${esc(k)}">${esc(String(v))}</span>`)
    .join("");
  const date = meta.date || new Date().toISOString().slice(0, 10);
  let mermaidInline = "";
  const mermaidBundle = join(__dirname, "..", "node_modules", "mermaid", "dist", "mermaid.min.js");
  if (existsSync(mermaidBundle)) mermaidInline = readFileSync(mermaidBundle, "utf8");

  const doc = template({
    title: meta.title,
    description: meta.description,
    theme: meta.theme,
    tocHtml,
    bodyHtml: htmlBody,
    metaHtml: metaLines,
    date,
    katexCss: katexCssInline(),
    css: opts.css ?? readFileSync(join(__dirname, "..", "assets", "report.css"), "utf8"),
    mermaidInline,
  });

  const outPath = opts.outPath ?? mdPath.replace(/\.md$/, "") + ".html";
  if (opts.write !== false) writeFileSync(outPath, doc);

  return {
    html: doc,
    meta,
    toc,
    xy: xyEntries,
    srcPath: mdPath,
    outPath,
  };
}

function findPython() {
  const venv = join(__dirname, "..", ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return "python3";
}

export { decodeEntities };
